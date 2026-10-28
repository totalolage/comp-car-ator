/**
 * Catalog table + facet rail island. First paint comes from build-time props; after
 * hydration it opens the Bundle over fetch, applies the state in the URL and re-queries on
 * every facet, range or sort change, writing the state back with lib/url-state so the URL
 * stays shareable. This island owns the catalog URL, the compare list (`cmp`) included: a
 * `cmp` it opens with replaces the remembered list, and a change to the remembered list (a
 * pick box here, the compare tray, another tab) is written back with the filters (ADR 0009).
 */

import { prefetch } from "astro:prefetch";
import { fetchLoader, type VariantRow } from "@cca/bundle";
import {
  type Catalog,
  openCatalog,
  type Range,
  type VariantFilters,
  type VariantResult,
} from "@cca/catalog";
import type { VariantId } from "@cca/vocabulary";
import { useEffect, useMemo, useState } from "preact/hooks";
import { type I18n, i18n } from "../i18n/i18n.ts";
import type { Lang } from "../i18n/messages.ts";
import {
  COLUMNS,
  catalogQuery,
  DEFAULT_SORT,
  type EnumFacet,
  facetOptions,
  type Names,
  namesOf,
  nextSort,
  odometerBands,
  PAGE,
  RAIL,
  type RangeFacet,
  toggleValue,
  withoutScope,
} from "../lib/catalog-view.ts";
import { compareLabels, variantLabel, variantLabels } from "../lib/compare-view.ts";
import { siteStore } from "../lib/store.ts";
import {
  type CatalogState,
  COMPARE_MAX,
  readCatalogState,
  writeCatalogState,
} from "../lib/url-state.ts";
import RangeFilter from "./RangeFilter.tsx";

interface Props {
  lang: Lang;
  initial: VariantResult;
  /** Make and model names the first paint needs; the rest come with the catalog. */
  names: Names;
  /** The category this page is about; always applied, never in the URL. */
  scope?: VariantFilters;
}

