import {
  ApplicationIntegrationType,
  InteractionContextType,
  SlashCommandBuilder,
} from 'discord.js';

/** A slash command that only works in servers, installed to the server (SPEC §1). */
export function guildSlashCommand(name: string, description: string): SlashCommandBuilder {
  return new SlashCommandBuilder()
    .setName(name)
    .setDescription(description)
    .setContexts(InteractionContextType.Guild)
    .setIntegrationTypes(ApplicationIntegrationType.GuildInstall);
}
