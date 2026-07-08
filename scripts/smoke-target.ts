// Throwaway smoke check for the LLM wrapper + target parser: one real OpenRouter
// call. Prints the structured TargetSpec and the run's token tally.
import { parseTarget } from '../src/engine/target';
import { tokenTotals } from '../src/engine/llm';

const query = process.argv.slice(2).join(' ') || 'server HDD at least 10TB, CMR not SMR, under $150 used';

console.log('Query:', query, '\n');
const target = await parseTarget(query);
console.log('\nParsed TargetSpec:\n', JSON.stringify(target, null, 2));
console.log('\nRun token totals:', tokenTotals());
