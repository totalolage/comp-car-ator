/**
 * A model page's listings island: the listing facet rail, the price statistics for the
 * current selection and the dense listings table, each row expandable to its landed-price
 * breakdown, price history and photos. On load it fetches the model's first page (a few kB,
 * written by the build); the first use (or a URL with listing state) opens the model's
 * listing index over fetch, applies the listing state in the URL and re-runs the model's
 * listing query on every change, loading the full rows of the shown page, and writes the
 * state back with lib/url-state. It owns only the listing URL state; what it shows is
 * lib/listing-view.ts.
 */

import type { ListingRow } from "@cca/bundle";
import { fetchLoader } from "@cca/bundle";
import {
  type ListingResult,
  type ListingSortKey,
  type ModelListings,
  openModel,
  type Range,
  type Sort,
} from "@cca/catalog";
import type { FxTable, ModelId } from "@cca/vocabulary";
import { useEffect, useMemo, useState } from "preact/hooks";
import { type I18n, i18n, MISSING } from "../i18n/i18n.ts";
import type { Lang, MessageKey } from "../i18n/messages.ts";
import {
  DEFAULT_LISTING_SORT,
  type FirstPage,
  historySeries,
  LISTING_FIRST,
  LISTING_PAGE,
  LISTING_RAIL,
  type ListingEnumFacet,
  type ListingLine,
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
import { type ListingState, readListingState, writeListingState } from "../lib/url-state.ts";
import HistoryChart from "./HistoryChart.tsx";
import RangeFilter from "./RangeFilter.tsx";

/** A page of the table: the engine's result with the full rows of the shown entries. */
type Page = Omit<ListingResult, "rows"> & { rows: ListingRow[] };

interface Props {
  lang: Lang;
  modelId: ModelId;
  /** Active Listings, for the count before the first page arrives. */
  total: number;
  initialStats: StatRow[];
  /** Variant id → display name. */
  names: Record<string, string>;
  history: ModelListings["history"];
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
  const { lang, modelId, total, initialStats, names, history: weekly } = props;
  const t = i18n(lang);
  // In use once the visitor interacts or the URL carries listing state; until then the
  // island shows the model's first page and has not fetched its listing index.
  const [used, setUsed] = useState(false);
  const [first, setFirst] = useState<FirstPage | null>(null);
  const [view, setView] = useState<ModelListings | null>(null);
  const [page, setPage] = useState<Page | null>(null);
  const [state, setState] = useState<ListingState>({ filters: {} });
  const [limit, setLimit] = useState(LISTING_FIRST);
  const [open, setOpen] = useState<ReadonlySet<string>>(new Set());
  const [railOpen, setRailOpen] = useState(false);
  const [resets, setResets] = useState(0);

  useEffect(() => {
    const fromUrl = readListingState(location.search);
    setState(fromUrl);
    if (writeListingState(fromUrl) !== "") return setUsed(true);
    // Without the first page the index has to answer the unfiltered view too.
    fetchLoader(new URL("/model/", location.href), { gzip: true })(`${modelId}/first.json`).then(
      (text) => (text ? setFirst(JSON.parse(text)) : setUsed(true)),
      () => setUsed(true),
    );
  }, [modelId]);

  useEffect(() => {
    // A failed load leaves the first paint up; the next use tries again.
    if (used && !view)
      openModel(fetchLoader(new URL("/bundle/", location.href), { gzip: true }), modelId).then(
        setView,
        () => setUsed(false),
      );
  }, [used, view, modelId]);

  const latest = useMemo(
    () => (view ? listingPage(view, state, limit) : null),
    [view, state, limit],
  );
  useEffect(() => {
    if (!view || !latest) return;
    let current = true;
    // A failed load (offline, or a deploy replaced the Bundle under this index) drops the
    // index; the next use opens it again.
    view.rows(latest.rows).then(
      (rows) => current && setPage({ ...latest, rows }),
      () => {
        if (!current) return;
        setView(null);
        setUsed(false);
      },
    );
    return () => {
      current = false;
    };
  }, [view, latest]);
  const loading = used && (!page || page.facets !== latest?.facets);
  const data = page ?? first;
  const result = data ?? { total };
  const lines: ListingLine[] = page
    ? page.rows.map((r) => ({ ...r, landedCzk: r.landed?.totalCzk, change: priceChange(r) }))
    : (first?.rows ?? []);
  const full = new Map(page?.rows.map((r) => [r.id, r]));
  const stats = useMemo(
    () => (view ? priceStats(view, state) : initialStats),
    [view, state, initialStats],
  );

  useEffect(() => {
    if (!used) return;
    const url = location.pathname + writeListingState(state) + location.hash;
    if (url !== location.pathname + location.search + location.hash)
      history.replaceState(history.state, "", url);
  }, [used, state]);

  function update(change: (s: ListingState) => ListingState) {
    setUsed(true);
    setLimit(LISTING_FIRST);
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
    setUsed(true);
    setState((s) => ({ ...s, sort: isDefault ? undefined : next }));
  };
  const toggleOpen = (id: string) => {
    setUsed(true);
    setOpen((o) => {
      const next = new Set(o);
      if (!next.delete(id)) next.add(id);
      return next;
    });
  };

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
        {data &&
          LISTING_RAIL.map((facet) =>
            facet.kind === "range" ? (
              <RangeFilter
                key={`${facet.key}-${resets}`}
                facet={facet.key}
                legend={t.t(RANGE_LABEL[facet.key])}
                value={filters[facet.key]}
                bounds={data.facets.ranges[facet.key]}
                disabled={false}
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
                result={data}
                state={state}
                names={names}
                t={t}
                onToggle={(value) =>
                  update((s) => ({
                    ...s,
                    filters: toggleListingValue(s.filters, facet.key, value),
                  }))
                }
              />
            ),
          )}
        <label class="facet-option facet-flag">
          <input
            type="checkbox"
            checked={filters.includeGone === true}
            onChange={() =>
              update((s) => {
                const { includeGone, ...rest } = s.filters;
                return { ...s, filters: includeGone ? rest : { ...rest, includeGone: true } };
              })
            }
          />
          <span class="facet-label">{t.t("model.gone")}</span>
        </label>
        <button type="button" class="button-quiet" disabled={!active} onClick={clear}>
          {t.t("catalog.clear")}
        </button>
      </aside>
      <section class="results" aria-busy={loading || !data}>
        <Stats rows={stats} t={t} />
        <HistoryChart series={historySeries(view ?? { history: weekly }, state)} t={t} />
        <h2 class="section-title">{t.t("model.listings")}</h2>
        <p class="results-count">
          <output data-testid="total" aria-live="polite">
            {t.count("count.listings", result.total)}
          </output>
          {/* Filters a link brought along are in the rail, which folds away on phones. Once
              shown it stays (aria-disabled, not disabled), so clearing keeps keyboard focus. */}
          {(active || resets > 0) && lines.length > 0 && (
            <button
              type="button"
              class="button-quiet"
              aria-disabled={!active}
              onClick={active ? clear : undefined}
            >
              {t.t("catalog.clear")}
            </button>
          )}
        </p>
        {data && lines.length === 0 ? (
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
                {lines.map((l) => (
                  <ListingRows
                    key={l.id}
                    l={l}
                    row={full.get(l.id)}
                    t={t}
                    fx={view?.fx ?? {}}
                    names={names}
                    open={open.has(l.id)}
                    onToggle={() => toggleOpen(l.id)}
                  />
                ))}
              </tbody>
            </table>
          </div>
        )}
        {result.total > lines.length && (
          <p class="results-more">
            <button
              type="button"
              class="button-quiet"
              onClick={() => {
                setUsed(true);
                setLimit((n) => n + LISTING_PAGE);
              }}
            >
              {t.t("catalog.more", {
                n: Math.min(LISTING_PAGE, result.total - lines.length),
              })}
            </button>{" "}
            <span class="count">
              {t.t("catalog.shown", { shown: lines.length, total: result.total })}
            </span>
          </p>
        )}
      </section>
    </div>
  );
}

