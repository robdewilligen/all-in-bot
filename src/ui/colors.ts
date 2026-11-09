import { Colors } from 'discord.js';

/** The embed palette from SPEC §4, named by what each colour is for. */
export const colors = {
  info: Colors.Blurple,
  inProgress: Colors.Blurple,
  win: Colors.Green,
  loss: Colors.Red,
  breakEven: Colors.Grey,
  dailyGift: Colors.Gold,
  leaderboard: Colors.Gold,
} as const;
