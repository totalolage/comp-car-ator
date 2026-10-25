/**
 * Catalog table + facet rail island. First paint comes from build-time props; after
 * hydration it opens the Bundle over fetch, applies the state in the URL and re-queries on
 * every facet change, writing the state back with lib/url-state so the URL stays shareable.
 * TODO(wave1-stream14): full facet set, range filters, sortable columns, density options.
 */
import { fetchLoader } from "@cca/bundle";
import { type Catalog, openCatalog, type VariantResult } from "@cca/catalog";
import { useEffect, useState } from "preact/hooks";
import { i18n } from "../i18n/i18n.ts";
import type { Lang } from "../i18n/messages.ts";
import { type CatalogState, readCatalogState, writeCatalogState } from "../lib/url-state.ts";

const FACETS = ["make", "body", "fuel", "transmission", "market"] as const;
type Facet = (typeof FACETS)[number];
const DEFAULT_SORT = { key: "make", dir: "asc" } as const;
const LIMIT = 200;

interface Props {
  lang: Lang;
  initial: VariantResult;
  makeNames: Record<string, string>;
}

export default function CatalogExplorer({ lang, initial, makeNames }: Props) {
  const t = i18n(lang);
  const [catalog, setCatalog] = useState<Catalog | null>(null);
  const [state, setState] = useState<CatalogState>({ filters: {} });
  const [result, setResult] = useState<VariantResult>(initial);

  useEffect(() => {
    setState(readCatalogState(location.search));
    openCatalog(fetchLoader(new URL("/bundle/", location.href))).then(setCatalog);
  }, []);

  useEffect(() => {
    if (!catalog) return;
    const { filters, sort = DEFAULT_SORT } = state;
    setResult(catalog.query({ filters, sort, limit: LIMIT }));
    history.replaceState(
      history.state,
      "",
      location.pathname + writeCatalogState(state) + location.hash,
    );
  }, [catalog, state]);

  function toggle(facet: Facet, value: string) {
    setState((current) => {
      const selected = new Set<string>(current.filters[facet] ?? []);
      if (selected.has(value)) selected.delete(value);
      else selected.add(value);
      return { ...current, filters: { ...current.filters, [facet]: [...selected] } };
    });
  }

  // Any applied filter counts, including URL-only ones the rail does not show (`?year=…`).
  const active = writeCatalogState({ filters: state.filters }) !== "";

  return (
    <div class="split">
      <aside class="rail" aria-label={t.t("catalog.filters")}>
        {FACETS.map((facet) => (
          <fieldset key={facet} class="facet" data-facet={facet}>
            <legend>{t.t(`facet.${facet}`)}</legend>
            {result.facets.values[facet].map(({ value, count }) => (
              <label key={value} class="facet-option">
                <input
                  type="checkbox"
                  name={facet}
                  value={value}
                  checked={(state.filters[facet] as string[] | undefined)?.includes(value) ?? false}
                  disabled={!catalog}
                  onChange={() => toggle(facet, value)}
                />
                <span class="facet-label">
                  {facet === "make" ? (makeNames[value] ?? value) : t.label(facet, value)}
                </span>
                <span class="count">{count}</span>
              </label>
            ))}
          </fieldset>
        ))}
        <button
          type="button"
          class="button-quiet"
          disabled={!catalog || !active}
          onClick={() => setState((s) => ({ ...s, filters: {} }))}
        >
          {t.t("catalog.clear")}
        </button>
      </aside>
      <section class="results" aria-busy={!catalog}>
        <p class="results-count" aria-live="polite">
          <output data-testid="total">{t.count("count.variants", result.total)}</output>
        </p>
        {result.rows.length === 0 ? (
          <p class="empty">{t.t("catalog.empty")}</p>
        ) : (
          <div class="table-scroll">
            <table class="data">
              <thead>
                <tr>
                  <th scope="col">{t.t("col.model")}</th>
                  <th scope="col">{t.t("col.generation")}</th>
                  <th scope="col">{t.t("col.years")}</th>
                  <th scope="col">{t.t("col.body")}</th>
                  <th scope="col">{t.t("col.fuel")}</th>
                  <th scope="col" class="num">
                    {t.t("col.power")}
                  </th>
                  <th scope="col">{t.t("col.transmission")}</th>
                  <th scope="col" class="num">
                    {t.t("col.newPrice")}
                  </th>
                  <th scope="col" class="num">
                    {t.t("col.usedPrice")}
                  </th>
                  <th scope="col" class="num">
                    {t.t("col.listings")}
                  </th>
                </tr>
              </thead>
              <tbody>
                {result.rows.map((v) => (
                  <tr key={v.id} data-variant={v.id}>
                    <th scope="row">
                      <a href={t.path(`/model/${v.modelId}/`)}>
                        {v.make} {v.model}
                      </a>
                    </th>
                    <td>{v.generation}</td>
                    <td class="num">
                      {v.years.from}–{v.years.to ?? ""}
                    </td>
                    <td>{t.label("body", v.body)}</td>
                    <td>{t.label("fuel", v.fuel)}</td>
                    <td class="num">{t.kw(v.powerKw)}</td>
                    <td>{t.label("transmission", v.transmission)}</td>
                    <td class="num">{t.czk(v.newPriceCzk?.min)}</td>
                    <td class="num">{t.czk(v.used?.priceCzk.median)}</td>
                    <td class="num">{v.used?.count ?? 0}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}
