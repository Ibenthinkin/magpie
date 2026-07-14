import { Database } from 'bun:sqlite';
import { drizzle, type BunSQLiteDatabase } from 'drizzle-orm/bun-sqlite';
import { migrate } from 'drizzle-orm/bun-sqlite/migrator';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as schema from './schema';

// The ONLY module that touches bun:sqlite — nothing under tests/unit/ may
// import it, even transitively (bun:sqlite cannot load under vitest).

export type Db = BunSQLiteDatabase<typeof schema>;

const MIGRATIONS_FOLDER = fileURLToPath(new URL('../../drizzle', import.meta.url));

/** Open (creating if needed) and migrate a database at `path`. */
export function openDb(path: string): Db {
  mkdirSync(dirname(path), { recursive: true });
  const sqlite = new Database(path, { create: true });
  sqlite.exec('PRAGMA journal_mode = WAL;');
  sqlite.exec('PRAGMA foreign_keys = ON;');
  const db = drizzle(sqlite, { schema });
  migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });
  return db;
}

let singleton: Db | undefined;

/** Process-wide database, opened on first use. */
export function getDb(path: string): Db {
  singleton ??= openDb(path);
  return singleton;
}
