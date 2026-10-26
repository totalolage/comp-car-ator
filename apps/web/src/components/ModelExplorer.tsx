/**
 * A model page's listings island: the listing facet rail, the price statistics for the
 * current selection and the dense listings table, each row expandable to its landed-price
 * breakdown, price history and photos. First paint comes from build-time props; after
 * hydration it opens the Bundle over fetch, applies the listing state in the URL and re-runs
 * the model's listing query on every change, writing the state back with lib/url-state. It
 * owns only the listing URL state; what it shows is lib/listing-view.ts.
 */

import type { ListingRow } from "@cca/bundle";
import { fetchLoader } from "@cca/bundle";
import {
  type ListingResult,
  type ListingSortKey,
  type ModelView,
  openCatalog,
  type Range,
  type Sort,
} from "@cca/catalog";
import type { FxTable, ModelId, VariantId } from "@cca/vocabulary";
import { useEffect, useMemo, useState } from "preact/hooks";
import { type I18n, i18n, MISSING } from "../i18n/i18n.ts";
import type { Lang, MessageKey } from "../i18n/messages.ts";
import {
  DEFAULT_LISTING_SORT,
  historySeries,
  LISTING_PAGE,
  LISTING_RAIL,
  type ListingEnumFacet,
  type ListingRangeFacet,
  landedBreakdown,
  landedSummary,
  listingBands,
  listingFacetOptions,
  listingPage,
  nextListingSort,
  priceChange,
  priceStats,
  type StatRow,
  toggleListingValue,
  withRange,
} from "../lib/listing-view.ts";
import { siteStore } from "../lib/store.ts";
import {
  type ListingState,
  readCatalogState,
  readListingState,
  writeCatalogState,
  writeListingState,
} from "../lib/url-state.ts";
import HistoryChart from "./HistoryChart.tsx";
import RangeFilter from "./RangeFilter.tsx";

interface Props {
  lang: Lang;
  modelId: ModelId;
  initial: ListingResult;
  initialStats: StatRow[];
  /** Variant id → display name. */
  names: Record<string, string>;
  /** ČNB rates of the currencies the model's listings use. */
  fx: FxTable;
  history: ModelView["history"];
}

const RANGE_LABEL: Record<ListingRangeFacet, MessageKey> = {
  year: "facet.listingYear",
  odometerKm: "facet.odometerKm",
  priceCzk: "facet.priceCzk",
  landedCzk: "facet.landedCzk",
  powerKw: "facet.powerKw",
};

const COLUMNS = 9;