export default function CatalogExplorer({ lang, initial, names: initialNames, scope }: Props) {
  const t = i18n(lang);
  const [catalog, setCatalog] = useState<Catalog | null>(null);
  const [names, setNames] = useState(initialNames);
  const [state, setState] = useState<CatalogState>({ filters: {} });
  const [limit, setLimit] = useState(PAGE);
  const [railOpen, setRailOpen] = useState(false);
  // Bumped by "clear filters" so range fields drop half-typed text too.
  const [resets, setResets] = useState(0);
  // The remembered compare list the pick boxes show; null until hydrated.
  const [picked, setPicked] = useState<VariantId[] | null>(null);

  useEffect(() => {
    const store = siteStore();
    const initial = withoutScope(readCatalogState(location.search), scope);
    // A shared list replaces the remembered one; without one the URL takes the remembered
    // list, so a copied URL carries what the pick boxes show.
    if (initial.compare) store.setCompare(initial.compare);
    else if (store.compare().length) initial.compare = store.compare();
    setState(initial);
    setPicked(store.compare());
    openCatalog(fetchLoader(new URL("/bundle/", location.href), { gzip: true })).then((c) => {
      const rows = c.query({ limit: Number.MAX_SAFE_INTEGER }).rows;
      setNames(namesOf(rows));
      setCatalog(c);
      const current = store.compare();
      store.setCompare(current, compareLabels(current, rows));
    });
    // Picks, the compare tray and other tabs change the remembered list; carry it into the
    // URL with the filters.
    let remembered = store.compare().join();
    return store.subscribe(() => {
      const compare = store.compare();
      setPicked(compare);
      if (compare.join() === remembered) return;
      remembered = compare.join();
      setState((s) => ({ ...s, compare }));
    });
  }, []);

  const result = useMemo(
    () => (catalog ? catalog.query(catalogQuery(state, scope, limit)) : initial),
    [catalog, state, limit, scope, initial],
  );

  useEffect(() => {
    if (!catalog) return;
    const url = location.pathname + writeCatalogState(state) + location.hash;
    if (url !== location.pathname + location.search + location.hash)
      history.replaceState(history.state, "", url);
  }, [catalog, state]);

  function update(change: (filters: VariantFilters) => VariantFilters) {
    setLimit(PAGE);
    setState((s) => ({ ...s, filters: change(s.filters) }));
  }

  function toggle(facet: EnumFacet, value: string) {
    update((filters) => toggleValue(filters, facet, value));
  }

  function setRange(facet: RangeFacet, range: Range | undefined) {
    update((filters) => {
      const next: Record<string, unknown> = { ...filters };
      if (range && (range.min !== undefined || range.max !== undefined)) next[facet] = range;
      else delete next[facet];
      return next as VariantFilters;
    });
  }

  const filters = state.filters;
  const sort = state.sort ?? DEFAULT_SORT;
  const applied = { ...filters, ...scope };
  // Any applied filter counts, including URL-only ones the rail does not show.
  const active = writeCatalogState({ filters }) !== "";
  const activeCount = Object.keys(filters).length;
  const clear = () => {
    setResets((n) => n + 1);
    update(() => ({}));
  };

  return (
    <div class="split">
      <button
        type="button"
        class="button-quiet rail-toggle"
        aria-expanded={railOpen}
        aria-controls="facet-rail"
        onClick={() => setRailOpen((o) => !o)}
      >
        {t.t("catalog.filters")}
        {activeCount > 0 && ` (${activeCount})`}
      </button>
      <aside id="facet-rail" class="rail" data-open={railOpen} aria-label={t.t("catalog.filters")}>
        {RAIL.map((facet) => {
          if (scope && facet.key in scope) return null;
          if (facet.kind === "range") {
            return (
              <RangeFilter
                key={`${facet.key}-${resets}`}
                facet={facet.key}
                legend={t.t(`facet.${facet.key}`)}
                value={filters[facet.key]}
                bounds={result.facets.ranges[facet.key]}
                disabled={!catalog}
                t={t}
                digits={facet.key === "consumptionL100km" ? 1 : 0}
                bare={facet.key === "year"}
                picks={facet.key === "odometerKm" ? odometerBands() : undefined}
                onChange={(r) => setRange(facet.key, r)}
              />
            );
          }
          if (facet.key === "model" && !applied.make?.length) return null;
          const options = facetOptions(facet.key, result, applied, names, t);
          if (options.length === 0) return null;
          return (
            <fieldset key={facet.key} class="facet" data-facet={facet.key}>
              <legend>{t.t(`facet.${facet.key}`)}</legend>
              {options.map(({ value, label, count, checked, adds }) => {
                const meaning = t.count(adds ? "count.facetAdds" : "count.variants", count);
                return (
                  <label key={value} class="facet-option">
                    <input
                      type="checkbox"
                      name={facet.key}
                      value={value}
                      checked={checked}
                      disabled={!catalog}
                      aria-label={`${label}, ${meaning}`}
                      onChange={() => toggle(facet.key, value)}
                    />
                    <span class="facet-label">{label}</span>
                    <span class="count" title={meaning} aria-hidden="true">
                      {adds ? `+${count}` : count}
                    </span>
                  </label>
                );
              })}
            </fieldset>
          );
        })}
        <p class="facet-note">{t.t("facet.note")}</p>
        <button type="button" class="button-quiet" disabled={!catalog || !active} onClick={clear}>
          {t.t("catalog.clear")}
        </button>
      </aside>
      <section class="results" aria-busy={!catalog}>
        <p class="results-count" aria-live="polite">
          <output data-testid="total">{t.count("count.variants", result.total)}</output>
        </p>
        {result.rows.length === 0 ? (
          <div class="empty">
            <p>{t.t("catalog.empty")}</p>
            {active && (
              <button type="button" class="button-quiet" onClick={clear}>
                {t.t("catalog.clear")}
              </button>
            )}
          </div>
        ) : (
          <div class="table-scroll">
            <table class="data">
              <thead>
                <tr>
                  <SortHeader
                    t={t}
                    label={t.t("col.model")}
                    sortKey="make"
                    sort={sort}
                    onSort={(s) => setState((st) => ({ ...st, sort: s }))}
                  />
                  {COLUMNS.map((col) =>
                    col.sort ? (
                      <SortHeader
                        key={col.id}
                        t={t}
                        label={t.t(col.label)}
                        sortKey={col.sort}
                        num={col.num}
                        sort={sort}
                        onSort={(s) => setState((st) => ({ ...st, sort: s }))}
                      />
                    ) : (
                      <th key={col.id} scope="col" class={col.num ? "num" : undefined}>
                        {t.t(col.label)}
                      </th>
                    ),
                  )}
                </tr>
              </thead>
              <tbody onPointerOver={prefetchLink}>
                {result.rows.map((v) => (
                  <tr key={v.id} data-variant={v.id}>
                    <th scope="row">
                      <PickBox t={t} variant={v} picked={picked} />
                      <a href={t.path(`/model/${v.modelId}/`)}>
                        {v.make} {v.model}
                      </a>
                    </th>
                    {COLUMNS.map((col) => (
                      <td key={col.id} class={col.num ? "num" : undefined}>
                        {col.cell(v, t)}
                      </td>
                    ))}
                  </tr>
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
              disabled={!catalog}
              onClick={() => setLimit((l) => l + PAGE)}
            >
              {t.t("catalog.more", { n: Math.min(PAGE, result.total - result.rows.length) })}
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

/**
 * Adds the row's Variant to the compare list or takes it out. Unchecked boxes are disabled
 * while the list is full; the tray says why.
 */
function PickBox(props: { t: I18n; variant: VariantRow; picked: VariantId[] | null }) {
  const { t, variant, picked } = props;
  const checked = picked?.includes(variant.id) ?? false;
  return (
    <input
      type="checkbox"
      class="pick"
      checked={checked}
      disabled={!picked || (!checked && picked.length >= COMPARE_MAX)}
      aria-label={t.t("compare.add", { name: variantLabel(variant, t) })}
      onChange={(e) => {
        // Refused (the list filled up in another tab): put the box back.
        if (!siteStore().toggleCompare(variant.id, variantLabels(variant)))
          (e.target as HTMLInputElement).checked = checked;
      }}
    />
  );
}

/** Rows re-rendered after load miss Astro's per-link hover listener; prefetch them here. */
function prefetchLink(e: PointerEvent) {
  const link = (e.target as Element).closest?.("a");
  if (link) prefetch(link.href);
}

function SortHeader(props: {
  t: I18n;
  label: string;
  sortKey: Parameters<typeof nextSort>[1];
  num?: boolean;
  sort: Parameters<typeof nextSort>[0];
  onSort(sort: ReturnType<typeof nextSort> | undefined): void;
}) {
  const { label, sortKey, num, sort, onSort } = props;
  const current = sort.key === sortKey;
  return (
    <th
      scope="col"
      class={num ? "num" : undefined}
      aria-sort={current ? (sort.dir === "asc" ? "ascending" : "descending") : undefined}
    >
      <button
        type="button"
        class="sort"
        onClick={() => {
          const next = nextSort(sort, sortKey);
          const isDefault = next.key === DEFAULT_SORT.key && next.dir === DEFAULT_SORT.dir;
          onSort(isDefault ? undefined : next);
        }}
      >
        {label}
        <span class="sort-mark" aria-hidden="true">
          {current ? (sort.dir === "asc" ? "▲" : "▼") : ""}
        </span>
      </button>
    </th>
  );
}
