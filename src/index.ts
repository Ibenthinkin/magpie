import { makePacer } from './browser/pacing';
import { closeContext, getContext } from './browser/session';
import { loadConfig } from './config';
import { getDb } from './db/client';
import { makeHuntsRepo } from './db/hunts';
import { makeListingsRepo } from './db/listings';
import { makeWatchesRepo } from './db/watches';
import {
  adviseCommandData,
  handleAdviseButton,
  handleAdviseCommand,
  realAdvisePort,
} from './discord/commands/advise';
import { handleHuntCommand, huntCommandData } from './discord/commands/hunt';
import { adviseTurn } from './engine/advisor';
import { startGateway } from './discord/gateway';
import { makeHub } from './discord/hub';
import { makeDiscordReporter } from './discord/report';
import { runHunt } from './engine/hunt';
import { parseTarget } from './engine/target';
import { log, logError } from './log';
import { resolveAdapters } from './sources/registry';
import { startWorker } from './watch/worker';

// Composition root: the one long-lived Bun process hosting the Discord
// gateway, the hunt worker, and (Phase 2) the watch scheduler. SPEC §2.1.
// Wiring only — every piece here is constructed from tested parts.

async function main(): Promise<void> {
  const config = loadConfig();

  // DB up + boot recovery: orphaned `running` hunts go back to `pending`.
  const db = getDb(config.dbPath);
  const hunts = makeHuntsRepo(db);
  const listings = makeListingsRepo(db);
  const watches = makeWatchesRepo(db);
  const stale = hunts.resetStaleRunning();
  if (stale > 0) log('boot.resetStaleRunning', { count: stale });

  const hub = makeHub({ name: 'Magpie', channelId: config.discordChannelId, allowedUserIds: config.allowedUserIds });
  if (hub.allowlistEmpty) {
    log('boot.allowlistEmpty', { warning: 'DISCORD_ALLOWED_USER_IDS is empty — ALL interactions will be denied' });
  }

  const gateway = await startGateway({
    token: config.discordToken,
    guildId: config.discordGuildId,
    hub,
    commands: [
      { data: huntCommandData, execute: (i) => handleHuntCommand(i, { parseTarget, hunts }) },
      { data: adviseCommandData, execute: (i) => handleAdviseCommand(realAdvisePort(i), { adviseTurn, hunts }) },
    ],
    buttons: [
      {
        prefix: 'advise:',
        execute: (i) =>
          handleAdviseButton(
            { customId: i.customId, channelId: i.channelId, reply: (content) => i.reply(content) },
            { hunts },
          ),
      },
    ],
  });

  const reporter = makeDiscordReporter(gateway.send);
  const pace = makePacer();
  const worker = startWorker({
    hunts,
    runHunt: (hunt) =>
      runHunt(hunt, {
        adapters: resolveAdapters,
        getPage: async () => (await getContext()).newPage(),
        hunts,
        listings,
        watches,
        reporter,
        pace,
      }),
  });
  log('boot.ready', { db: config.dbPath, headless: config.headless });

  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    log('shutdown.begin', { signal });
    try {
      await worker.stop(); // waits for any in-flight hunt
      await gateway.stop();
      await closeContext();
    } catch (err) {
      logError('shutdown', err);
    }
    log('shutdown.done');
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

main().catch((err) => {
  logError('boot.failed', err);
  process.exit(1);
});
