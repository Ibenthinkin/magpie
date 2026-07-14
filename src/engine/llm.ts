import { createOpenRouter } from '@openrouter/ai-sdk-provider';
import { generateObject, generateText } from 'ai';
import type { z } from 'zod';

// Single LLM call path. Every call flows through here so token usage and cost
// are accounted in one place; the worker brackets each hunt run with
// beginUsage()/endUsage() and lands the cents on hunt.cost_cents. SPEC §6.6.

function env(key: string): string {
  const v = process.env[key];
  if (v === undefined || v === '') throw new Error(`Missing required env var: ${key}`);
  return v;
}

// Lazy init: modules that import this one must stay loadable without env vars
// (vitest imports adapters → extract → here with the LLM faked).
let modelId: string | undefined;
let model: ReturnType<ReturnType<typeof createOpenRouter>['chat']> | undefined;

function getModel() {
  modelId ??= env('MAGPIE_MODEL');
  // usage.include makes OpenRouter report the real USD cost per response.
  model ??= createOpenRouter({ apiKey: env('OPENROUTER_API_KEY') }).chat(modelId, { usage: { include: true } });
  return model;
}

// ---------------------------------------------------------------------------
// Usage accounting

export interface UsageTotals {
  inputTokens: number;
  outputTokens: number;
  costCents: number;
}

// Pessimistic USD-per-million-token fallback for when OpenRouter doesn't report
// cost. Deliberately above what MAGPIE_MODEL (a cheap model) actually charges —
// overcounting spend is safe, undercounting defeats the budget ceiling.
const FALLBACK_USD_PER_MTOK = { input: 1, output: 3 };

// Active per-hunt bracket. Module-level is safe: the worker runs hunts at
// concurrency 1, and command-side parseTarget calls are awaited inline.
let active: { inputTokens: number; outputTokens: number; costUsd: number } | null = null;

// Process-lifetime token tally (diagnostics only).
let runInputTokens = 0;
let runOutputTokens = 0;

export function tokenTotals(): { inputTokens: number; outputTokens: number } {
  return { inputTokens: runInputTokens, outputTokens: runOutputTokens };
}

/** Start (or restart) the per-hunt usage bracket. */
export function beginUsage(): void {
  active = { inputTokens: 0, outputTokens: 0, costUsd: 0 };
}

/** Close the bracket: totals since beginUsage(), cost rounded UP to whole cents. */
export function endUsage(): UsageTotals {
  const a = active;
  active = null;
  if (!a) return { inputTokens: 0, outputTokens: 0, costCents: 0 };
  return { inputTokens: a.inputTokens, outputTokens: a.outputTokens, costCents: Math.ceil(a.costUsd * 100) };
}

function account(label: string, usage: { inputTokens?: number; outputTokens?: number } | undefined, costUsd: number | undefined): void {
  const inTok = usage?.inputTokens ?? 0;
  const outTok = usage?.outputTokens ?? 0;
  const usd = costUsd ?? (inTok * FALLBACK_USD_PER_MTOK.input + outTok * FALLBACK_USD_PER_MTOK.output) / 1_000_000;
  runInputTokens += inTok;
  runOutputTokens += outTok;
  if (active) {
    active.inputTokens += inTok;
    active.outputTokens += outTok;
    active.costUsd += usd;
  }
  console.log(
    `[llm] ${label} model=${modelId ?? 'fake'} in=${inTok} out=${outTok} usd=${usd.toFixed(6)}` +
      (costUsd === undefined ? ' (estimated)' : ''),
  );
}

/** OpenRouter reports response cost in USD under providerMetadata when usage.include is on. */
function reportedCost(providerMetadata: unknown): number | undefined {
  const cost = (providerMetadata as { openrouter?: { usage?: { cost?: unknown } } } | undefined)?.openrouter?.usage
    ?.cost;
  return typeof cost === 'number' ? cost : undefined;
}

// ---------------------------------------------------------------------------
// Test seam: replaces the provider call entirely so tests never touch env/network.

export interface FakeGenCall {
  kind: 'object' | 'text';
  label?: string;
  system?: string;
  prompt: string;
}

export interface FakeGenResult {
  object?: unknown;
  text?: string;
  usage?: { inputTokens?: number; outputTokens?: number };
  costUsd?: number;
}

export type FakeGenerate = (call: FakeGenCall) => FakeGenResult | Promise<FakeGenResult>;

let fakeGenerate: FakeGenerate | null = null;

export function setGenerateForTests(fn: FakeGenerate | null): void {
  fakeGenerate = fn;
}

// ---------------------------------------------------------------------------
// Call surface

/** Structured generation with schema validation + usage accounting. */
export async function genObject<T>(opts: {
  schema: z.ZodType<T>;
  prompt: string;
  system?: string;
  label?: string; // identifies the call site in logs
}): Promise<T> {
  const label = opts.label ?? 'genObject';

  if (fakeGenerate) {
    const fake = await fakeGenerate({ kind: 'object', label: opts.label, system: opts.system, prompt: opts.prompt });
    account(label, fake.usage, fake.costUsd);
    return fake.object as T;
  }

  const { object, usage, providerMetadata } = await generateObject({
    model: getModel(),
    schema: opts.schema,
    system: opts.system,
    prompt: opts.prompt,
  });
  account(label, usage, reportedCost(providerMetadata));
  return object as T;
}

/** Plain-text generation (advisor turns) with the same accounting. */
export async function genText(opts: { prompt: string; system?: string; label?: string }): Promise<string> {
  const label = opts.label ?? 'genText';

  if (fakeGenerate) {
    const fake = await fakeGenerate({ kind: 'text', label: opts.label, system: opts.system, prompt: opts.prompt });
    account(label, fake.usage, fake.costUsd);
    return fake.text ?? '';
  }

  const { text, usage, providerMetadata } = await generateText({
    model: getModel(),
    system: opts.system,
    prompt: opts.prompt,
  });
  account(label, usage, reportedCost(providerMetadata));
  return text;
}
