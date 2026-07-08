import { createOpenRouter } from '@openrouter/ai-sdk-provider';
import { generateObject } from 'ai';
import type { z } from 'zod';

// Single LLM call path. Every structured call flows through here so token usage
// is accounted in one place (Phase 1 moves the tally onto hunt.cost_cents). See
// SPEC §6.6.

function env(key: string): string {
  const v = process.env[key];
  if (v === undefined || v === '') throw new Error(`Missing required env var: ${key}`);
  return v;
}

const MODEL_ID = env('MAGPIE_MODEL');
const openrouter = createOpenRouter({ apiKey: env('OPENROUTER_API_KEY') });
const model = openrouter.chat(MODEL_ID);

// Process-lifetime token tally. In Phase 1 this accrues per-hunt into cost_cents.
let runInputTokens = 0;
let runOutputTokens = 0;

export function tokenTotals(): { inputTokens: number; outputTokens: number } {
  return { inputTokens: runInputTokens, outputTokens: runOutputTokens };
}

/** Structured generation with schema validation + token accounting. */
export async function genObject<T>(opts: {
  schema: z.ZodType<T>;
  prompt: string;
  system?: string;
  label?: string; // identifies the call site in logs
}): Promise<T> {
  const { object, usage } = await generateObject({
    model,
    schema: opts.schema,
    system: opts.system,
    prompt: opts.prompt,
  });

  const inTok = usage.inputTokens ?? 0;
  const outTok = usage.outputTokens ?? 0;
  runInputTokens += inTok;
  runOutputTokens += outTok;
  console.log(
    `[llm] ${opts.label ?? 'genObject'} model=${MODEL_ID} in=${inTok} out=${outTok} ` +
      `(run total in=${runInputTokens} out=${runOutputTokens})`,
  );

  return object as T;
}
