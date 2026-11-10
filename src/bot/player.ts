import type { PlayerIdentity } from '../core/wallet.js';

interface GuildActor {
  readonly guildId: string;
  readonly user: { readonly id: string };
  readonly member: { readonly displayName: string };
}

/** The player behind a guild interaction, with the display name SPEC §5 stores. */
export function playerOf(interaction: GuildActor): PlayerIdentity {
  return {
    guildId: interaction.guildId,
    userId: interaction.user.id,
    displayName: interaction.member.displayName,
  };
}
