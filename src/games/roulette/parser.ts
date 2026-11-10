import { parseAmount, type AmountContext, type AmountKeyword } from '../../core/amount.js';
import { formatCoins } from '../../i18n/format.js';
import type { Message } from '../../i18n/index.js';
import { announcedBetByLabel, neighbours, type AnnouncedBet } from './announced.js';
import { tableBetByLabel, tableBetFor, type TableBet } from './table.js';
import type { RouletteBet } from './types.js';

export type ParsedBets =
  | { readonly ok: true; readonly bets: RouletteBet[] }
  | { readonly ok: false; readonly error: Message };

interface Failure {
  readonly ok: false;
  readonly error: Message;
}

type Result<T> = { readonly ok: true; readonly value: T } | Failure;

type Spot =
  | { readonly type: 'table'; readonly bet: TableBet }
  | { readonly type: 'announced'; readonly bet: AnnouncedBet };

interface Amount {
  readonly text: string;
  readonly amount: number;
  readonly keyword: AmountKeyword | null;
}

/** One `amount:spot` as typed; `amount` is null when the text has no colon. */
interface RawBet {
  readonly text: string;
  readonly amount: string | null;
  readonly spots: string;
}

const DEFAULT_MAX_BETS = 30;

const fail = (...error: Message): Failure => ({ ok: false, error });

const SPOT_NAMES: Readonly<Record<string, readonly string[]>> = {
  red: ['red', 'rouge', 'rood'],
  black: ['black', 'noir', 'zwart'],
  even: ['even', 'pair'],
  odd: ['odd', 'impair', 'oneven'],
  low: ['low', 'manque', 'laag'],
  high: ['high', 'passe', 'hoog'],
  d1: ['d1', '1st12'],
  d2: ['d2', '2nd12'],
  d3: ['d3', '3rd12'],
  c1: ['c1', 'k1'],
  c2: ['c2', 'k2'],
  c3: ['c3', 'k3'],
};

const labelByName: ReadonlyMap<string, string> = new Map(
  Object.entries(SPOT_NAMES).flatMap(([label, names]) =>
    names.map((name): [string, string] => [name, label]),
  ),
);

const SEPARATOR = /[\s,;]/;
const AMOUNT_END = /[\s;:]/;
const NUMBER = /^(?:0|[1-9]\d*)$/;
const RANGE = /^(\d+)-(\d+)$/;
const SINGLE_OR_SET = /^\d+(?:\/\d+)*$/;
const NEIGHBOURS = /^n(\d+)$/;

/**
 * Parses a `/roulette` bets string, such as `10:17, 2,500:red; 5:7+17+27 18:voisins`, into bets.
 * Amounts resolve against `amounts`. At most `maxBets` per command, an announced bet counting as
 * one; the stake limits and the total per spin are up to the round.
 */
export function parseBets(
  input: string,
  amounts: AmountContext,
  maxBets: number = DEFAULT_MAX_BETS,
): ParsedBets {
  const raw = splitBets(input.replace(/\s*([:+/-])\s*/g, '$1'));
  if (raw.length === 0) return fail('rouletteNotation.empty');

  const bets: RouletteBet[] = [];
  for (const { text, amount: amountText, spots } of raw) {
    if (amountText === null) return fail('rouletteNotation.notABet', { text });
    if (amountText === '') return fail('rouletteNotation.missingAmount', { bet: text });
    const spotTexts = spots.split('+');
    if (spotTexts.includes('')) return fail('rouletteNotation.missingSpot', { bet: text });

    const parsed = parseAmount(amountText, amounts);
    if (!parsed.ok) return parsed;
    const amount: Amount = { text: amountText, amount: parsed.amount, keyword: parsed.keyword };

    for (const spotText of spotTexts) {
      const spot = resolveSpot(spotText);
      if (!spot.ok) return spot;
      const bet = place(spot.value, amount);
      if (!bet.ok) return bet;
      bets.push(bet.value);
    }
  }

  const count = bets.reduce((sum, bet) => sum + bet.countsAs, 0);
  if (count > maxBets) return fail('rouletteNotation.tooManyBets', { count, max: maxBets });
  return { ok: true, bets };
}

