import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb, type Db } from '../../../src/db/client';

/** Fresh migrated database in a temp file; each test gets its own. */
export function openTestDb(): Db {
  const dir = mkdtempSync(join(tmpdir(), 'magpie-test-'));
  return openDb(join(dir, 'test.db'));
}
