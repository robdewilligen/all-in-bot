import { z } from 'zod';

// init.ps1 writes this placeholder for values it couldn't fill in.
const SETUP_PLACEHOLDER = 'change-me';

const blankAsMissing = (value: unknown): unknown =>
  typeof value === 'string' && value.trim() === '' ? undefined : value;

const missingOr =
  (message: string) =>
  (issue: { input: unknown }): string =>
    issue.input === undefined ? 'is missing' : message;

const noPlaceholder = (value: string): boolean => !value.includes(SETUP_PLACEHOLDER);

const requiredText = z.preprocess(
  blankAsMissing,
  z
    .string({ error: missingOr('must be text') })
    .refine(noPlaceholder, 'still holds the setup placeholder'),
);

const snowflake = z
  .string({ error: missingOr('must be a Discord ID') })
  .regex(/^\d{17,20}$/, 'must be a Discord ID (17 to 20 digits)');

const postgresUrl = z.preprocess(
  blankAsMissing,
  z
    .url({ protocol: /^postgres(ql)?$/, error: missingOr('must be a postgresql:// URL') })
    .refine(noPlaceholder, 'still holds the setup placeholder'),
);

function isTimeZone(value: string): boolean {
  try {
    new Intl.DateTimeFormat('en', { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

const timeZone = z.preprocess(
  blankAsMissing,
  z
    .string()
    .default('Europe/Amsterdam')
    .refine(isTimeZone, 'must be an IANA time zone such as Europe/Amsterdam'),
);

const logLevel = z.preprocess(
  blankAsMissing,
  z
    .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'], {
      error: 'must be one of fatal, error, warn, info, debug, trace or silent',
    })
    .default('info'),
);

/** What `npm run db:migrate` needs; on the database PC nothing else is set. */
export const databaseEnvSchema = z.object({ DATABASE_URL: postgresUrl });

/** What `npm run deploy:commands` needs. */
export const discordEnvSchema = z.object({
  DISCORD_TOKEN: requiredText,
  DISCORD_CLIENT_ID: z.preprocess(blankAsMissing, snowflake),
  DEV_GUILD_ID: z.preprocess(blankAsMissing, snowflake.optional()),
});

export const botEnvSchema = z.object({
  ...databaseEnvSchema.shape,
  ...discordEnvSchema.shape,
  DAILY_RESET_TIMEZONE: timeZone,
  LOG_LEVEL: logLevel,
});

export type DatabaseEnv = z.output<typeof databaseEnvSchema>;
export type DiscordEnv = z.output<typeof discordEnvSchema>;
export type BotEnv = z.output<typeof botEnvSchema>;

/** An incomplete or invalid .env; the message names each variable, never its value. */
export class EnvError extends Error {
  override readonly name = 'EnvError';
}

export function parseEnv<Schema extends z.ZodType>(
  schema: Schema,
  source: Readonly<Record<string, string | undefined>> = process.env,
): z.output<Schema> {
  const result = schema.safeParse(source);
  if (result.success) return result.data;
  const problems = result.error.issues.map((issue) => `  ${issue.path.join('.')} ${issue.message}`);
  throw new EnvError(`Check your .env file:\n${problems.join('\n')}`);
}
