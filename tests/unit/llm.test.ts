import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { beginUsage, endUsage, genObject, genText, setGenerateForTests } from '../../src/engine/llm';

// D6: per-hunt usage accounting. beginUsage()/endUsage() bracket a hunt run
// (worker concurrency 1, so a module-level active tally is safe); cost prefers
// the OpenRouter-reported USD figure, else a pricing-constant estimate; always
// rounded UP to whole cents. setGenerateForTests() is the offline seam.

afterEach(() => setGenerateForTests(null));

const shape = z.object({ ok: z.boolean() });

describe('setGenerateForTests seam', () => {
  it('genObject returns the faked object without touching env or network', async () => {
    setGenerateForTests(() => ({ object: { ok: true } }));
    const out = await genObject({ schema: shape, prompt: 'p' });
    expect(out).toEqual({ ok: true });
  });

  it('genText returns the faked text', async () => {
    setGenerateForTests(({ kind }) => {
      expect(kind).toBe('text');
      return { text: 'hello' };
    });
    await expect(genText({ prompt: 'p' })).resolves.toBe('hello');
  });

  it('passes label/system/prompt through to the fake', async () => {
    let seen: unknown;
    setGenerateForTests((call) => {
      seen = call;
      return { object: { ok: true } };
    });
    await genObject({ schema: shape, prompt: 'the prompt', system: 'sys', label: 'myLabel' });
    expect(seen).toMatchObject({ kind: 'object', label: 'myLabel', system: 'sys', prompt: 'the prompt' });
  });
});

describe('beginUsage/endUsage', () => {
  it('tallies tokens across calls and prefers provider-reported cost, rounded up to cents', async () => {
    setGenerateForTests(() => ({
      object: { ok: true },
      usage: { inputTokens: 1000, outputTokens: 200 },
      costUsd: 0.0123, // 1.23 cents → rounds UP to 2
    }));
    beginUsage();
    await genObject({ schema: shape, prompt: 'a' });
    await genObject({ schema: shape, prompt: 'b' });
    const totals = endUsage();
    expect(totals.inputTokens).toBe(2000);
    expect(totals.outputTokens).toBe(400);
    expect(totals.costCents).toBe(3); // 2 × $0.0123 = 2.46 cents → ceil 3
  });

  it('falls back to a pricing-constant estimate when no cost is reported, never zero for real tokens', async () => {
    setGenerateForTests(() => ({
      object: { ok: true },
      usage: { inputTokens: 1000, outputTokens: 1000 },
    }));
    beginUsage();
    await genObject({ schema: shape, prompt: 'a' });
    const totals = endUsage();
    expect(totals.costCents).toBeGreaterThanOrEqual(1); // estimate rounds up
  });

  it('endUsage resets the tally; a fresh bracket starts at zero', async () => {
    setGenerateForTests(() => ({
      object: { ok: true },
      usage: { inputTokens: 10, outputTokens: 10 },
      costUsd: 0.01,
    }));
    beginUsage();
    await genObject({ schema: shape, prompt: 'a' });
    endUsage();
    beginUsage();
    const totals = endUsage();
    expect(totals).toEqual({ inputTokens: 0, outputTokens: 0, costCents: 0 });
  });

  it('endUsage without beginUsage returns zeros instead of throwing', () => {
    expect(endUsage()).toEqual({ inputTokens: 0, outputTokens: 0, costCents: 0 });
  });

  it('calls outside a begin/end bracket still work', async () => {
    setGenerateForTests(() => ({ object: { ok: true }, usage: { inputTokens: 5, outputTokens: 5 } }));
    await expect(genObject({ schema: shape, prompt: 'a' })).resolves.toEqual({ ok: true });
  });

  it('genText usage is accounted too', async () => {
    setGenerateForTests(() => ({ text: 't', usage: { inputTokens: 100, outputTokens: 50 }, costUsd: 0.005 }));
    beginUsage();
    await genText({ prompt: 'p' });
    const totals = endUsage();
    expect(totals).toEqual({ inputTokens: 100, outputTokens: 50, costCents: 1 });
  });
});