export default function ModelExplorer(props: Props) {
  // `history` the prop, not window.history (used below to replace the URL).
  const { lang, modelId, initial, initialStats, names, fx, history: weekly } = props;
  const t = i18n(lang);
  const [view, setView] = useState<ModelView | null>(null);
  const [state, setState] = useState<ListingState>({ filters: {} });
  const [limit, setLimit] = useState(LISTING_PAGE);
  const [open, setOpen] = useState<ReadonlySet<string>>(new Set());
  const [railOpen, setRailOpen] = useState(false);
  const [resets, setResets] = useState(0);

  // The compare list in the URL (`cmp`), kept when the URL is replaced and updated when the
  // store changes (the compare buttons, the tray), exactly as the catalog island does.
  const [compare, setCompare] = useState<VariantId[] | undefined>(undefined);

  useEffect(() => {
    setState(readListingState(location.search));
    setCompare(readCatalogState(location.search).compare);
    const store = siteStore();
    let remembered = store.compare().join();
    const unsubscribe = store.subscribe(() => {
      const next = store.compare();
      if (next.join() === remembered) return;
      remembered = next.join();
      setCompare(next);
    });
    // TODO(wave1-stream15): the catalog interface loads catalog.json before any model file; a model page
    // needs only its own file (reported to the orchestrator as a catalog interface follow-up).
    openCatalog(fetchLoader(new URL("/bundle/", location.href)))
      .then((c) => c.model(modelId))
      .then(setView);
    return unsubscribe;
  }, [modelId]);

  const result = useMemo(
    () => (view ? listingPage(view, state, limit) : initial),
    [view, state, limit, initial],
  );
  const stats = useMemo(
    () => (view ? priceStats(view, state) : initialStats),
    [view, state, initialStats],
  );

  useEffect(() => {
    if (!view) return;
    const query = [writeListingState(state), writeCatalogState({ compare })]
      .map((q) => q.slice(1))
      .filter(Boolean)
      .join("&");
    const url = location.pathname + (query ? `?${query}` : "") + location.hash;
    if (url !== location.pathname + location.search + location.hash)
      history.replaceState(history.state, "", url);
  }, [view, state, compare]);

  function update(change: (s: ListingState) => ListingState) {
    setLimit(LISTING_PAGE);
    setState(change);
  }
  const filters = state.filters;
  const sort = state.sort ?? DEFAULT_LISTING_SORT;
  const active = writeListingState({ filters }) !== "";
  const activeCount = Object.keys(filters).length;
  const clear = () => {
    setResets((n) => n + 1);
    update((s) => ({ ...s, filters: {} }));
  };
  const onSort = (key: ListingSortKey) => {
    const next = nextListingSort(sort, key);
    const isDefault =
      next.key === DEFAULT_LISTING_SORT.key && next.dir === DEFAULT_LISTING_SORT.dir;
    setState((s) => ({ ...s, sort: isDefault ? undefined : next }));
  };
  const toggleOpen = (id: string) =>
    setOpen((o) => {
      const next = new Set(o);
      if (!next.delete(id)) next.add(id);
      return next;
    });

  return (
    <div class="split">
      <button
        type="button"
        class="button-quiet rail-toggle"
        aria-expanded={railOpen}
        aria-controls="listing-rail"
        onClick={() => setRailOpen((o) => !o)}
      >
        {t.t("catalog.filters")}
        {activeCount > 0 && ` (${activeCount})`}
      </button>
      <aside
        id="listing-rail"
        class="rail"
        data-open={railOpen}
        aria-label={t.t("catalog.filters")}
      >
        {LISTING_RAIL.map((facet) =>
          facet.kind === "range" ? (
            <RangeFilter
              key={`${facet.key}-${resets}`}
              facet={facet.key}
              legend={t.t(RANGE_LABEL[facet.key])}
              value={filters[facet.key]}
              bounds={result.facets.ranges[facet.key]}
              disabled={!view}
              t={t}
              bare={facet.key === "year"}
              picks={facet.key === "odometerKm" ? listingBands() : undefined}
              onChange={(r: Range | undefined) =>
                update((s) => ({ ...s, filters: withRange(s.filters, facet.key, r) }))
              }
            />
          ) : (
            <EnumFacet
              key={facet.key}
              facet={facet.key}
              result={result}
              state={state}
              names={names}
              disabled={!view}
              t={t}
              onToggle={(value) =>
                update((s) => ({ ...s, filters: toggleListingValue(s.filters, facet.key, value) }))
              }
            />
          ),
        )}
        <label class="facet-option facet-flag">
          <input
            type="checkbox"
            checked={filters.includeGone === true}
            disabled={!view}
            onChange={() =>
              update((s) => {
                const { includeGone, ...rest } = s.filters;
                return { ...s, filters: includeGone ? rest : { ...rest, includeGone: true } };
              })
            }
          />
          <span class="facet-label">{t.t("model.gone")}</span>
        </label>
        <button type="button" class="button-quiet" disabled={!view || !active} onClick={clear}>
          {t.t("catalog.clear")}
        </button>
      </aside>
      <section class="results" aria-busy={!view}>
        <Stats rows={stats} t={t} />
        <HistoryChart series={historySeries(view ?? { history: weekly }, state)} t={t} />
        <h2 class="section-title">{t.t("model.listings")}</h2>
        <p class="results-count" aria-live="polite">
          <output data-testid="total">{t.count("count.listings", result.total)}</output>
        </p>
        {result.rows.length === 0 ? (
          <div class="empty">
            <p>{t.t("model.empty")}</p>
            {active && (
              <button type="button" class="button-quiet" onClick={clear}>
                {t.t("catalog.clear")}
              </button>
            )}
          </div>
        ) : (
          <div class="table-scroll listings-scroll">
            <table class="data listings">
              <thead>
                <tr>
                  <th scope="col">{t.t("col.title")}</th>
                  <SortHeader t={t} label="col.year" k="year" sort={sort} onSort={onSort} />
                  <SortHeader
                    t={t}
                    label="col.odometer"
                    k="odometerKm"
                    sort={sort}
                    onSort={onSort}
                  />
                  <th scope="col">{t.t("col.transmission")}</th>
                  <SortHeader t={t} label="col.price" k="priceCzk" sort={sort} onSort={onSort} />
                  <SortHeader t={t} label="col.landed" k="landedCzk" sort={sort} onSort={onSort} />
                  <th scope="col">{t.t("col.market")}</th>
                  <th scope="col">{t.t("col.source")}</th>
                  <SortHeader t={t} label="col.days" k="daysOnMarket" sort={sort} onSort={onSort} />
                </tr>
              </thead>
              <tbody>
                {result.rows.map((l) => (
                  <ListingRows
                    key={l.id}
                    l={l}
                    t={t}
                    fx={fx}
                    names={names}
                    open={open.has(l.id)}
                    onToggle={() => toggleOpen(l.id)}
                  />
                ))}
              </tbody>
            </table>
          </div>
        )}
        {result.total > result.rows.length && (
          <p class="results-more">
            <button
              type="button"
              class="button-quiet"
              disabled={!view}
              onClick={() => setLimit((n) => n + LISTING_PAGE)}
            >
              {t.t("catalog.more", {
                n: Math.min(LISTING_PAGE, result.total - result.rows.length),
              })}
            </button>{" "}
            <span class="count">
              {t.t("catalog.shown", { shown: result.rows.length, total: result.total })}
            </span>
          </p>
        )}
      </section>
    </div>
  );
}

