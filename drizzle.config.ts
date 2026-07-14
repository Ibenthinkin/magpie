import { defineConfig } from 'drizzle-kit';

// drizzle-kit is used for codegen only (`bun run db:generate`); migrations are
// applied at runtime by src/db/client.ts via drizzle-orm's bun-sqlite migrator.
export default defineConfig({
  dialect: 'sqlite',
  schema: './src/db/schema.ts',
  out: './drizzle',
});
