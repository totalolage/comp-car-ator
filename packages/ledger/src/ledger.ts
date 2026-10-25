import { DatabaseSync } from "node:sqlite";
import { createResolver } from "@cca/resolver";
import type { Checkpoint, SourceId } from "@cca/sources";
import {
  type CatalogVariant,
  type FxTable,
  generationIdOf,
  type IsoDate,
  type ListingSeen,
  type ListPrice,
  makeIdOf,
  modelIdOf,
  type Observation,
  pragueDate,
  type VariantFacts,
  type VariantSpec,
  variantIdOf,
} from "@cca/vocabulary";
import { migrate } from "./schema.ts";
import type { Ledger, LedgerListing, LedgerSnapshot, RunInfo, RunSummary } from "./types.ts";
import { invalidReason } from "./validate.ts";

const BATCH = 500;
/** A listing missed by this many consecutive complete full runs is gone. */
const MISSES_TO_GONE = 2;
const MAX_REJECTIONS_REPORTED = 50;

type ListingData = Omit<ListingSeen, "kind" | "ref">;

/** Opens (and migrates) a Ledger. Use ":memory:" in tests. */
export function openLedger(path: string): Ledger {
  const db = new DatabaseSync(path);
  // Rollback journal (not WAL): the file is uploaded as one release asset after each run.
  db.exec("PRAGMA foreign_keys = ON;");
  migrate(db);

  const q = {
    insertRun: db.prepare(
      "INSERT INTO runs (source, mode, scope, started_at, status) VALUES (?, ?, ?, ?, 'running') RETURNING id",
    ),
    finishRun: db.prepare("UPDATE runs SET status = ? WHERE id = ?"),
    lastCompleteRun: db.prepare(
      "SELECT max(started_at) AS at FROM runs WHERE source = ? AND scope = ? AND status = 'complete'",
    ),
    // Full runs after this id belong to the scope's current census.
    lastCompleteFullRun: db.prepare(
      `SELECT coalesce(max(id), 0) AS id FROM runs
       WHERE source = ? AND scope = ? AND mode = 'full' AND status = 'complete'`,
    ),
    sliceDoneAt: db.prepare(
      `SELECT max(r.started_at) AS at FROM slices s JOIN runs r ON r.id = s.run
       WHERE r.source = ? AND r.scope = ? AND r.mode = 'full' AND r.id > ? AND s.slice = ?`,
    ),
    insertSlice: db.prepare("INSERT OR IGNORE INTO slices (run, slice) VALUES (?, ?)"),
    isKnown: db.prepare("SELECT 1 FROM listings WHERE id = ? AND gone IS NULL"),
    upsertFx: db.prepare(
      `INSERT INTO fx_rates (currency, valid_for, czk_per_unit) VALUES (?, ?, ?)
       ON CONFLICT (currency, valid_for) DO UPDATE SET czk_per_unit = excluded.czk_per_unit`,
    ),
    getListing: db.prepare("SELECT price_amount, price_currency FROM listings WHERE id = ?"),
    insertListing: db.prepare(
      `INSERT INTO listings (id, source, ref, scope, data, price_amount, price_currency, first_seen, last_seen, last_seen_run)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ),
    updateListing: db.prepare(
      `UPDATE listings SET scope = ?, data = ?, price_amount = ?, price_currency = ?, last_seen = ?, last_seen_run = ?,
         missed_full_runs = 0, first_missed = NULL, last_missed = NULL, gone = NULL
       WHERE id = ?`,
    ),
    upsertHistory: db.prepare(
      `INSERT INTO price_history (listing_id, date, amount, currency) VALUES (?, ?, ?, ?)
       ON CONFLICT (listing_id, date) DO UPDATE SET amount = excluded.amount, currency = excluded.currency`,
    ),
    markGone: db.prepare("UPDATE listings SET gone = ? WHERE id = ? AND gone IS NULL"),
    // Missed: not seen by any run of the census (full runs since the last complete one, so
    // slices done by a failed run and skipped by this one count as seen). A listing misses
    // at most once per day, so re-recording a full run cannot double-count.
    countMissed: db.prepare(
      `UPDATE listings SET missed_full_runs = missed_full_runs + 1,
         first_missed = coalesce(first_missed, :day), last_missed = :day
       WHERE source = :source AND scope = :scope AND gone IS NULL
         AND last_seen_run < (
           SELECT min(id) FROM runs WHERE source = :source AND scope = :scope AND mode = 'full'
             AND id > :after)
         AND (last_missed IS NULL OR last_missed < :day)`,
    ),
    goneAfterMisses: db.prepare(
      `UPDATE listings SET gone = first_missed
       WHERE source = :source AND scope = :scope AND gone IS NULL AND missed_full_runs >= :misses`,
    ),
    upsertCatalog: db.prepare(
      `INSERT INTO catalog_entries (variant_id, source, data, updated) VALUES (?, ?, ?, ?)
       ON CONFLICT (variant_id, source) DO UPDATE SET data = excluded.data, updated = excluded.updated`,
    ),
    upsertFacts: db.prepare(
      `INSERT INTO variant_facts (source, key, data, updated) VALUES (?, ?, ?, ?)
       ON CONFLICT (source, key) DO UPDATE SET data = excluded.data, updated = excluded.updated`,
    ),
    listPricesOf: db.prepare(
      "SELECT ref, data FROM list_prices WHERE source = ? ORDER BY ref, valid_from",
    ),
    upsertListPrice: db.prepare(
      `INSERT INTO list_prices (source, ref, valid_from, data) VALUES (?, ?, ?, ?)
       ON CONFLICT (source, ref, valid_from) DO UPDATE SET data = excluded.data`,
    ),
  };

  function recordOne(
    o: Observation,
    run: RunInfo & { scope: string },
    runId: number,
    day: IsoDate,
    summary: RunSummary,
  ) {
    switch (o.kind) {
      case "FxRate":
        q.upsertFx.run(o.currency, o.validFor, o.czkPerUnit);
        break;
      case "ListingSeen": {
        const id = `${run.source}:${o.ref}`;
        const { kind: _kind, ref: _ref, ...data } = o;
        const existing = q.getListing.get(id) as
          | { price_amount: number; price_currency: string }
          | undefined;
        if (!existing) {
          q.insertListing.run(
            id,
            run.source,
            o.ref,
            run.scope,
            JSON.stringify(data),
            o.price.amount,
            o.price.currency,
            day,
            day,
            runId,
          );
          q.upsertHistory.run(id, day, o.price.amount, o.price.currency);
          summary.newListings++;
        } else {
          q.updateListing.run(
            run.scope,
            JSON.stringify(data),
            o.price.amount,
            o.price.currency,
            day,
            runId,
            id,
          );
          if (
            existing.price_amount !== o.price.amount ||
            existing.price_currency !== o.price.currency
          ) {
            q.upsertHistory.run(id, day, o.price.amount, o.price.currency);
            summary.priceChanges++;
          }
        }
        break;
      }
      case "ListingGone":
        summary.gone += Number(q.markGone.run(day, `${run.source}:${o.ref}`).changes);
        break;
      case "CatalogEntry":
        q.upsertCatalog.run(variantIdOf(o.variant), run.source, JSON.stringify(o.variant), day);
        break;
      case "VariantFacts":
        q.upsertFacts.run(run.source, JSON.stringify(o.vehicle), JSON.stringify(o), day);
        break;
      case "SliceDone":
        q.insertSlice.run(runId, o.slice);
        break;
      case "ListPrice": {
        const { kind: _kind, ref: _ref, ...data } = o;
        q.upsertListPrice.run(run.source, o.ref, o.validFrom, JSON.stringify(data));
        break;
      }
    }
    summary.recorded[o.kind] = (summary.recorded[o.kind] ?? 0) + 1;
  }

  function catalog(): CatalogVariant[] {
    const rows = db
      .prepare("SELECT variant_id, data FROM catalog_entries ORDER BY variant_id, updated, source")
      .all() as { variant_id: string; data: string }[];
    const merged = new Map<string, VariantSpec>();
    for (const row of rows) {
      // Field-level merge; later updates win. TODO(wave1-stream8): per-field source priority.
      const spec = JSON.parse(row.data) as VariantSpec;
      const earlier = merged.get(row.variant_id);
      // Gearboxes accumulate: each Source states the ones it offers.
      const transmissions = [
        ...new Set([...(earlier?.transmissions ?? []), ...(spec.transmissions ?? [])]),
      ].sort();
      merged.set(row.variant_id, {
        ...earlier,
        ...defined(spec),
        ...(transmissions.length > 0 ? { transmissions } : {}),
      } as VariantSpec);
    }
    const variants: CatalogVariant[] = [...merged].map(([id, spec]) => ({
      ...spec,
      id,
      makeId: makeIdOf(spec.make),
      modelId: modelIdOf(spec.make, spec.model),
      generationId: generationIdOf(spec),
    }));

    // Partial evidence fills Specs the CatalogEntries left empty, on Variants it resolves to.
    const byId = new Map(variants.map((v) => [v.id, v]));
    const resolver = createResolver(variants);
    const facts = db
      .prepare("SELECT source, data FROM variant_facts ORDER BY updated, source, key")
      .all() as { source: string; data: string }[];
    for (const row of facts) {
      const fact = JSON.parse(row.data) as VariantFacts;
      const resolution = resolver.resolve(fact.vehicle, row.source);
      if (resolution.status !== "matched") continue;
      const variant = byId.get(resolution.variantId) as CatalogVariant;
      for (const [field, value] of Object.entries(fact.facts)) {
        const target = variant as unknown as Record<string, unknown>;
        if (target[field] === undefined && value !== undefined) target[field] = value;
      }
    }
    return variants;
  }

  return {
    checkpoint(source: SourceId, scope = "all"): Checkpoint {
      const row = q.lastCompleteRun.get(source, scope) as { at: string | null };
      const census = q.lastCompleteFullRun.get(source, scope) as { id: number };
      return {
        lastRunAt: row.at ? new Date(row.at) : null,
        isKnown: (ref) => q.isKnown.get(`${source}:${ref}`) !== undefined,
        sliceDoneAt: (slice) => {
          const done = q.sliceDoneAt.get(source, scope, census.id, slice) as { at: string | null };
          return done.at ? new Date(done.at) : null;
        },
        offersInForce: () => {
          const latest = new Map<string, ListPrice>();
          for (const row of q.listPricesOf.all(source) as { ref: string; data: string }[]) {
            const data = JSON.parse(row.data) as Omit<ListPrice, "kind" | "ref">;
            latest.set(row.ref, { kind: "ListPrice", ref: row.ref, ...data });
          }
          return [...latest.values()].filter((edition) => edition.validTo === undefined);
        },
      };
    },

    async record(run, observations) {
      const scope = run.scope ?? "all";
      const { id: censusAfter } = q.lastCompleteFullRun.get(run.source, scope) as { id: number };
      const { id: runId } = q.insertRun.get(
        run.source,
        run.mode,
        scope,
        run.startedAt.toISOString(),
      ) as { id: number };
      const day = pragueDate(run.startedAt);
      const summary: RunSummary = {
        recorded: {},
        rejected: [],
        newListings: 0,
        priceChanges: 0,
        gone: 0,
        census: "not-full",
      };
      let rejectedTotal = 0;
      // Observations since the previous SliceDone belong to the next one. A slice that had a
      // rejection stays not done for the rest of the run, even if its SliceDone repeats.
      let rejectedInSlice = false;
      const tainted = new Set<string>();
      let open = false;
      let pending = 0;
      const begin = () => {
        if (!open) db.exec("BEGIN");
        open = true;
      };
      const commit = () => {
        if (open) db.exec("COMMIT");
        open = false;
        pending = 0;
      };

      try {
        for await (const observation of observations) {
          let reason = invalidReason(observation);
          if (observation.kind === "SliceDone") {
            if (rejectedInSlice) tainted.add(observation.slice);
            if (!reason && tainted.has(observation.slice)) {
              reason = "slice had rejected observations, so it is not done";
            }
            rejectedInSlice = false;
          } else if (reason) {
            rejectedInSlice = true;
          }
          if (reason) {
            rejectedTotal++;
            if (summary.rejected.length < MAX_REJECTIONS_REPORTED) {
              summary.rejected.push({ kind: String(observation?.kind), reason });
            }
            continue;
          }
          begin();
          recordOne(observation, { ...run, scope }, runId, day, summary);
          if (++pending >= BATCH) commit();
        }
        commit();
      } catch (error) {
        commit();
        q.finishRun.run("failed", runId);
        throw error;
      }

      begin();
      if (run.mode === "full" && rejectedTotal > 0) summary.census = "skipped-rejections";
      if (run.mode === "full" && rejectedTotal === 0) {
        summary.census = "applied";
        q.countMissed.run({ day, source: run.source, scope, after: censusAfter });
        summary.gone += Number(
          q.goneAfterMisses.run({ source: run.source, scope, misses: MISSES_TO_GONE }).changes,
        );
      }
      q.finishRun.run("complete", runId);
      commit();
      return summary;
    },

    snapshot(): LedgerSnapshot {
      const variants = catalog();
      const resolver = createResolver(variants);
      const historyOf = db.prepare(
        "SELECT date, amount, currency FROM price_history WHERE listing_id = ? ORDER BY date",
      );
      const listPrices = (
        db
          .prepare("SELECT source, ref, data FROM list_prices ORDER BY source, ref, valid_from")
          .all() as { source: string; ref: string; data: string }[]
      ).map((row) => {
        const data = JSON.parse(row.data) as Omit<ListPrice, "kind" | "ref">;
        return {
          ...data,
          offer: `${row.source}:${row.ref}`,
          resolution: resolver.resolve(data.vehicle, row.source),
        };
      });

      return {
        fx: latestFx(db),
        sources: (
          db
            .prepare(
              `SELECT source, max(CASE WHEN status = 'complete' THEN started_at END) AS at
               FROM runs GROUP BY source ORDER BY source`,
            )
            .all() as { source: string; at: string | null }[]
        ).map((row) => ({ id: row.source, lastRunAt: row.at ? new Date(row.at) : null })),
        catalog: variants,
        listPrices,
        *listings(): Iterable<LedgerListing> {
          const rows = db
            .prepare(
              "SELECT id, source, ref, data, first_seen, last_seen, gone FROM listings ORDER BY id",
            )
            .iterate() as Iterable<{
            id: string;
            source: string;
            ref: string;
            data: string;
            first_seen: string;
            last_seen: string;
            gone: string | null;
          }>;
          for (const row of rows) {
            const data = JSON.parse(row.data) as ListingData;
            const history = historyOf.all(row.id) as {
              date: string;
              amount: number;
              currency: string;
            }[];
            yield {
              ...data,
              id: row.id,
              source: row.source,
              ref: row.ref,
              firstSeen: row.first_seen,
              lastSeen: row.last_seen,
              gone: row.gone,
              priceHistory: history.map((h) => ({
                date: h.date,
                price: { amount: h.amount, currency: h.currency },
              })),
              resolution: resolver.resolve(data.vehicle, row.source),
            };
          }
        },
      };
    },

    close() {
      db.close();
    },
  };
}

function latestFx(db: DatabaseSync): FxTable {
  const rows = db
    .prepare(
      `SELECT currency, valid_for, czk_per_unit FROM fx_rates f
       WHERE valid_for = (SELECT max(valid_for) FROM fx_rates WHERE currency = f.currency)
       ORDER BY currency`,
    )
    .all() as { currency: string; valid_for: string; czk_per_unit: number }[];
  return Object.fromEntries(
    rows.map((r) => [r.currency, { czkPerUnit: r.czk_per_unit, validFor: r.valid_for }]),
  );
}

function defined<T extends object>(value: T): Partial<T> {
  return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)) as Partial<T>;
}
