import { z } from 'zod';
import { genObject } from './llm';
import { targetSpecSchema } from './target';

// Mode C (SPEC §3.2): need → clarifying Q&A → 2–4 concrete candidates, each
// carrying a concretized TargetSpec so the Hunt/Watch buttons need no
// re-typing. One LLM call per turn; the model decides when it knows enough,
// the caller decides when it's out of turns (`force`).

export interface AdvisorExchange {
  from: 'agent' | 'user';
  text: string;
}

const candidateSchema = z.object({
  name: z.string().describe('concrete product: brand + model'),
  pros: z.array(z.string()).describe('2-4 short pros'),
  cons: z.array(z.string()).describe('1-3 short cons'),
  target: targetSpecSchema,
});
export type AdvisorCandidate = z.infer<typeof candidateSchema>;

const turnSchema = z.object({
  questions: z
    .array(z.string())
    .describe('clarifying questions you still need answered; empty once you are ready to recommend'),
  candidates: candidateSchema
    .array()
    .describe('2-4 concrete candidate products once ready; empty while questions remain'),
});

export type AdvisorTurn =
  | { kind: 'questions'; questions: string[] }
  | { kind: 'candidates'; candidates: AdvisorCandidate[] };

const SYSTEM = [
  'You are a sharp, practical shopping advisor turning a fuzzy need into concrete product picks.',
  'If key facts are missing (budget, use case, constraints), ask a FEW crisp clarifying questions —',
  'never more than 3 per turn, and prefer one turn of questions total. Once you know enough,',
  'return 2-4 concrete candidates (brand + model) with honest pros/cons and, for each, a',
  'search-ready target: description fit for a marketplace search box, plus any constraints the',
  'user stated. Never invent constraints the user did not give.',
].join(' ');

export async function adviseTurn(
  need: string,
  exchanges: AdvisorExchange[],
  opts: { force?: boolean } = {},
): Promise<AdvisorTurn> {
  const transcript = exchanges.map((e) => `${e.from}: ${e.text}`).join('\n');
  const prompt = [
    `Need: ${need}`,
    transcript ? `\nConversation so far:\n${transcript}` : '',
    opts.force ? '\nNo more questions available — you MUST return final candidates now.' : '',
  ].join('\n');

  const turn = await genObject({ label: 'adviseTurn', schema: turnSchema, system: SYSTEM, prompt });

  if (turn.candidates.length > 0) return { kind: 'candidates', candidates: turn.candidates };
  if (opts.force) throw new Error('advisor returned no candidates when forced to conclude');
  if (turn.questions.length > 0) return { kind: 'questions', questions: turn.questions };
  throw new Error('advisor returned neither questions nor candidates');
}
