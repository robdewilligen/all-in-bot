import { Events } from 'discord.js';
import type { BotEvent } from '../bot/types.js';

export default {
  name: Events.ClientReady,
  once: true,
  execute(context, client) {
    context.logger.info({ tag: client.user.tag, guilds: client.guilds.cache.size }, 'logged in');
  },
} satisfies BotEvent<Events.ClientReady>;
