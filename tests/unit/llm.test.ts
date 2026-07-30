import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { extractionModel, genObject, genText, setGenerateForTests, visionModel, withUsage } from '../../src/engine/llm';

// Per-hunt usage accounting. withUsage() scopes a tally to its async context
// (AsyncLocalStorage), so the worker's hunt bracket and a command-side
// parseTarget bracket can interleave in one process without clobbering each
// other. Cost prefers the OpenRouter-reported USD figure, else a pricing-
// constant estimate; always rounded UP to whole cents. setGenerateForTests()
// is the offline seam.

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

  it('surfaces the image count to the fake when images are attached (vision fallback, Task 5)', async () => {
    let seen: unknown;
    setGenerateForTests((call) => {
      seen = call;
      return { object: { ok: true } };
    });
    await genObject({
      schema: shape,
      prompt: 'describe this',
      images: [
        { data: Buffer.from('fake-png-bytes'), mediaType: 'image/png' },
        { data: new Uint8Array([1, 2, 3]), mediaType: 'image/jpeg' },
      ],
    });
    expect(seen).toMatchObject({ kind: 'object', prompt: 'describe this', imageCount: 2 });
  });

  it('leaves imageCount unset on the fake call when no images are passed', async () => {
    let seen: unknown;
    setGenerateForTests((call) => {
      seen = call;
      return { object: { ok: true } };
    });
    await genObject({ schema: shape, prompt: 'no images here' });
    expect((seen as { imageCount?: number }).imageCount).toBeUndefined();
  });
});

describe('extractionModel — the opt-in cheap-extraction lever', () => {
  const saved = process.env.MAGPIE_EXTRACT_MODEL;
  afterEach(() => {
    if (saved === undefined) delete process.env.MAGPIE_EXTRACT_MODEL;
    else process.env.MAGPIE_EXTRACT_MODEL = saved;
  });

  it('is off unless MAGPIE_EXTRACT_MODEL names a model — unset and empty both mean "use the default"', () => {
    delete process.env.MAGPIE_EXTRACT_MODEL;
    expect(extractionModel()).toBeUndefined();
    process.env.MAGPIE_EXTRACT_MODEL = '';
    expect(extractionModel()).toBeUndefined();
  });

  it('returns the configured model id when set', () => {
    process.env.MAGPIE_EXTRACT_MODEL = 'anthropic/claude-haiku-4.5';
    expect(extractionModel()).toBe('anthropic/claude-haiku-4.5');
  });

  it('is read per call, so flipping the env mid-process takes effect', () => {
    process.env.MAGPIE_EXTRACT_MODEL = 'a/one';
    expect(extractionModel()).toBe('a/one');
    process.env.MAGPIE_EXTRACT_MODEL = 'b/two';
    expect(extractionModel()).toBe('b/two');
  });
});

describe('visionModel — model override for vision fallback (opt-in gate is MAGPIE_VISION_FALLBACK_ENABLED, wired separately in index.ts)', () => {
  const saved = process.env.MAGPIE_VISION_MODEL;
  afterEach(() => {
    if (saved === undefined) delete process.env.MAGPIE_VISION_MODEL;
    else process.env.MAGPIE_VISION_MODEL = saved;
  });

  it('falls through to undefined (genObject default MAGPIE_MODEL) — unset and empty both mean "use the default model"', () => {
    delete process.env.MAGPIE_VISION_MODEL;
    expect(visionModel()).toBeUndefined();
    process.env.MAGPIE_VISION_MODEL = '';
    expect(visionModel()).toBeUndefined();
  });

  it('returns the configured model id when set', () => {
    process.env.MAGPIE_VISION_MODEL = 'anthropic/claude-haiku-4.5-vision';
    expect(visionModel()).toBe('anthropic/claude-haiku-4.5-vision');
  });

  it('is read per call, so flipping the env mid-process takes effect', () => {
    process.env.MAGPIE_VISION_MODEL = 'a/one';
    expect(visionModel()).toBe('a/one');
    process.env.MAGPIE_VISION_MODEL = 'b/two';
    expect(visionModel()).toBe('b/two');
  });
});

