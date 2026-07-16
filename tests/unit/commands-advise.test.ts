import { afterEach, describe, expect, it } from 'vitest';
import type { EnqueueHuntInput, HuntRow } from '../../src/db/types';
import { adviseTurn } from '../../src/engine/advisor';
import { setGenerateForTests } from '../../src/engine/llm';
import {
  handleAdviseButton,
  handleAdviseCommand,
  type AdviseInteractionPort,
  type AdviseThreadPort,
  type AdvisorSession,
} from '../../src/discord/commands/advise';

// SPEC §3.2 flow at handler level: thread → clarifying Q&A (bounded rounds,
// reply timeout) → candidate cards with Hunt/Watch buttons carrying the
// concretized TargetSpec (via a session keyed on thread id — no re-typing).
// Advisor LLM spend bills onto the first hunt enqueued from the session.

afterEach(() => setGenerateForTests(null));

const questions = (...qs: string[]) => ({ questions: qs, candidates: [] });
const candidates = (...names: string[]) => ({
  questions: [],
  candidates: names.map((name) => ({
    name,
    pros: ['good'],
    cons: ['meh'],
    target: { description: name, constraints: {} },
  })),
});

/** Sequenced LLM seam: each adviseTurn call consumes the next canned turn; 1¢ each. */
function fakeTurns(turns: unknown[], captured?: { prompts: string[] }) {
  const queue = [...turns];
  setGenerateForTests(({ label, prompt }) => {
    if (label !== 'adviseTurn') throw new Error(`unexpected llm call: ${label}`);
    captured?.prompts.push(prompt);
    const object = queue.shift();
    if (!object) throw new Error('fake turn queue exhausted');
    return { object, usage: { inputTokens: 500, outputTokens: 100 }, costUsd: 0.01 };
  });
}

function makeHarness(replies: (string | null)[] = []) {
  const posts: string[] = [];
  const cards: { title: string; customIds: (string | undefined)[] }[] = [];
  const edits: string[] = [];
  const thread: AdviseThreadPort = {
    id: 'T1',
    post: async (c) => void posts.push(c),
    postCandidate: async (embed, row) =>
      void cards.push({
        title: embed.toJSON().title ?? '',
        customIds: row.toJSON().components.map((c) => ('custom_id' in c ? c.custom_id : undefined)),
      }),
    awaitUserReply: async () => (replies.length > 0 ? replies.shift()! : null),
  };
  const interaction: AdviseInteractionPort = {
    options: { getString: () => 'a good mouse' },
    deferReply: async () => {},
    editReply: async (c: string) => void edits.push(c),
    startThread: async () => thread,
  };
  const enqueued: EnqueueHuntInput[] = [];
  const hunts = {
    enqueueHunt: (input: EnqueueHuntInput) => {
      enqueued.push(input);
      return { id: 'h1' } as HuntRow;
    },
  };
  const sessions = new Map<string, AdvisorSession>();
  return { interaction, thread, posts, cards, edits, enqueued, hunts, sessions };
}

const button = (customId: string) => {
  const replies: string[] = [];
  return {
    replies,
    port: { customId, channelId: 'T1', reply: async (c: string) => void replies.push(c) },
  };
};

describe('handleAdviseCommand', () => {
  it('runs Q&A then posts candidate cards with Hunt/Watch buttons and stores the session', async () => {
    fakeTurns([questions('Budget?'), candidates('MX Master 3S', 'G305')]);
    const h = makeHarness(['under $100']);
    await handleAdviseCommand(h.interaction, { adviseTurn, hunts: h.hunts, sessions: h.sessions });

    expect(h.posts[0]).toContain('Budget?');
    expect(h.cards.map((c) => c.title)).toEqual(['1. MX Master 3S', '2. G305']);
    expect(h.cards[0]!.customIds).toEqual(['advise:hunt:T1:0', 'advise:watch:T1:0']);

    const session = h.sessions.get('T1')!;
    expect(session.targets.map((t) => t.description)).toEqual(['MX Master 3S', 'G305']);
    expect(session.costCents).toBe(2); // two 1¢ turns
  });

  it('a reply timeout is announced and forces final candidates', async () => {
    const captured = { prompts: [] as string[] };
    fakeTurns([questions('Budget?'), candidates('X', 'Y')], captured);
    const h = makeHarness([null]);
    await handleAdviseCommand(h.interaction, { adviseTurn, hunts: h.hunts, sessions: h.sessions });

    expect(h.posts.some((p) => /no reply/i.test(p))).toBe(true);
    expect(captured.prompts[1]).toMatch(/no more questions/i);
    expect(h.sessions.has('T1')).toBe(true);
  });

  it('the round cap forces candidates instead of endless questions', async () => {
    const captured = { prompts: [] as string[] };
    fakeTurns([questions('q1?'), candidates('X', 'Y')], captured);
    const h = makeHarness(['answer 1']);
    await handleAdviseCommand(h.interaction, {
      adviseTurn,
      hunts: h.hunts,
      sessions: h.sessions,
      maxQuestionRounds: 1,
    });
    expect(captured.prompts[1]).toMatch(/no more questions/i);
    expect(h.cards).toHaveLength(2);
  });

  it('an advisor failure is posted to the thread, not swallowed', async () => {
    setGenerateForTests(() => {
      throw new Error('model unavailable');
    });
    const h = makeHarness();
    await handleAdviseCommand(h.interaction, { adviseTurn, hunts: h.hunts, sessions: h.sessions });
    expect(h.posts.some((p) => p.includes('model unavailable'))).toBe(true);
    expect(h.sessions.size).toBe(0);
  });
});

describe('handleAdviseButton', () => {
  async function withSession() {
    fakeTurns([candidates('MX Master 3S', 'G305')]);
    const h = makeHarness();
    await handleAdviseCommand(h.interaction, { adviseTurn, hunts: h.hunts, sessions: h.sessions });
    return h;
  }

  it('Hunt this enqueues a oneshot carrying the candidate TargetSpec + advisor cost, billed once', async () => {
    const h = await withSession();
    const b1 = button('advise:hunt:T1:1');
    await handleAdviseButton(b1.port, { hunts: h.hunts, sessions: h.sessions });

    expect(h.enqueued).toHaveLength(1);
    expect(h.enqueued[0]).toMatchObject({ mode: 'oneshot', query: 'G305', channelId: 'T1', initialCostCents: 1 });
    expect(JSON.parse(h.enqueued[0]!.targetJson).description).toBe('G305');
    expect(b1.replies[0]).toContain('G305');

    // Second hunt from the same session: advisor spend already billed.
    const b2 = button('advise:hunt:T1:0');
    await handleAdviseButton(b2.port, { hunts: h.hunts, sessions: h.sessions });
    expect(h.enqueued[1]!.initialCostCents).toBe(0);
  });

  it('Watch this is a Phase 2 stub: friendly note, nothing enqueued', async () => {
    const h = await withSession();
    const b = button('advise:watch:T1:0');
    await handleAdviseButton(b.port, { hunts: h.hunts, sessions: h.sessions });
    expect(h.enqueued).toEqual([]);
    expect(b.replies[0]).toMatch(/phase 2/i);
  });

  it('a button from an expired/unknown session says so and enqueues nothing', async () => {
    const h = makeHarness();
    const b = button('advise:hunt:GONE:0');
    await handleAdviseButton(b.port, { hunts: h.hunts, sessions: h.sessions });
    expect(h.enqueued).toEqual([]);
    expect(b.replies[0]).toMatch(/expired/i);
  });
});
