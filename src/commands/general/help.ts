import type { ChatInputCommandInteraction } from 'discord.js';
import { guildSlashCommand } from '../../bot/slash-command.js';
import type { Command } from '../../bot/types.js';
import { t } from '../../i18n/index.js';
import { helpReply, helpTopics } from '../../ui/help.js';

export default {
  data: guildSlashCommand('help', t('en', 'commands.help.description')).addStringOption((option) =>
    option
      .setName('topic')
      .setDescription(t('en', 'commands.help.topic'))
      .addChoices(
        ...helpTopics.map((topic) => ({
          name: t('en', `commands.help.topics.${topic}`),
          value: topic,
        })),
      ),
  ),
  async execute(interaction: ChatInputCommandInteraction<'cached'>): Promise<void> {
    await interaction.reply(helpReply(interaction.locale, interaction.options.getString('topic')));
  },
} satisfies Command;
