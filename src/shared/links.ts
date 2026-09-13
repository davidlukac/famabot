/**
 * Pull off-platform URLs out of a listing's free text. Used wherever a listing
 * gets shown or evaluated — the evaluator, the browse/report views, and the
 * `show` CLI command all want the same "what did the seller link to" signal.
 */
export function extractExternalLinks(text: string | null | undefined): string[] {
  if (!text) return [];
  const found = text.match(/https?:\/\/[^\s)"']+/gi) ?? [];
  return [...new Set(found)].filter((u) => !/facebook\.com|fbcdn\.net|fb\.me/i.test(u));
}
