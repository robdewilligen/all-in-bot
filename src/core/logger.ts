import pino from 'pino';

/** The app's one logger; index.ts sets its level from LOG_LEVEL. */
export const logger = pino({ level: 'info' });

export type Logger = pino.Logger;