function EnumFacet(props: {
  facet: ListingEnumFacet;
  result: Pick<ListingResult, "facets">;
  state: ListingState;
  names: Record<string, string>;
  t: I18n;
  onToggle(value: string): void;
}) {
  const { facet, result, state, names, t, onToggle } = props;
  const options = listingFacetOptions(facet, result, state.filters, names, t);
  if (options.length === 0) return null;
  return (
    <fieldset class="facet" data-facet={facet}>
      <legend>{t.t(`facet.${facet}` as MessageKey)}</legend>
      {options.map(({ value, label, count, checked }) => (
        <label key={value} class="facet-option">
          <input
            type="checkbox"
            name={facet}
            value={value}
            checked={checked}
            aria-label={`${label}, ${t.count("count.listingsFacet", count)}`}
            onChange={() => onToggle(value)}
          />
          <span class="facet-label">{label}</span>
          <span class="count" aria-hidden="true">
            {count}
          </span>
        </label>
      ))}
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
  l: ListingLine;
  /** The full row once loaded: the landed tooltip and the detail need it. */
  row: ListingRow | undefined;
  t: I18n;
  fx: FxTable;
  names: Record<string, string>;
  open: boolean;
  onToggle(): void;
}) {
  const { l, row, t, fx, names, open, onToggle } = props;
  const change = l.change;
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
            title={row ? landedSummary(landedBreakdown(row, fx, t)) : undefined}
            onClick={onToggle}
          >
            {l.landedCzk === undefined ? MISSING : t.czk(l.landedCzk)}
            <span class="visually-hidden">, {t.t("landed.show")}</span>
          </button>
        </td>
        <td>{t.label("market", l.market)}</td>
        <td>{l.source}</td>
        <td class="num">{l.daysOnMarket}</td>
      </tr>
      {open && (
        <tr class="detail" id={detailId}>
          <td colSpan={COLUMNS}>{row ? <Detail l={row} t={t} fx={fx} /> : MISSING}</td>
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
