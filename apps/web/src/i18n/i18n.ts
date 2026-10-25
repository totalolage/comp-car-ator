/**
 * Everything locale-dependent the UI prints: strings with `{var}` interpolation, Czech and
 * English plurals, enum labels, and number, money, unit and date formats. Pages and islands
 * call `i18n(lang)` and never touch `Intl` or the catalogs directly, so a missing value
 * prints the same dash everywhere and Czech spacing rules stay in one place.
 */
import {
  type Lang,
  label,
  localePath,
  type MessageKey,
  messages,
  numberLocale,
} from "./messages.ts";

/** Printed for a missing value. */
export const MISSING = "–";

/** Counted nouns: `count.<noun>.one|few|other` in the catalogs, e.g. "count.listings". */
export type PluralKey = PluralBase<MessageKey>;
type PluralBase<K> = K extends `count.${infer P}.other` ? `count.${P}` : never;

export interface I18n {
  lang: Lang;
  t(key: MessageKey, vars?: Record<string, string | number>): string;
  /** The plural form for `n`, with `{n}` formatted: count("count.listings", 3) → "3 inzeráty". */
  count(key: PluralKey, n: number): string;
  /** Label for a vocabulary value (`fuel`, `body`, `market`…), falling back to the raw value. */
  label(facet: string, value: string): string;
  /** Whole crowns: "259 000 Kč" / "CZK 259,000". */
  czk(amount: number | null | undefined): string;
  /** An amount in its own currency, whole units: "12 345 €" / "€12,345". */
  money(amount: number | null | undefined, currency: string): string;
  number(n: number | null | undefined, maxFractionDigits?: number): string;
  km(n: number | null | undefined): string;
  kw(n: number | null | undefined): string;
  /** Litres per 100 km, one decimal. */
  l100(n: number | null | undefined): string;
  /** Calendar date in Prague time: "24. 10. 2026" / "24 Oct 2026". */
  date(iso: string | null | undefined): string;
  /** Site path in this locale: "/model/x/" → "/en/model/x/" for English. */
  path(path: string): string;
}

const cache = new Map<Lang, I18n>();

export function i18n(lang: Lang): I18n {
  let made = cache.get(lang);
  if (!made) {
    made = create(lang);
    cache.set(lang, made);
  }
  return made;
}

function create(lang: Lang): I18n {
  const m = messages(lang) as Record<string, string>;
  const locale = numberLocale(lang);
  const plural = new Intl.PluralRules(lang);
  const numbers = new Map<number, Intl.NumberFormat>();
  const num = (digits: number) => {
    let f = numbers.get(digits);
    if (!f) {
      f = new Intl.NumberFormat(locale, { maximumFractionDigits: digits });
      numbers.set(digits, f);
    }
    return f;
  };
  const currencies = new Map<string, Intl.NumberFormat>();
  const cur = (currency: string) => {
    let f = currencies.get(currency);
    if (!f) {
      f = new Intl.NumberFormat(locale, { style: "currency", currency, maximumFractionDigits: 0 });
      currencies.set(currency, f);
    }
    return f;
  };
  const dates = new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeZone: "Europe/Prague" });
  const ok = (n: number | null | undefined): n is number =>
    typeof n === "number" && Number.isFinite(n);
  const interpolate = (text: string, vars?: Record<string, string | number>) =>
    vars ? text.replace(/\{(\w+)\}/g, (all, name: string) => String(vars[name] ?? all)) : text;

  return {
    lang,
    t: (key, vars) => interpolate(m[key] ?? key, vars),
    count(key, n) {
      const form = m[`${key}.${plural.select(n)}`] ?? m[`${key}.other`] ?? key;
      return interpolate(form, { n: num(0).format(n) });
    },
    label: (facet, value) => label(m as never, facet, value),
    czk: (n) => (ok(n) ? cur("CZK").format(n) : MISSING),
    money: (n, currency) => (ok(n) ? cur(currency).format(n) : MISSING),
    number: (n, digits = 0) => (ok(n) ? num(digits).format(n) : MISSING),
    km: (n) => (ok(n) ? `${num(0).format(n)}\u00a0km` : MISSING),
    kw: (n) => (ok(n) ? `${num(0).format(n)}\u00a0kW` : MISSING),
    l100: (n) => (ok(n) ? `${num(1).format(n)}\u00a0l/100\u00a0km` : MISSING),
    date(iso) {
      if (!iso) return MISSING;
      const d = new Date(iso);
      return Number.isNaN(d.getTime()) ? MISSING : dates.format(d);
    },
    path: (p) => localePath(lang, p),
  };
}
