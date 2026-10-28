import type { DatabaseSync } from "node:sqlite";
import { TIPCARS_EUR_PRICES } from "./tipcars-eur-refs.ts";

/**
 * Ordered migrations; index + 1 is the schema version. Append only: never edit a
 * migration that has shipped, since Ledger files persist across runs (GitHub releases).
 */
const MIGRATIONS: string[] = [
  `
  CREATE TABLE runs (
    id INTEGER PRIMARY KEY,
    source TEXT NOT NULL,
    mode TEXT NOT NULL CHECK (mode IN ('incremental', 'full')),
    scope TEXT NOT NULL,
    started_at TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('running', 'complete', 'failed'))
  );
  CREATE INDEX runs_source ON runs (source, status, started_at);

  CREATE TABLE fx_rates (
    currency TEXT NOT NULL,
    valid_for TEXT NOT NULL,
    czk_per_unit REAL NOT NULL,
    PRIMARY KEY (currency, valid_for)
  );

  CREATE TABLE listings (
    id TEXT PRIMARY KEY,
    source TEXT NOT NULL,
    ref TEXT NOT NULL,
    scope TEXT NOT NULL,
    data TEXT NOT NULL,
    price_amount REAL NOT NULL,
    price_currency TEXT NOT NULL,
    first_seen TEXT NOT NULL,
    last_seen TEXT NOT NULL,
    last_seen_run INTEGER NOT NULL,
    missed_full_runs INTEGER NOT NULL DEFAULT 0,
    first_missed TEXT,
    last_missed TEXT,
    gone TEXT
  );
  CREATE INDEX listings_source ON listings (source, scope, gone);

  CREATE TABLE price_history (
    listing_id TEXT NOT NULL REFERENCES listings (id),
    date TEXT NOT NULL,
    amount REAL NOT NULL,
    currency TEXT NOT NULL,
    PRIMARY KEY (listing_id, date)
  );

  CREATE TABLE catalog_entries (
    variant_id TEXT NOT NULL,
    source TEXT NOT NULL,
    data TEXT NOT NULL,
    updated TEXT NOT NULL,
    PRIMARY KEY (variant_id, source)
  );

  CREATE TABLE variant_facts (
    source TEXT NOT NULL,
    key TEXT NOT NULL,
    data TEXT NOT NULL,
    updated TEXT NOT NULL,
    PRIMARY KEY (source, key)
  );

  -- Slices a run reported done (SliceDone); full runs since the scope's last complete full
  -- run form the current census, and its done slices may be skipped.
  CREATE TABLE slices (
    run INTEGER NOT NULL REFERENCES runs (id),
    slice TEXT NOT NULL,
    PRIMARY KEY (run, slice)
  );

  CREATE TABLE list_prices (
    source TEXT NOT NULL,
    ref TEXT NOT NULL,
    valid_from TEXT NOT NULL,
    data TEXT NOT NULL,
    PRIMARY KEY (source, ref, valid_from)
  );
  `,
  // Catalog census: entries a Source's applied full census did not state are retired.
  `
  ALTER TABLE catalog_entries ADD COLUMN scope TEXT NOT NULL DEFAULT 'all';
  ALTER TABLE catalog_entries ADD COLUMN last_seen_run INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE catalog_entries ADD COLUMN retired TEXT;
  `,
  // Entries recorded before CatalogEntry required a slug per id part ("lada-vaz//2111/...").
  `
  DELETE FROM catalog_entries WHERE variant_id LIKE '/%' OR variant_id LIKE '%//%';
  `,
  // TipCars listings recorded with their EUR price labelled CZK, before the adapter read a
  // listing's currency from its record (2026-10-28).
  relabelEur("tipcars", TIPCARS_EUR_PRICES, "2026-10-28"),
];

/**
 * Relabels as EUR the CZK prices a Source recorded for these refs before `fixed`, the day
 * its adapter learned their currency, where the amount is the EUR amount confirmed on the
 * site: a price at any other amount may have been CZK and stays (one at that amount is taken
 * as EUR, as the stored row cannot tell otherwise). What it recorded since is left alone (a
 * listing seen since is priced right), and a point that now repeats the relabelled one before
 * it goes, so a listing re-seen in EUR before this ran keeps no change that never happened.
 */
function relabelEur(
  source: string,
  prices: readonly (readonly [ref: string, amountEur: number])[],
  fixed: string,
): string {
  const rows = prices.map(([ref, amount]) => {
    if (!/^\d+$/.test(ref)) throw new Error(`not a ${source} ref: ${ref}`);
    if (!Number.isFinite(amount)) throw new Error(`not an amount: ${amount}`);
    return `('${source}:${ref}', ${amount})`;
  });
  const confirmed = `(VALUES ${rows.join(", ")})`;
  return `
  UPDATE listings SET price_currency = 'EUR', data = json_set(data, '$.price.currency', 'EUR')
  WHERE (id, price_amount) IN ${confirmed} AND price_currency = 'CZK' AND last_seen < '${fixed}';
  UPDATE price_history SET currency = 'EUR'
  WHERE (listing_id, amount) IN ${confirmed} AND currency = 'CZK' AND date < '${fixed}';
  DELETE FROM price_history
  WHERE (listing_id, amount) IN ${confirmed} AND currency = 'EUR' AND EXISTS (
    SELECT 1 FROM price_history AS earlier
    WHERE earlier.listing_id = price_history.listing_id
      AND earlier.amount = price_history.amount AND earlier.currency = 'EUR'
      AND earlier.date < '${fixed}' AND earlier.date = (
        SELECT max(date) FROM price_history AS before
        WHERE before.listing_id = price_history.listing_id AND before.date < price_history.date));
  `;
}

export function migrate(db: DatabaseSync): void {
  db.exec("CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
  const row = db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get() as
    | { value: string }
    | undefined;
  const current = row ? Number(row.value) : 0;
  if (current > MIGRATIONS.length) {
    throw new Error(`Ledger schema v${current} is newer than this code (v${MIGRATIONS.length})`);
  }
  for (let version = current + 1; version <= MIGRATIONS.length; version++) {
    db.exec("BEGIN");
    try {
      db.exec(MIGRATIONS[version - 1] as string);
      db.prepare(
        "INSERT INTO meta (key, value) VALUES ('schema_version', ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value",
      ).run(String(version));
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  }
}