function EnumFacet(props: {
  facet: ListingEnumFacet;
  result: ListingResult;
  state: ListingState;
  names: Record<string, string>;
  disabled: boolean;
  t: I18n;
  onToggle(value: string): void;
}) {
  const { facet, result, state, names, disabled, t, onToggle } = props;
  const options = listingFacetOptions(facet, result, state.filters, names, t);
  if (options.length === 0) return null;
  return (
    <fieldset class="facet" data-facet={facet}>
      <legend>{t.t(`facet.${facet}` as MessageKey)}</legend>
      <div class={options.length > 12 ? "facet-scroll" : undefined}>
        {options.map(({ value, label, count, checked }) => (
          <label key={value} class="facet-option">
            <input
              type="checkbox"
              name={facet}
              value={value}
              checked={checked}
              disabled={disabled}
              aria-label={`${label}, ${t.count("count.listingsFacet", count)}`}
              onChange={() => onToggle(value)}
            />
            <span class="facet-label">{label}</span>
            <span class="count" aria-hidden="true">
              {count}
            </span>
          </label>
        ))}
      </div>
    </fieldset>
  );
}

function SortHeader(props: {
  t: I18n;
  label: MessageKey;
  k: ListingSortKey;
  sort: Sort<ListingSortKey>;
  onSort(key: ListingSortKey): void;
}) {
  const { t, label, k, sort, onSort } = props;
  const current = sort.key === k;
  return (
    <th
      scope="col"
      class="num"
      aria-sort={current ? (sort.dir === "asc" ? "ascending" : "descending") : undefined}
    >
      <button type="button" class="sort" onClick={() => onSort(k)}>
        {t.t(label)}
        <span class="sort-mark" aria-hidden="true">
          {current ? (sort.dir === "asc" ? "▲" : "▼") : ""}
        </span>
      </button>
    </th>
  );
}

