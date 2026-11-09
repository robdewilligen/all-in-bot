import { describe, expect, it } from 'vitest';
import { Cooldowns } from '../../src/bot/cooldowns.js';

const key = { guildId: '100000000000000001', userId: '200000000000000001', command: 'spin' };

describe('Cooldowns', () => {
  it('starts a cooldown and reports when the running one ends', () => {
    const cooldowns = new Cooldowns();

    expect(cooldowns.hit(key, 3, 1_000)).toBeNull();
    expect(cooldowns.hit(key, 3, 2_000)).toBe(4_000);
    expect(cooldowns.hit(key, 3, 3_999)).toBe(4_000);
  });

  it('starts a new cooldown once the old one has ended', () => {
    const cooldowns = new Cooldowns();
    cooldowns.hit(key, 3, 1_000);

    expect(cooldowns.hit(key, 3, 4_000)).toBeNull();
    expect(cooldowns.hit(key, 3, 5_000)).toBe(7_000);
  });

  it('keeps servers, users and commands apart', () => {
    const cooldowns = new Cooldowns();
    cooldowns.hit(key, 3, 1_000);

    expect(cooldowns.hit({ ...key, guildId: '100000000000000002' }, 3, 1_000)).toBeNull();
    expect(cooldowns.hit({ ...key, userId: '200000000000000002' }, 3, 1_000)).toBeNull();
    expect(cooldowns.hit({ ...key, command: 'balance' }, 3, 1_000)).toBeNull();
    expect(cooldowns.hit(key, 3, 1_000)).toBe(4_000);
  });

  it('sweeps expired cooldowns so they do not pile up', () => {
    const cooldowns = new Cooldowns();
    cooldowns.hit({ ...key, userId: 'a' }, 3, 0);
    cooldowns.hit({ ...key, userId: 'b' }, 120, 0);
    cooldowns.hit({ ...key, userId: 'c' }, 3, 1_000);
    expect(cooldowns.size).toBe(3);

    cooldowns.hit({ ...key, userId: 'd' }, 3, 60_000);

    expect(cooldowns.size).toBe(2);
    expect(cooldowns.hit({ ...key, userId: 'b' }, 120, 60_000)).toBe(120_000);
  });
});
