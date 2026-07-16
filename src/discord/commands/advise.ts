import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  SlashCommandBuilder,
  type ChatInputCommandInteraction,
  type EmbedBuilder,
} from 'discord.js';
import type { HuntsRepo } from '../../db/types';
import type { adviseTurn as AdviseTurnFn, AdvisorExchange } from '../../engine/advisor';
import { withUsage } from '../../engine/llm';
import type { TargetSpec } from '../../engine/target';
import { log, logError } from '../../log';
import { buildCandidateEmbed } from '../embeds';

// /advise (SPEC §3.2): open a thread, run a bounded clarifying Q&A, end with
// 2–4 candidate cards whose Hunt/Watch buttons carry the concretized
// TargetSpec — no re-typing. Sessions live in memory keyed by thread id; a
// restart expires open button sets (personal scale — rerun /advise).

export const adviseCommandData = new SlashCommandBuilder()
  .setName('advise')
  .setDescription('Turn a fuzzy need into concrete product picks')
  .addStringOption((o) => o.setName('need').setDescription('What you need, in plain words').setRequired(true));

const MAX_QUESTION_ROUNDS = 3;
const REPLY_TIMEOUT_MS = 10 * 60_000;
const SESSION_CAP = 100;

export interface AdvisorSession {
  query: string;
  names: string[];
  targets: TargetSpec[];
  /** Advisor LLM spend; billed onto the first hunt enqueued from this session. */
  costCents: number;
}

// Module-level default store; tests inject their own map.
const defaultSessions = new Map<string, AdvisorSession>();

// --- ports (real adapters at the bottom; tests use plain fakes) -------------

export interface AdviseThreadPort {
  id: string;
  post(content: string): Promise<unknown>;
  postCandidate(embed: EmbedBuilder, buttons: ActionRowBuilder<ButtonBuilder>): Promise<unknown>;
  /** Next message from the invoking user, or null on timeout. */
  awaitUserReply(timeoutMs: number): Promise<string | null>;
}

export interface AdviseInteractionPort {
  options: { getString(name: 'need'): string | null };
  deferReply(): Promise<unknown>;
  editReply(content: string): Promise<unknown>;
  startThread(name: string): Promise<AdviseThreadPort>;
}

export interface AdviseButtonPort {
  customId: string;
  channelId: string;
  reply(content: string): Promise<unknown>;
}

export interface AdviseDeps {
  adviseTurn: typeof AdviseTurnFn;
  hunts: Pick<HuntsRepo, 'enqueueHunt'>;
  sessions?: Map<string, AdvisorSession>;
  maxQuestionRounds?: number;
  replyTimeoutMs?: number;
}

function candidateButtons(threadId: string, index: number): ActionRowBuilder<ButtonBuilder> {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId(`advise:hunt:${threadId}:${index}`).setLabel('Hunt this').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId(`advise:watch:${threadId}:${index}`).setLabel('Watch this').setStyle(ButtonStyle.Secondary),
  );
}

export async function handleAdviseCommand(interaction: AdviseInteractionPort, deps: AdviseDeps): Promise<void> {
  const sessions = deps.sessions ?? defaultSessions;
  const maxRounds = deps.maxQuestionRounds ?? MAX_QUESTION_ROUNDS;
  const timeoutMs = deps.replyTimeoutMs ?? REPLY_TIMEOUT_MS;

  await interaction.deferReply();
  const need = interaction.options.getString('need') ?? '';
  await interaction.editReply(`Advising on **${need}** — follow along in the thread.`);
  const thread = await interaction.startThread(`advise: ${need}`.slice(0, 100));

  const exchanges: AdvisorExchange[] = [];
  let costCents = 0;
  const turnWithCost = (force: boolean) =>
    withUsage(async (usage) => {
      try {
        return await deps.adviseTurn(need, exchanges, { force });
      } finally {
        costCents += usage().costCents;
      }
    });

  try {
    let rounds = 0;
    let turn = await turnWithCost(false);
    while (turn.kind === 'questions') {
      await thread.post(turn.questions.map((q) => `• ${q}`).join('\n'));
      exchanges.push({ from: 'agent', text: turn.questions.join('\n') });
      const reply = await thread.awaitUserReply(timeoutMs);
      if (reply === null) {
        await thread.post("No reply — I'll go with what I have.");
        turn = await turnWithCost(true);
        break;
      }
      exchanges.push({ from: 'user', text: reply });
      rounds++;
      turn = await turnWithCost(rounds >= maxRounds);
    }
    if (turn.kind !== 'candidates') throw new Error('advisor ended without candidates');

    const session: AdvisorSession = { query: need, names: [], targets: [], costCents };
    for (const [index, c] of turn.candidates.entries()) {
      session.names.push(c.name);
      session.targets.push(c.target);
      await thread.postCandidate(buildCandidateEmbed(c, index), candidateButtons(thread.id, index));
    }
    sessions.set(thread.id, session);
    if (sessions.size > SESSION_CAP) {
      const oldest = sessions.keys().next().value;
      if (oldest !== undefined) sessions.delete(oldest);
    }
    log('advise.done', { thread: thread.id, candidates: session.names.length, costCents });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logError('advise.failed', err, { need });
    await thread.post(`Advisor failed: ${msg}`).catch(() => {});
  }
}

export async function handleAdviseButton(
  interaction: AdviseButtonPort,
  deps: { hunts: Pick<HuntsRepo, 'enqueueHunt'>; sessions?: Map<string, AdvisorSession> },
): Promise<void> {
  const sessions = deps.sessions ?? defaultSessions;
  const match = /^advise:(hunt|watch):(.+):(\d+)$/.exec(interaction.customId);
  if (!match) return;
  const [, action, threadId, indexStr] = match;

  const session = sessions.get(threadId!);
  const target = session?.targets[Number(indexStr)];
  const name = session?.names[Number(indexStr)];
  if (!session || !target || !name) {
    await interaction.reply('That advisor session has expired — run /advise again.');
    return;
  }
  if (action === 'watch') {
    await interaction.reply('Watches land in Phase 2 — for now I can **Hunt this** instead.');
    return;
  }

  deps.hunts.enqueueHunt({
    mode: 'oneshot',
    query: name,
    targetJson: JSON.stringify(target),
    channelId: interaction.channelId,
    initialCostCents: session.costCents,
  });
  session.costCents = 0; // advisor spend bills once, on the first hunt
  await interaction.reply(`Hunting **${name}** — results will land here.`);
}

// --- real discord.js adapter -------------------------------------------------

/** Wrap a live interaction into the port. Thread replies come only from the invoking user. */
export function realAdvisePort(i: ChatInputCommandInteraction): AdviseInteractionPort {
  return {
    options: { getString: (name) => i.options.getString(name) },
    deferReply: () => i.deferReply(),
    editReply: (content) => i.editReply(content),
    startThread: async (name) => {
      const message = await i.fetchReply();
      const thread = await message.startThread({ name });
      return {
        id: thread.id,
        post: (content) => thread.send(content),
        postCandidate: (embed, buttons) => thread.send({ embeds: [embed], components: [buttons] }),
        awaitUserReply: async (timeoutMs) => {
          const collected = await thread.awaitMessages({
            filter: (m) => m.author.id === i.user.id,
            max: 1,
            time: timeoutMs,
          });
          return collected.first()?.content ?? null;
        },
      };
    },
  };
}
