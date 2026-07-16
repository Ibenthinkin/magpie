import { afterEach, describe, expect, it } from 'vitest';
import { adviseTurn, type AdvisorExchange } from '../../src/engine/advisor';
import { setGenerateForTests } from '../../src/engine/llm';

// Mode C reasoning step (SPEC §3.2): each turn the model either asks
// clarifying questions or commits to 2–4 concrete candidates, each carrying a
// concretized TargetSpec. `force` ends the Q&A loop (round cap / user gone
// quiet): questions are no longer an acceptable answer.

afterEach(() => setGenerateForTests(null));

const candidate = (name: string) => ({
  name,
  pros: ['solid'],
  cons: ['pricey'],
  target: { description: name, constraints: {} },
});

function fakeAdvisor(object: unknown, captured?: { prompts: string[]; systems: string[] }) {
  setGenerateForTests(({ label, prompt, system }) => {
    if (label !== 'adviseTurn') throw new Error(`unexpected llm call: ${label}`);
    captured?.prompts.push(prompt);
    captured?.systems.push(system ?? '');
    return { object, usage: { inputTokens: 500, outputTokens: 100 }, costUsd: 0.01 };
  });
}

describe('adviseTurn', () => {
  it('returns a questions turn while the model still needs answers', async () => {
    fakeAdvisor({ questions: ['Budget?', 'Wired or wireless?'], candidates: [] });
    const turn = await adviseTurn('a good mouse', []);
    expect(turn).toEqual({ kind: 'questions', questions: ['Budget?', 'Wired or wireless?'] });
  });

  it('returns a candidates turn once the model commits', async () => {
    fakeAdvisor({ questions: [], candidates: [candidate('MX Master 3S'), candidate('G305')] });
    const turn = await adviseTurn('a good mouse', []);
    expect(turn.kind).toBe('candidates');
    if (turn.kind === 'candidates') {
      expect(turn.candidates.map((c) => c.name)).toEqual(['MX Master 3S', 'G305']);
      expect(turn.candidates[0]!.target.description).toBe('MX Master 3S');
    }
  });

  it('prefers candidates when the model returns both', async () => {
    fakeAdvisor({ questions: ['left over?'], candidates: [candidate('X')] });
    const turn = await adviseTurn('x', []);
    expect(turn.kind).toBe('candidates');
  });

  it('renders the exchange transcript into the prompt', async () => {
    const captured = { prompts: [] as string[], systems: [] as string[] };
    fakeAdvisor({ questions: ['q'], candidates: [] }, captured);
    const exchanges: AdvisorExchange[] = [
      { from: 'agent', text: 'Budget?' },
      { from: 'user', text: 'under $100' },
    ];
    await adviseTurn('a good mouse', exchanges);
    expect(captured.prompts[0]).toContain('a good mouse');
    expect(captured.prompts[0]).toContain('Budget?');
    expect(captured.prompts[0]).toContain('under $100');
  });

  it('force forbids further questions in the prompt and rejects a questions-only reply', async () => {
    const captured = { prompts: [] as string[], systems: [] as string[] };
    fakeAdvisor({ questions: ['one more?'], candidates: [] }, captured);
    await expect(adviseTurn('x', [], { force: true })).rejects.toThrow(/candidates/i);
    expect(captured.prompts[0]).toMatch(/no more questions/i);
  });

  it('an empty turn (no questions, no candidates) fails loudly', async () => {
    fakeAdvisor({ questions: [], candidates: [] });
    await expect(adviseTurn('x', [])).rejects.toThrow();
  });
});
