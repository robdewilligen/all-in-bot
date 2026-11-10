/** Discord's maximum length of an autocomplete choice's name and of its value. */
export const CHOICE_LIMIT = 100;

const graphemes = new Intl.Segmenter('en', { granularity: 'grapheme' });

/** Shortens text to the choice limit between graphemes, so no emoji is cut in half. */
export function clipChoice(text: string): string {
  if (text.length <= CHOICE_LIMIT) return text;
  let kept = '';
  for (const { segment } of graphemes.segment(text)) {
    if (kept.length + segment.length >= CHOICE_LIMIT) break;
    kept += segment;
  }
  return `${kept.trimEnd()}…`;
}
