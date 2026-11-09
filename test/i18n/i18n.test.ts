import { describe, expect, it } from 'vitest';
import { PlayerError } from '../../src/core/errors.js';
import { discordTimestamp, formatCoins } from '../../src/i18n/format.js';
import { t, translate } from '../../src/i18n/index.js';

describe('messages', () => {
  it('fills in every placeholder', () => {
    const text = t('en-US', 'errors.cooldown', { command: 'balance', time: '<t:1794265200:R>' });
    expect(text).toMatch(/\/balance\b/);
    expect(text).toContain('<t:1794265200:R>');
    expect(text).not.toMatch(/[{}]/);
  });

  it('falls back to English for a locale without its own catalog', () => {
    expect(t('nl', 'errors.generic')).toBe(t('en-US', 'errors.generic'));
    expect(t('pt-BR', 'errors.generic')).toBe(t('en-US', 'errors.generic'));
  });

  it("shows a PlayerError's message, and keeps its key for the logs", () => {
    const error = new PlayerError('errors.insufficientFunds', {
      needed: formatCoins(250),
      balance: formatCoins(100),
    });
    const text = translate('en-GB', error.userMessage);
    expect(text).toMatch(/🪙 250\b/);
    expect(text).toMatch(/🪙 100\b/);
    expect(text).not.toMatch(/[{}]/);
    expect(error.message).toBe('errors.insufficientFunds');
  });
});

describe('formatting', () => {
  it('shows coins with the coin sign and thousands separators', () => {
    expect(formatCoins(0)).toBe('🪙 0');
    expect(formatCoins(1_234)).toBe('🪙 1,234');
    expect(formatCoins(1_000_000)).toBe('🪙 1,000,000');
  });

  it('turns an instant into a Discord timestamp in whole seconds', () => {
    const instant = Temporal.Instant.from('2026-11-09T23:00:00.999Z');
    expect(discordTimestamp(instant)).toBe('<t:1794265200:R>');
    expect(discordTimestamp(instant, 'F')).toBe('<t:1794265200:F>');
  });
});
