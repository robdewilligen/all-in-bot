import type { Message } from '../i18n/index.js';

/**
 * Something the player caused or can fix (bad input, too few coins, cooldown, not their turn).
 * The bot shows its message ephemerally; every other error is logged and gets a generic reply.
 */
export class PlayerError extends Error {
  override readonly name = 'PlayerError';
  readonly userMessage: Message;

  constructor(...message: Message) {
    super(message[0]);
    this.userMessage = message;
  }
}
