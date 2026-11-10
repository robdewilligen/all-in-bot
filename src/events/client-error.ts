import { Events } from 'discord.js';
import { loggableError } from '../bot/errors.js';
import type { BotEvent } from '../bot/types.js';

export default {
  name: Events.Error,
  execute(context, error) {
    context.logger.error({ err: loggableError(error) }, 'Discord client error');
  },
} satisfies BotEvent<Events.Error>;