function Stats({ rows, t }: { rows: StatRow[]; t: I18n }) {
  if (rows.length === 0) return null;
  const recomputed = rows.some((r) => r.from === "listings");
  return (
    <section class="stats" aria-labelledby="stats-title">
      <h2 class="section-title" id="stats-title">
        {t.t("model.prices")}
      </h2>
      <div class="table-scroll">
        <table class="data data-auto">
          <thead>
            <tr>
              <th scope="col">{t.t("col.market")}</th>
              <th scope="col">{t.t("col.condition")}</th>
              <th scope="col" class="num">
                {t.t("col.count")}
              </th>
              <th scope="col" class="num">
                {t.t("col.p10")}
              </th>
              <th scope="col" class="num">
                {t.t("col.median")}
              </th>
              <th scope="col" class="num">
                {t.t("col.p90")}
              </th>
              <th scope="col" class="num">
                {t.t("col.daysMedian")}
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={`${r.market}-${r.condition}`} data-stat={`${r.market}-${r.condition}`}>
                <th scope="row">{t.label("market", r.market)}</th>
                <td>{t.label("condition", r.condition)}</td>
                <td class="num">{t.number(r.count)}</td>
                {r.quantiles ? (
                  <>
                    <td class="num">{t.czk(r.quantiles.p10)}</td>
                    <td class="num">
                      <strong>{t.czk(r.quantiles.median)}</strong>
                    </td>
                    <td class="num">{t.czk(r.quantiles.p90)}</td>
                  </>
                ) : (
                  <td class="num muted" colSpan={3}>
                    {t.t("model.tooFew")}
                  </td>
                )}
                <td class="num">{t.number(r.days)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p class="facet-note">
        {t.t("model.pricesNote")}
        {recomputed && ` (${t.t("model.pricesRecomputed")})`}
      </p>
    </section>
  );
}

function ListingRows(props: {
  l: ListingRow;
  t: I18n;
  fx: FxTable;
  names: Record<string, string>;
  open: boolean;
  onToggle(): void;
}) {
  const { l, t, fx, names, open, onToggle } = props;
  const change = priceChange(l);
  const breakdown = landedBreakdown(l, fx, t);
  const detailId = `listing-${l.id.replace(/[^\w-]/g, "_")}`;
  return (
    <>
      <tr data-listing={l.id} data-gone={l.gone ? "" : undefined} data-open={open || undefined}>
        <th scope="row">
          <a href={l.url} rel="noopener nofollow">
            {l.title}
          </a>
          {l.condition !== "used" && <span class="tag">{t.label("condition", l.condition)}</span>}
          {l.gone && <span class="tag">{t.t("model.goneBadge", { date: t.date(l.gone) })}</span>}
          {l.excluded && <span class="tag tag-quiet">{t.t("model.excludedBadge")}</span>}
          {l.variantId && names[l.variantId] && <span class="sub">{names[l.variantId]}</span>}
        </th>
        <td class="num">{l.year ?? MISSING}</td>
        <td class="num">{t.km(l.odometerKm)}</td>
        <td>{l.transmission ? t.label("transmission", l.transmission) : MISSING}</td>
        <td class="num">
          {t.money(l.price.amount, l.price.currency)}
          {change && (
            <span
              class={change.amount < 0 ? "change down" : "change up"}
              title={t.t("model.priceHistory")}
            >
              {change.amount < 0 ? "▼" : "▲"}
              {Math.abs(change.percent)}&nbsp;%
            </span>
          )}
        </td>
        <td class="num">
          <button
            type="button"
            class="disclose"
            aria-expanded={open}
            aria-controls={detailId}
            title={landedSummary(breakdown)}
            onClick={onToggle}
          >
            {breakdown ? breakdown.total : MISSING}
            <span class="visually-hidden">, {t.t("landed.show")}</span>
          </button>
        </td>
        <td>{t.label("market", l.market)}</td>
        <td>{l.source}</td>
        <td class="num">{l.daysOnMarket}</td>
      </tr>
      {open && (
        <tr class="detail" id={detailId}>
          <td colSpan={COLUMNS}>
            <Detail l={l} t={t} fx={fx} />
          </td>
        </tr>
      )}
    </>
  );
}

function Detail({ l, t, fx }: { l: ListingRow; t: I18n; fx: FxTable }) {
  const b = landedBreakdown(l, fx, t);
  return (
    <div class="detail-grid">
      <section>
        <h3>{t.t("landed.heading")}</h3>
        {b ? (
          <>
            <table class="breakdown">
              <tbody>
                {b.lines.map((line) => (
                  <tr key={line.label}>
                    <th scope="row">{line.label}</th>
                    <td class="num">{line.value}</td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr>
                  <th scope="row">{t.t("landed.total")}</th>
                  <td class="num">{b.total}</td>
                </tr>
              </tfoot>
            </table>
            {l.price.currency !== "CZK" && (
              <p class="note">
                {t.t("col.price")}: {t.money(l.price.amount, l.price.currency)}
                {b.rate && ` · ${b.rate}`}
              </p>
            )}
            {b.notes.map((note) => (
              <p key={note} class="note">
                {note}
              </p>
            ))}
          </>
        ) : (
          <p class="note">{t.t("model.noEstimate")}</p>
        )}
      </section>
      <section>
        <h3>{t.t("model.priceHistory")}</h3>
        <table class="breakdown">
          <tbody>
            {l.priceHistory.map((p) => (
              <tr key={p.date}>
                <th scope="row">{t.date(p.date)}</th>
                <td class="num">{t.money(p.price.amount, p.price.currency)}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <dl class="facts">
          <dt>{t.t("model.firstSeen")}</dt>
          <dd>{t.date(l.firstSeen)}</dd>
          <dt>{t.t("model.lastSeen")}</dt>
          <dd>{t.date(l.lastSeen)}</dd>
          <dt>{t.t("model.seller")}</dt>
          <dd>{t.label("seller", l.seller)}</dd>
          {l.location && (
            <>
              <dt>{t.t("model.location")}</dt>
              <dd>{l.location}</dd>
            </>
          )}
        </dl>
        <p>
          <a href={l.url} rel="noopener nofollow">
            {t.t("model.open", { source: l.source })}
          </a>
        </p>
      </section>
      {l.photos.length > 0 && (
        <section class="photos">
          {l.photos.map((src) => (
            <img
              key={src}
              src={src}
              alt=""
              loading="lazy"
              decoding="async"
              referrerpolicy="no-referrer"
            />
          ))}
        </section>
      )}
    </div>
  );
}