// An amount runs up to its colon and may hold a comma (`2,500`); a spot ends at the first separator.
function splitBets(input: string): RawBet[] {
  const raw: RawBet[] = [];
  let i = 0;
  while (i < input.length) {
    if (SEPARATOR.test(input.charAt(i))) {
      i++;
      continue;
    }
    const start = i;
    while (i < input.length && !AMOUNT_END.test(input.charAt(i))) i++;
    if (input.charAt(i) !== ':') {
      raw.push({ text: input.slice(start, i).replace(/,+$/, ''), amount: null, spots: '' });
      continue;
    }
    const colon = i;
    i++;
    while (i < input.length && !SEPARATOR.test(input.charAt(i))) i++;
    raw.push({
      text: input.slice(start, i),
      amount: input.slice(start, colon),
      spots: input.slice(colon + 1, i),
    });
  }
  return raw;
}

function resolveSpot(spot: string): Result<Spot> {
  const text = spot.toLowerCase();

  const label = labelByName.get(text);
  const named = label === undefined ? undefined : tableBetByLabel(label);
  if (named !== undefined) return { ok: true, value: { type: 'table', bet: named } };

  const announced = announcedBetByLabel(text);
  if (announced !== undefined) return { ok: true, value: { type: 'announced', bet: announced } };

  const neighbour = NEIGHBOURS.exec(text);
  if (neighbour !== null) {
    const n = parseNumber(neighbour[1] ?? '', spot);
    return n.ok ? { ok: true, value: { type: 'announced', bet: neighbours(n.value) } } : n;
  }

  const numbers = numbersOf(text, spot);
  if (!numbers.ok) return numbers;
  const bet = tableBetFor(numbers.value);
  if (bet === undefined) return fail('rouletteNotation.notOnTable', { spot });
  return { ok: true, value: { type: 'table', bet } };
}

/** The numbers a numeric spot covers: `17`, a range `a-b` or a set `a/b/c`. */
function numbersOf(text: string, spot: string): Result<number[]> {
  const range = RANGE.exec(text);
  let parts: string[];
  if (range !== null) parts = range.slice(1);
  else if (SINGLE_OR_SET.test(text)) parts = text.split('/');
  else return fail('rouletteNotation.unknownSpot', { spot });

  const numbers: number[] = [];
  for (const part of parts) {
    const n = parseNumber(part, spot);
    if (!n.ok) return n;
    numbers.push(n.value);
  }

  if (range !== null) {
    const from = Math.min(...numbers);
    const to = Math.max(...numbers);
    return { ok: true, value: Array.from({ length: to - from + 1 }, (_, i) => from + i) };
  }
  const repeated = numbers.find((n, i) => numbers.indexOf(n) !== i);
  if (repeated !== undefined) {
    return fail('rouletteNotation.repeatedNumber', { spot, number: repeated });
  }
  return { ok: true, value: numbers };
}

function parseNumber(text: string, spot: string): Result<number> {
  if (!NUMBER.test(text)) return fail('rouletteNotation.unknownSpot', { spot });
  const n = Number(text);
  if (n > 36) return fail('rouletteNotation.numberOutOfRange', { number: text });
  return { ok: true, value: n };
}

function place(spot: Spot, amount: Amount): Result<RouletteBet> {
  if (spot.type === 'table') {
    const { kind, label, numbers } = spot.bet;
    const chips = [{ numbers, amount: amount.amount }];
    return { ok: true, value: { label, kind, chips, amount: amount.amount, countsAs: 1 } };
  }

  const { kind, label } = spot.bet;
  const chipCount = spot.bet.chips.length;
  const remainder = amount.amount % chipCount;
  if (remainder !== 0 && amount.keyword === null) {
    const example = Math.max(chipCount, amount.amount - remainder);
    return fail('rouletteNotation.announcedMultiple', { bet: label, chips: chipCount, example });
  }
  const total = amount.amount - remainder;
  if (total === 0) {
    return fail('rouletteNotation.announcedTooSmall', {
      amount: amount.text,
      coins: formatCoins(amount.amount),
      chips: chipCount,
      bet: label,
    });
  }
  const chips = spot.bet.chips.map((numbers) => ({ numbers, amount: total / chipCount }));
  return { ok: true, value: { label, kind, chips, amount: total, countsAs: 1 } };
}
