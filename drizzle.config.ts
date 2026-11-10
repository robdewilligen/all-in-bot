import { defineConfig } from 'drizzle-kit';

// Only `drizzle-kit generate` is used; migrations run through `npm run db:migrate`.
export default defineConfig({
  dialect: 'postgresql',
  schema: './src/db/schema.ts',
  out: './drizzle',
  strict: true,
  verbose: true,
});
