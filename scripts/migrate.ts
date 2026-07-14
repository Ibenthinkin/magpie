// Apply migrations to the configured database (creates it if missing).
import { loadConfig } from '../src/config';
import { openDb } from '../src/db/client';

const config = loadConfig();
openDb(config.dbPath);
console.log(`[db.migrate] applied migrations to ${config.dbPath}`);
