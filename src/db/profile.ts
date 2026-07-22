import { asc, eq, sql } from 'drizzle-orm';
import { nanoid } from 'nanoid';
import type { Db } from './client';
import { profileFact } from './schema';
import type { NewProfileFact, ProfileFactRow, ProfileRepo } from './types';

export function makeProfileRepo(db: Db, now: () => string = () => new Date().toISOString()): ProfileRepo {
  return {
    addFact(input: NewProfileFact): ProfileFactRow {
      const ts = now();
      const rows = db
        .insert(profileFact)
        .values({
          id: nanoid(),
          category: input.category,
          label: input.label,
          value: input.value,
          createdAt: ts,
          updatedAt: ts,
        })
        .returning()
        .all();
      return rows[0]!;
    },

    getFact(id): ProfileFactRow | null {
      return db.select().from(profileFact).where(eq(profileFact.id, id)).get() ?? null;
    },

    activeFacts(): ProfileFactRow[] {
      return db
        .select()
        .from(profileFact)
        .where(eq(profileFact.active, 1))
        .orderBy(asc(profileFact.createdAt), asc(sql`rowid`))
        .all();
    },

    removeFact(id): void {
      db.update(profileFact).set({ active: 0, updatedAt: now() }).where(eq(profileFact.id, id)).run();
    },
  };
}
