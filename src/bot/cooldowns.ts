import type { CooldownKey, CooldownTracker } from './types.js';

const SWEEP_INTERVAL_MS = 60_000;

/** Per-user command cooldowns in memory, keyed by server (SPEC §12). */
export class Cooldowns implements CooldownTracker {
  readonly #ends = new Map<string, number>();
  #nextSweep = 0;

  /** How many cooldowns are stored, expired ones included until the next sweep. */
  get size(): number {
    return this.#ends.size;
  }

  hit(key: CooldownKey, seconds: number, nowMs: number): number | null {
    this.#sweep(nowMs);
    const id = `${key.guildId}:${key.userId}:${key.command}`;
    const end = this.#ends.get(id);
    if (end !== undefined && end > nowMs) return end;
    this.#ends.set(id, nowMs + seconds * 1000);
    return null;
  }

  #sweep(nowMs: number): void {
    if (nowMs < this.#nextSweep) return;
    this.#nextSweep = nowMs + SWEEP_INTERVAL_MS;
    for (const [id, end] of this.#ends) {
      if (end <= nowMs) this.#ends.delete(id);
    }
  }
}
