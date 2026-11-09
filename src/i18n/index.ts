import { en } from './en.js';

type Leaves<T, Prefix extends string = ''> = {
  [K in keyof T & string]: T[K] extends string ? `${Prefix}${K}` : Leaves<T[K], `${Prefix}${K}.`>;
}[keyof T & string];

/** Every message key, as a dotted path into en.ts. */
export type MessageKey = Leaves<typeof en>;

type At<T, Path extends string> = Path extends `${infer Head}.${infer Rest}`
  ? Head extends keyof T
    ? At<T[Head], Rest>
    : never
  : Path extends keyof T
    ? T[Path]
    : never;

type Placeholders<Text> = Text extends `${string}{${infer Name}}${infer Rest}`
  ? Name | Placeholders<Rest>
  : never;

type Values = Readonly<Record<string, string | number>>;

export type MessageParams<K extends MessageKey> = Readonly<
  Record<Placeholders<At<typeof en, K>>, string | number>
>;

/** What follows the key: nothing for a message without placeholders, otherwise its values. */
export type ParamArgs<K extends MessageKey> = [Placeholders<At<typeof en, K>>] extends [never]
  ? []
  : [params: MessageParams<K>];

/** A key with its values, for carrying a message around (for example in a PlayerError). */
export type Message = { [K in MessageKey]: [key: K, ...params: ParamArgs<K>] }[MessageKey];

type Catalog<T> = { readonly [K in keyof T]: T[K] extends string ? string : Catalog<T[K]> };

/** The shape another language's catalog must have. */
export type Messages = Catalog<typeof en>;

const catalogs: Readonly<Partial<Record<string, Messages>>> = { en };

function catalogFor(locale: string): Messages {
  return catalogs[locale] ?? catalogs[locale.split('-')[0] ?? ''] ?? en;
}

function lookup(catalog: Messages, key: string): string | undefined {
  let node: unknown = catalog;
  for (const part of key.split('.')) {
    if (typeof node !== 'object' || node === null) return undefined;
    node = (node as Record<string, unknown>)[part];
  }
  return typeof node === 'string' ? node : undefined;
}

function render(locale: string, key: string, values: Values = {}): string {
  const template = lookup(catalogFor(locale), key) ?? lookup(en, key);
  if (template === undefined) throw new Error(`Unknown message key: ${key}`);
  return template.replace(/\{(\w+)\}/g, (placeholder, name: string) => {
    const value = values[name];
    return value === undefined ? placeholder : String(value);
  });
}

/** The message for `key` in the interaction's locale, falling back to English. */
export function t<K extends MessageKey>(locale: string, key: K, ...params: ParamArgs<K>): string {
  return render(locale, key, (params as readonly Values[])[0]);
}

/** Like t, for a message that was built earlier (see Message). */
export function translate(locale: string, message: Message): string {
  const [key, values] = message as readonly [string, Values?];
  return render(locale, key, values);
}
