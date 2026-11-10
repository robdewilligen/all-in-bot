import { writeFile } from 'node:fs/promises';
import { Events } from 'discord.js';
import type { BotEvent } from '../bot/types.js';

export default {
  name: Events.ClientReady,
  once: true,
  async execute(context, client) {
    context.logger.info({ tag: client.user.tag, guilds: client.guilds.cache.size }, 'logged in');
    // The container's healthcheck waits for this file (deploy/compose.yaml).
    const readyFile = process.env.READY_FILE;
    if (readyFile === undefined || readyFile === '') return;
    try {
      await writeFile(readyFile, `${context.clock().toString()}\n`);
    } catch (error) {
      context.logger.warn({ err: error, readyFile }, 'could not write the ready file');
    }
  },
} satisfies BotEvent<Events.ClientReady>;