describe('withUsage', () => {
  it('tallies tokens across calls and prefers provider-reported cost, rounded up to cents', async () => {
    setGenerateForTests(() => ({
      object: { ok: true },
      usage: { inputTokens: 1000, outputTokens: 200 },
      costUsd: 0.0123, // 1.23 cents → rounds UP to 2
    }));
    const totals = await withUsage(async (usage) => {
      await genObject({ schema: shape, prompt: 'a' });
      await genObject({ schema: shape, prompt: 'b' });
      return usage();
    });
    expect(totals.inputTokens).toBe(2000);
    expect(totals.outputTokens).toBe(400);
    expect(totals.costCents).toBe(3); // 2 × $0.0123 = 2.46 cents → ceil 3
  });

  it('falls back to a pricing-constant estimate when no cost is reported, never zero for real tokens', async () => {
    setGenerateForTests(() => ({
      object: { ok: true },
      usage: { inputTokens: 1000, outputTokens: 1000 },
    }));
    const totals = await withUsage(async (usage) => {
      await genObject({ schema: shape, prompt: 'a' });
      return usage();
    });
    expect(totals.costCents).toBeGreaterThanOrEqual(1); // estimate rounds up
  });

  it('concurrent brackets do not cross-contaminate (worker hunt + command-side parse)', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    setGenerateForTests(async () => {
      await gate; // hold every call until both brackets are in flight
      return { object: { ok: true }, usage: { inputTokens: 100, outputTokens: 10 }, costUsd: 0.01 };
    });
    const huntBracket = withUsage(async (usage) => {
      await genObject({ schema: shape, prompt: 'extract' });
      await genObject({ schema: shape, prompt: 'rank' });
      return usage();
    });
    const parseBracket = withUsage(async (usage) => {
      await genObject({ schema: shape, prompt: 'parse' });
      return usage();
    });
    release();
    const [hunt, parse] = await Promise.all([huntBracket, parseBracket]);
    expect(hunt).toEqual({ inputTokens: 200, outputTokens: 20, costCents: 2 });
    expect(parse).toEqual({ inputTokens: 100, outputTokens: 10, costCents: 1 });
  });

  it('usage() is readable mid-bracket, before failure handling', async () => {
    setGenerateForTests(() => ({ object: { ok: true }, usage: { inputTokens: 10, outputTokens: 5 }, costUsd: 0.02 }));
    const cost = await withUsage(async (usage) => {
      await genObject({ schema: shape, prompt: 'a' });
      try {
        throw new Error('downstream failure');
      } catch {
        return usage().costCents; // failHunt path still lands spent cents
      }
    });
    expect(cost).toBe(2);
  });

  it('calls outside any bracket still work', async () => {
    setGenerateForTests(() => ({ object: { ok: true }, usage: { inputTokens: 5, outputTokens: 5 } }));
    await expect(genObject({ schema: shape, prompt: 'a' })).resolves.toEqual({ ok: true });
  });

  it('genText usage is accounted too', async () => {
    setGenerateForTests(() => ({ text: 't', usage: { inputTokens: 100, outputTokens: 50 }, costUsd: 0.005 }));
    const totals = await withUsage(async (usage) => {
      await genText({ prompt: 'p' });
      return usage();
    });
    expect(totals).toEqual({ inputTokens: 100, outputTokens: 50, costCents: 1 });
  });

  it('accounts usage identically whether or not images are attached — no special-casing cost tracking', async () => {
    setGenerateForTests(() => ({
      object: { ok: true },
      usage: { inputTokens: 1000, outputTokens: 200 },
      costUsd: 0.0123,
    }));
    const textOnly = await withUsage(async (usage) => {
      await genObject({ schema: shape, prompt: 'a' });
      return usage();
    });
    const withImages = await withUsage(async (usage) => {
      await genObject({ schema: shape, prompt: 'a', images: [{ data: Buffer.from('x'), mediaType: 'image/png' }] });
      return usage();
    });
    expect(withImages).toEqual(textOnly);
    expect(textOnly).toEqual({ inputTokens: 1000, outputTokens: 200, costCents: 2 });
  });
});
