import { DatabaseSync, type StatementSync } from "node:sqlite";
import { createResolver } from "@cca/resolver";
import type { Checkpoint, SourceId } from "@cca/sources";
import {
  type CatalogVariant,
  type FxTable,
  generationIdOf,
  type IsoDate,
  type ListingPriceSeen,
  type ListingSeen,
  type ListPrice,
  makeIdOf,
  modelIdOf,
  type Observation,
  type OpenpilotSupport,
  pragueDate,
  type VariantFacts,
  type VariantSpec,
  variantIdOf,
} from "@cca/vocabulary";
import { matchOpenpilot } from "./openpilot.ts";
import { migrate } from "./schema.ts";
import type { Ledger, LedgerListing, LedgerSnapshot, RunInfo, RunSummary } from "./types.ts";
import { invalidReason } from "./validate.ts";

const BATCH = 500;
/** A listing missed by this many censuses in a row, on different days, is gone. */
const MISSES_TO_GONE = 2;
/**
 * A census whose full runs span this many days and whose last two finished no slice gives way
 * to a new one: retried daily from a Sunday, it starts anew the next Sunday.
 */
const STALLED_CENSUS_DAYS = 6;
const DAY_MS = 86_400_000;
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
      "INSERT INTO runs (source, mode, scope, started_at, status, census) VALUES (?, ?, ?, ?, 'running', ?) RETURNING id",
    ),
    // A full run that starts a census is its first run.
    beginCensus: db.prepare("UPDATE runs SET census = id WHERE id = ?"),
    finishRun: db.prepare("UPDATE runs SET status = ? WHERE id = ?"),
    lastCompleteRun: db.prepare(
      "SELECT max(started_at) AS at FROM runs WHERE source = ? AND scope = ? AND status = 'complete'",
    ),
    latestFullRun: db.prepare(
      `SELECT status, census FROM runs WHERE source = ? AND scope = ? AND mode = 'full'
       ORDER BY id DESC LIMIT 1`,
    ),
    censusSpan: db.prepare(
      "SELECT min(started_at) AS first, max(started_at) AS last FROM runs WHERE census = ?",
    ),
    // How many slices the census's last two full runs finished.
    censusProgress: db.prepare(
      `SELECT count(DISTINCT r.id) AS runs, count(s.slice) AS done
       FROM (SELECT id FROM runs WHERE census = ? ORDER BY id DESC LIMIT 2) r
       LEFT JOIN slices s ON s.run = r.id`,
    ),
    sliceDoneAt: db.prepare(
      `SELECT max(r.started_at) AS at FROM slices s JOIN runs r ON r.id = s.run
       WHERE r.census = ? AND s.slice = ?`,
    ),
    insertSlice: db.prepare("INSERT OR IGNORE INTO slices (run, slice) VALUES (?, ?)"),
    deleteSlice: db.prepare("DELETE FROM slices WHERE run = ? AND slice = ?"),
    liveSliceOf: db.prepare("SELECT slice FROM listings WHERE id = ? AND gone IS NULL"),
    isKnown: db.prepare("SELECT 1 FROM listings WHERE id = ? AND gone IS NULL"),
    upsertFx: db.prepare(
      `INSERT INTO fx_rates (currency, valid_for, czk_per_unit) VALUES (?, ?, ?)
       ON CONFLICT (currency, valid_for) DO UPDATE SET czk_per_unit = excluded.czk_per_unit`,
    ),
    getListing: db.prepare("SELECT price_amount, price_currency FROM listings WHERE id = ?"),
    getLiveListing: db.prepare(
      "SELECT price_amount, price_currency FROM listings WHERE id = ? AND gone IS NULL",
    ),
    // A price-only sighting: the rest of the listing, and when it was last seen, stay.
    repriceListing: db.prepare(
      "UPDATE listings SET data = json_set(data, '$.price', json(?)), price_amount = ? WHERE id = ?",
    ),
    insertListing: db.prepare(
      `INSERT INTO listings (id, source, ref, scope, slice, data, price_amount, price_currency, first_seen, last_seen, last_seen_run)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ),
    updateListing: db.prepare(
      `UPDATE listings SET scope = ?, slice = coalesce(?, slice), data = ?, price_amount = ?, price_currency = ?,
         last_seen = ?, last_seen_run = ?, missed_full_runs = 0, first_missed = NULL, last_missed = NULL, gone = NULL
       WHERE id = ?`,
    ),
    // A price-only sighting proves the listing live: no census it falls in misses it.
    aliveListing: db.prepare(
      `UPDATE listings SET last_seen_run = ?, missed_full_runs = 0, first_missed = NULL, last_missed = NULL
       WHERE id = ? AND gone IS NULL`,
    ),
    upsertHistory: db.prepare(
      `INSERT INTO price_history (listing_id, date, amount, currency) VALUES (?, ?, ?, ?)
       ON CONFLICT (listing_id, date) DO UPDATE SET amount = excluded.amount, currency = excluded.currency`,
    ),
    markGone: db.prepare("UPDATE listings SET gone = ? WHERE id = ? AND gone IS NULL"),
    // Missed: not seen by any run of the census (since its first full run, so slices done by
    // a failed run and skipped by this one count as seen). A listing misses at most once per
    // census and once per day, so neither a census's slices and its end nor re-recording a
    // full run can count two misses.
    countMissed: db.prepare(
      `UPDATE listings SET missed_full_runs = missed_full_runs + 1,
         first_missed = coalesce(first_missed, :day), last_missed = :day, missed_census = :census
       WHERE source = :source AND scope = :scope AND gone IS NULL AND last_seen_run < :census
         AND (last_missed IS NULL OR last_missed < :day)
         AND (missed_census IS NULL OR missed_census <> :census)`,
    ),
    // The same, for the listings of the slices this run finished.
    countSliceMissed: db.prepare(
      `UPDATE listings SET missed_full_runs = missed_full_runs + 1,
         first_missed = coalesce(first_missed, :day), last_missed = :day, missed_census = :census
       WHERE source = :source AND scope = :scope AND gone IS NULL AND last_seen_run < :census
         AND slice IN (SELECT slice FROM slices WHERE run = :run)
         AND (last_missed IS NULL OR last_missed < :day)
         AND (missed_census IS NULL OR missed_census <> :census)`,
    ),
    // Gone once the census of the last miss is over (`:ended`: the current one too), since a
    // sighting anywhere in that census, even in a later run, clears the misses.
    goneAfterMisses: db.prepare(
      `UPDATE listings SET gone = first_missed
       WHERE source = :source AND scope = :scope AND gone IS NULL AND missed_full_runs >= :misses
         AND (coalesce(missed_census, 0) < :census OR :ended)`,
    ),
    upsertCatalog: db.prepare(
      `INSERT INTO catalog_entries (variant_id, source, data, updated, scope, last_seen_run)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT (variant_id, source) DO UPDATE SET data = excluded.data, updated = excluded.updated,
         scope = excluded.scope, last_seen_run = excluded.last_seen_run, retired = NULL`,
    ),
    // A catalog census states every Variant its Source knows: entries no run of the census
    // stated are retired (re-keyed or withdrawn), so they leave the catalog at once.
    retireCatalog: db.prepare(
      `UPDATE catalog_entries SET retired = :day
       WHERE source = :source AND scope = :scope AND retired IS NULL AND last_seen_run < :census`,
    ),
    upsertOpenpilot: db.prepare(
      `INSERT INTO openpilot_support (source, ref, data, updated, scope, last_seen_run)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT (source, ref) DO UPDATE SET data = excluded.data, updated = excluded.updated,
         scope = excluded.scope, last_seen_run = excluded.last_seen_run, retired = NULL`,
    ),
    // The openpilot list is a census too: rows no run of the census stated are retired.
    retireOpenpilot: db.prepare(
      `UPDATE openpilot_support SET retired = :day
       WHERE source = :source AND scope = :scope AND retired IS NULL
         AND last_seen_run < :census`,
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
        const { kind: _kind, ref: _ref, slice = null, ...data } = o;
        const existing = q.getListing.get(id) as
          | { price_amount: number; price_currency: string }
          | undefined;
        if (!existing) {
          q.insertListing.run(
            id,
            run.source,
            o.ref,
            run.scope,
            slice,
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
            slice,
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
      case "ListingPriceSeen": {
        // Checked live and in the listing's currency before recording (`repriceReason`).
        const id = `${run.source}:${o.ref}`;
        const existing = q.getLiveListing.get(id) as { price_amount: number };
        q.aliveListing.run(runId, id);
        if (existing.price_amount !== o.price.amount) {
          q.repriceListing.run(JSON.stringify(o.price), o.price.amount, id);
          q.upsertHistory.run(id, day, o.price.amount, o.price.currency);
          summary.priceChanges++;
        }
        break;
      }
      case "ListingGone":
        summary.gone += Number(q.markGone.run(day, `${run.source}:${o.ref}`).changes);
        break;
      case "CatalogEntry":
        q.upsertCatalog.run(
          variantIdOf(o.variant),
          run.source,
          JSON.stringify(o.variant),
          day,
          run.scope,
          runId,
        );
        break;
      case "VariantFacts":
        q.upsertFacts.run(run.source, JSON.stringify(o.vehicle), JSON.stringify(o), day);
        break;
      case "OpenpilotSupport": {
        const { kind: _kind, ref: _ref, ...data } = o;
        q.upsertOpenpilot.run(run.source, o.ref, JSON.stringify(data), day, run.scope, runId);
        break;
      }
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
      .prepare(
        `SELECT variant_id, data FROM catalog_entries WHERE retired IS NULL
         ORDER BY variant_id, updated, source`,
      )
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

  /**
   * The census the next full run of this scope continues, or null when it starts one: after a
   * complete full run, or once a stalled census has run its course (STALLED_CENSUS_DAYS).
   */
  function censusToContinue(source: SourceId, scope: string): number | null {
    const latest = q.latestFullRun.get(source, scope) as
      | { status: string; census: number }
      | undefined;
    if (!latest || latest.status === "complete") return null;
    const span = q.censusSpan.get(latest.census) as { first: string; last: string };
    const days =
      (Date.parse(pragueDate(new Date(span.last))) - Date.parse(pragueDate(new Date(span.first)))) /
      DAY_MS;
    if (days < STALLED_CENSUS_DAYS) return latest.census;
    const progress = q.censusProgress.get(latest.census) as { runs: number; done: number };
    return progress.runs === 2 && progress.done === 0 ? null : latest.census;
  }

  return {
    checkpoint(source: SourceId, scope = "all"): Checkpoint {
      const row = q.lastCompleteRun.get(source, scope) as { at: string | null };
      const census = censusToContinue(source, scope);
      return {
        lastRunAt: row.at ? new Date(row.at) : null,
        isKnown: (ref) => q.isKnown.get(`${source}:${ref}`) !== undefined,
        sliceDoneAt: (slice) => {
          if (census === null) return null;
          const done = q.sliceDoneAt.get(census, slice) as { at: string | null };
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
      const full = run.mode === "full";
      const continued = full ? censusToContinue(run.source, scope) : null;
      const { id: runId } = q.insertRun.get(
        run.source,
        run.mode,
        scope,
        run.startedAt.toISOString(),
        continued,
      ) as { id: number };
      if (full && continued === null) q.beginCensus.run(runId);
      /** The census's first full run: listings last seen before it are missed. */
      const census = continued ?? runId;
      const day = pragueDate(run.startedAt);
      const summary: RunSummary = {
        recorded: {},
        rejected: [],
        newListings: 0,
        priceChanges: 0,
        gone: 0,
        retired: 0,
        census: "not-full",
      };
      /** Why a price-only sighting cannot apply: only a ListingSeen adds a listing or moves its currency. */
      const repriceReason = (o: ListingPriceSeen): string | null => {
        const live = q.getLiveListing.get(`${run.source}:${o.ref}`) as
          | { price_currency: string }
          | undefined;
        if (!live) return "no live listing with this ref to reprice";
        return live.price_currency === o.price.currency
          ? null
          : `price currency ${o.price.currency} differs from the listing's ${live.price_currency}`;
      };
      let rejectedTotal = 0;
      // Observations since the previous SliceDone belong to the next one, unless they name
      // theirs (ListingSeen.slice). A slice that had a rejection stays not done for the rest
      // of the run, even if its SliceDone repeats.
      let rejectedInSlice = false;
      const tainted = new Set<string>();
      /**
       * A rejected sighting of a listing still proves a live one live, and keeps the slices it
       * may be in not done for the rest of the run, undoing a SliceDone that came earlier: the
       * slice it names, and the one the Ledger holds the live listing in.
       */
      const rejectedSighting = (o: Observation) => {
        const slices = new Set<string>();
        if (o?.kind === "ListingSeen" && typeof o.slice === "string") slices.add(o.slice);
        if (
          (o?.kind === "ListingSeen" || o?.kind === "ListingPriceSeen") &&
          typeof o.ref === "string"
        ) {
          const id = `${run.source}:${o.ref}`;
          const held = q.liveSliceOf.get(id) as { slice: string | null } | undefined;
          if (held?.slice) slices.add(held.slice);
          if (held) q.aliveListing.run(runId, id);
        }
        for (const slice of slices) {
          tainted.add(slice);
          q.deleteSlice.run(runId, slice);
        }
      };
      /**
       * At the end of a full run, complete or failed: listings missed by two censuses, the later
       * one over, are gone; listings of the slices it finished that no run of the census saw
       * count a miss; at the end of a complete one without rejections, so do all the scope's
       * listings no run of the census saw. A complete run ends its census, so its second misses
       * are gone too.
       */
      const inferAbsence = (complete: boolean) => {
        if (!full) return;
        const at = { day, source: run.source, scope, census };
        const goneAfterMisses = (ended: boolean) => {
          const params = {
            source: run.source,
            scope,
            census,
            ended: ended ? 1 : 0,
            misses: MISSES_TO_GONE,
          };
          summary.gone += Number(q.goneAfterMisses.run(params).changes);
        };
        // Before this census counts its misses, which would make an earlier one's look current.
        goneAfterMisses(false);
        q.countSliceMissed.run({ ...at, run: runId });
        if (complete && rejectedTotal === 0) {
          q.countMissed.run(at);
          summary.retired =
            Number(q.retireCatalog.run(at).changes) + Number(q.retireOpenpilot.run(at).changes);
        }
        if (complete) goneAfterMisses(true);
      };
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
          if (!reason && observation.kind === "ListingPriceSeen") {
            reason = repriceReason(observation);
          }
          if (observation.kind === "SliceDone") {
            if (rejectedInSlice) tainted.add(observation.slice);
            if (!reason && tainted.has(observation.slice)) {
              reason = "slice had rejected observations, so it is not done";
            }
            rejectedInSlice = false;
          } else if (reason && !namesSlice(observation)) {
            // One naming its slice keeps that one not done (`rejectedSighting`), wherever it is.
            rejectedInSlice = true;
          }
          if (reason) {
            rejectedTotal++;
            if (summary.rejected.length < MAX_REJECTIONS_REPORTED) {
              summary.rejected.push({ kind: String(observation?.kind), reason });
            }
            rejectedSighting(observation);
            continue;
          }
          begin();
          recordOne(observation, { ...run, scope }, runId, day, summary);
          if (++pending >= BATCH) commit();
        }
        commit();
      } catch (error) {
        commit();
        try {
          begin();
          inferAbsence(false);
        } finally {
          q.finishRun.run("failed", runId);
          commit();
        }
        throw error;
      }

      begin();
      if (full) summary.census = rejectedTotal > 0 ? "skipped-rejections" : "applied";
      inferAbsence(true);
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

      const openpilotRows = (
        db
          .prepare(
            "SELECT source, ref, data FROM openpilot_support WHERE retired IS NULL ORDER BY source, ref",
          )
          .all() as { source: string; ref: string; data: string }[]
      ).map((row) => ({
        ...(JSON.parse(row.data) as Omit<OpenpilotSupport, "kind" | "ref">),
        source: row.source,
        row: `${row.source}:${row.ref}`,
      }));

      return {
        openpilot: matchOpenpilot(openpilotRows, variants, resolver),
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
        *listings(ids?: Iterable<string>): Iterable<LedgerListing> {
          const columns = "id, source, ref, data, first_seen, last_seen, gone";
          const rows =
            ids === undefined
              ? (db
                  .prepare(`SELECT ${columns} FROM listings ORDER BY id`)
                  .iterate() as Iterable<ListingRecord>)
              : rowsOf(db.prepare(`SELECT ${columns} FROM listings WHERE id = ?`), ids);
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

interface ListingRecord {
  id: string;
  source: string;
  ref: string;
  data: string;
  first_seen: string;
  last_seen: string;
  gone: string | null;
}

function* rowsOf(byId: StatementSync, ids: Iterable<string>): Iterable<ListingRecord> {
  for (const id of ids) {
    const row = byId.get(id) as ListingRecord | undefined;
    if (row) yield row;
  }
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

/** A ListingSeen naming the census slice it was met in, valid or not. */
function namesSlice(o: Observation): boolean {
  return o?.kind === "ListingSeen" && typeof o.slice === "string";
}
