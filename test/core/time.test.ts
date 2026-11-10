import { describe, expect, it } from 'vitest';
import { dayOf, nextResetAfter } from '../../src/core/time.js';

const AMSTERDAM = 'Europe/Amsterdam';
const at = (iso: string): Temporal.Instant => Temporal.Instant.from(iso);

describe('the daily reset', () => {
  it('starts a new day at midnight in Amsterdam in winter (UTC+1)', () => {
    expect(dayOf(at('2026-01-15T22:59:59Z'), AMSTERDAM).toString()).toBe('2026-01-15');
    expect(dayOf(at('2026-01-15T23:00:00Z'), AMSTERDAM).toString()).toBe('2026-01-16');
    expect(nextResetAfter(at('2026-01-15T12:00:00Z'), AMSTERDAM).toString()).toBe(
      '2026-01-15T23:00:00Z',
    );
  });

  it('gives 29 March 2026 23 hours when the clocks go forward', () => {
    const start = nextResetAfter(at('2026-03-28T12:00:00Z'), AMSTERDAM);
    const end = nextResetAfter(at('2026-03-29T12:00:00Z'), AMSTERDAM);
    expect(start.toString()).toBe('2026-03-28T23:00:00Z');
    expect(end.toString()).toBe('2026-03-29T22:00:00Z');
    expect(start.until(end).total('hours')).toBe(23);
    expect(dayOf(at('2026-03-29T21:59:59Z'), AMSTERDAM).toString()).toBe('2026-03-29');
    expect(dayOf(at('2026-03-29T22:00:00Z'), AMSTERDAM).toString()).toBe('2026-03-30');
  });

  it('gives 25 October 2026 25 hours when the clocks go back', () => {
    const start = nextResetAfter(at('2026-10-24T12:00:00Z'), AMSTERDAM);
    const end = nextResetAfter(at('2026-10-25T12:00:00Z'), AMSTERDAM);
    expect(start.toString()).toBe('2026-10-24T22:00:00Z');
    expect(end.toString()).toBe('2026-10-25T23:00:00Z');
    expect(start.until(end).total('hours')).toBe(25);
    expect(dayOf(at('2026-10-25T22:59:59Z'), AMSTERDAM).toString()).toBe('2026-10-25');
    expect(dayOf(at('2026-10-25T23:00:00Z'), AMSTERDAM).toString()).toBe('2026-10-26');
  });

  it('follows the configured time zone', () => {
    expect(dayOf(at('2026-11-09T04:59:59Z'), 'America/New_York').toString()).toBe('2026-11-08');
    expect(nextResetAfter(at('2026-11-09T04:00:00Z'), 'America/New_York').toString()).toBe(
      '2026-11-09T05:00:00Z',
    );
  });
});
