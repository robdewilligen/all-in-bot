import { formatCoins } from '../i18n/format.js';
import type { Message } from '../i18n/index.js';

export type AmountKeyword = 'all' | 'max' | 'half';

export interface AmountContext {
  /** The player's balance, which the keywords resolve against. */
  readonly balance: number;
  /** The maximum stake: `all` above it is rejected, `max` is capped at it. */
  readonly max: number;
}

export type ParsedAmount =
  | { readonly ok: true; readonly amount: number; readonly keyword: AmountKeyword | null }
  | { readonly ok: false; readonly error: Message };

export interface StakeLimits {
  readonly min: number;
  readonly max: number;
}

// A Map, so input such as `constructor` can't reach Object.prototype.
const KEYWORDS = new Map<string, AmountKeyword>([
  ['all', 'all'],
  ['all-in', 'all'],
  ['allin', 'all'],
  ['alles', 'all'],
  ['max', 'max'],
  ['half', 'half'],
  ['helft', 'half'],
]);

const SUFFIXES = { k: 1_000n, m: 1_000_000n } as const;
const LARGEST_SAFE = BigInt(Number.MAX_SAFE_INTEGER);

function refuse(...error: Message): ParsedAmount {
  return { ok: false, error };
}

/** The keyword the input names (`alles` is `all`, `helft` is `half`), or null for anything else. */
export function amountKeyword(input: string): AmountKeyword | null {
  return KEYWORDS.get(input.trim().toLowerCase()) ?? null;
}

function keywordAmount(keyword: AmountKeyword, balance: number, max: number): number {
  switch (keyword) {
    case 'all':
      return balance;
    case 'max':
      return Math.min(balance, max);
    case 'half':
      return Math.floor(balance / 2);
  }
}

function resolveKeyword(keyword: AmountKeyword, { balance, max }: AmountContext): ParsedAmount {
  if (balance <= 0) return refuse('amount.noCoins');
  if (keyword === 'all' && balance > max) {
    return refuse('amount.allAboveMax', { balance: formatCoins(balance), max: formatCoins(max) });
  }
  const amount = keywordAmount(keyword, balance, max);
  if (keyword === 'half' && amount === 0) {
    return refuse('amount.halfIsZero', { balance: formatCoins(balance) });
  }
  // Only a maximum of 0 or less gets here.
  if (amount <= 0) return refuse('amount.zero');
  return { ok: true, amount, keyword };
}

/** `text` holds digits, `,` and `.`, and at most a trailing `k` or `m`. */
function parseNumber(text: string, max: number): ParsedAmount {
  if (text.includes(',') && text.includes('.')) return refuse('amount.mixed');
  let value: bigint;
  const suffix = text.at(-1);
  if (suffix === 'k' || suffix === 'm') {
    const body = text.slice(0, -1);
    const decimal = /^(\d+)(?:[.,](\d+))?$/.exec(body);
    if (decimal === null) {
      const separators = body.replaceAll(/\d/g, '').length;
      return separators > 1 ? refuse('amount.decimalPoint') : refuse('amount.invalid');
    }
    const whole = decimal[1] ?? '';
    const fraction = decimal[2] ?? '';
    const scale = 10n ** BigInt(fraction.length);
    const scaled = BigInt(whole + fraction) * SUFFIXES[suffix];
    if (scaled % scale !== 0n) return refuse('amount.fraction');
    value = scaled / scale;
  } else if (/^\d+$/.test(text)) {
    value = BigInt(text);
  } else if (/^[1-9]\d{0,2}(?:[.,]\d{3})+$/.test(text)) {
    value = BigInt(text.replaceAll(/[.,]/g, ''));
  } else {
    return refuse('amount.grouping');
  }
  if (value === 0n) return refuse('amount.zero');
  if (value > LARGEST_SAFE) return refuse('amount.tooLarge', { max: formatCoins(max) });
  return { ok: true, amount: Number(value), keyword: null };
}

/** One amount as SPEC §4 describes it, in integer arithmetic. Never throws. */
export function parseAmount(input: string, context: AmountContext): ParsedAmount {
  const text = input.trim().toLowerCase();
  if (text === '') return refuse('amount.empty');
  const keyword = amountKeyword(text);
  if (keyword !== null) return resolveKeyword(keyword, context);
  const unsigned = text.startsWith('-') ? text.slice(1) : text;
  if (!/^[\d.,]+[km]?$/.test(unsigned) || !/\d/.test(unsigned)) return refuse('amount.invalid');
  if (unsigned !== text) return refuse('amount.negative');
  return parseNumber(text, context.max);
}

/** Why a round's stake is outside the limits, or null when it's within them. */
export function stakeLimitError(stake: number, limits: StakeLimits): Message | null {
  if (stake < limits.min) {
    return ['amount.belowMinimum', { stake: formatCoins(stake), min: formatCoins(limits.min) }];
  }
  if (stake > limits.max) {
    return ['amount.aboveMaximum', { stake: formatCoins(stake), max: formatCoins(limits.max) }];
  }
  return null;
}
