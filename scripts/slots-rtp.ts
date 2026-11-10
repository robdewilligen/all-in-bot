import { gameConfig } from '../src/config/game.js';
import { createSlotMachine } from '../src/games/slots/index.js';

const machine = createSlotMachine(gameConfig.slots);
const { combinations, returned, wins } = machine.exactRtp();
const count = new Intl.NumberFormat('en-US');
const percent = new Intl.NumberFormat('en-US', {
  style: 'percent',
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});
const stops = machine.reels.map((reel) => reel.length).join(' × ');

console.log(`Every stop combination once: ${stops} = ${count.format(combinations)} spins`);
console.log(
  `Return to player: ${count.format(returned)}/${count.format(combinations)} = ${percent.format(returned / combinations)}`,
);
console.log(
  `Win rate: ${count.format(wins)}/${count.format(combinations)} = ${percent.format(wins / combinations)}`,
);
