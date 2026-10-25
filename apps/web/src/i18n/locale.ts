/**
 * Locales and their URL prefixes, kept apart from the message catalogs so code that only
 * builds links (scripts/shell.ts) does not ship every string.
 */
export const LANGS = ["cs", "en"] as const;
export type Lang = (typeof LANGS)[number];

/** Czech is the default locale and has no prefix. */
export function localePath(lang: Lang, path: string): string {
  return lang === "cs" ? path : `/en${path}`;
}

export function numberLocale(lang: Lang): string {
  return lang === "cs" ? "cs-CZ" : "en-GB";
}
