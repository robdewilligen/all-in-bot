/** Every user-facing string. Placeholders are `{name}`; callers format coins and times first. */
export const en = {
  errors: {
    generic: 'Something went wrong on our side. Please try again in a moment.',
    guildOnly: 'All-in only works in servers.',
    cooldown: 'Slow down! You can use `/{command}` again {time}.',
    insufficientFunds:
      "You don't have enough coins: this needs {needed}, and your balance is {balance}.",
    missingPermissions: "I can't open a table in this channel. I'm missing: {permissions}.",
    tableClosed: 'This table has closed. Open stakes were refunded.',
  },
} as const;
