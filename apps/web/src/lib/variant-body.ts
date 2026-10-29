/**
 * A Variant's body as people call it. The register files a liftback under the sedan or the
 * hatchback code, often both within one generation (the Resolver's LIFTBACKS lets a listing's
 * "sedan" or "hatchback" match either), so tables and names say "liftback (sedan)": what the
 * car is, then the code that tells such Variants apart and that the body facet filters on.
 * Display only: the Variant's body and id keep the register's code. The Superb I (3U) is a
 * real sedan. The Arteon is left out: its Shooting Brake shares the hatchback code.
 */
import type { VariantRow } from "@cca/bundle";
import type { I18n } from "../i18n/i18n.ts";

const LIFTBACKS = new Set([
  "skoda/octavia",
  "skoda/superb",
  "audi/a5",
  "audi/s5",
  "audi/rs5",
  "audi/a7",
  "audi/s7",
  "audi/rs7",
]);

export function bodyLabel(v: Pick<VariantRow, "modelId" | "generationId" | "body">, t: I18n) {
  const code = t.label("body", v.body);
  const liftback =
    LIFTBACKS.has(v.modelId) &&
    v.generationId !== "skoda/superb/3u" &&
    (v.body === "sedan" || v.body === "hatchback");
  return liftback ? t.t("body.liftback", { body: code }) : code;
}
