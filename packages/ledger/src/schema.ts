import type { DatabaseSync } from "node:sqlite";

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

  CREATE TABLE list_prices (
    source TEXT NOT NULL,
    key TEXT NOT NULL,
    valid_from TEXT NOT NULL,
    data TEXT NOT NULL,
    PRIMARY KEY (source, key, valid_from)
  );
  `,
];

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
