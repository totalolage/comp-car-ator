/**
 * Catalog table + facet rail island. First paint comes from build-time props; after
 * hydration it opens the Bundle over fetch and re-queries on every facet change, keeping
 * the filters in the URL (?fuel=diesel,petrol). Unstyled on purpose: Wave 1 streams 13/14
 * own layout, design and the full facet set.
 */
import { fetchLoader } from "@cca/bundle";
import { type Catalog, openCatalog, type VariantFilters, type VariantResult } from "@cca/catalog";
import { useEffect, useState } from "preact/hooks";
import { type Lang, label, localePath, type Messages, numberLocale } from "../i18n/messages.ts";

const FACETS = ["make", "body", "fuel", "transmission", "market"] as const;
type Facet = (typeof FACETS)[number];

interface Props {
  lang: Lang;
  m: Messages;
  initial: VariantResult;
  makeNames: Record<string, string>;
}

export default function CatalogExplorer({ lang, m, initial, makeNames }: Props) {
  const [catalog, setCatalog] = useState<Catalog | null>(null);
  const [filters, setFilters] = useState<VariantFilters>({});
  const [result, setResult] = useState<VariantResult>(initial);

  useEffect(() => {
    setFilters(readFilters(new URLSearchParams(location.search)));
    openCatalog(fetchLoader(new URL("/bundle/", location.href))).then(setCatalog);
  }, []);

  useEffect(() => {
    if (!catalog) return;
    setResult(catalog.query({ filters, sort: { key: "make", dir: "asc" }, limit: 200 }));
    const url = new URL(location.href);
    url.search = writeFilters(filters).toString();
    history.replaceState(null, "", url);
  }, [catalog, filters]);

  function toggle(facet: Facet, value: string) {
    setFilters((current) => {
      const selected = new Set(current[facet] ?? []);
      if (selected.has(value)) selected.delete(value);
      else selected.add(value);
      return { ...current, [facet]: [...selected] };
    });
  }

  const fmt = new Intl.NumberFormat(numberLocale(lang), { maximumFractionDigits: 0 });
  const czk = (n: number | undefined) => (n === undefined ? "–" : `${fmt.format(n)} Kč`);

  return (
    <div class="catalog">
      <aside class="facets" aria-label="Filters">
        {FACETS.map((facet) => (
          <fieldset key={facet} data-facet={facet}>
            <legend>{m[`facet.${facet}`]}</legend>
            {result.facets.values[facet].map(({ value, count }) => (
              <label key={value}>
                <input
                  type="checkbox"
                  name={facet}
                  value={value}
                  checked={filters[facet]?.includes(value as never) ?? false}
                  disabled={!catalog}
                  onChange={() => toggle(facet, value)}
                />{" "}
                {facet === "make" ? (makeNames[value] ?? value) : label(m, facet, value)} ({count})
              </label>
            ))}
          </fieldset>
        ))}
        <button type="button" disabled={!catalog} onClick={() => setFilters({})}>
          {m["catalog.clear"]}
        </button>
      </aside>
      <section>
        <p>
          {m["catalog.results"]}: <output data-testid="total">{result.total}</output>
        </p>
        {result.rows.length === 0 ? (
          <p>{m["catalog.empty"]}</p>
        ) : (
          <table>
            <thead>
              <tr>
                <th>{m["col.model"]}</th>
                <th>{m["col.generation"]}</th>
                <th>{m["col.years"]}</th>
                <th>{m["col.body"]}</th>
                <th>{m["col.fuel"]}</th>
                <th>{m["col.power"]}</th>
                <th>{m["col.transmission"]}</th>
                <th>{m["col.newPrice"]}</th>
                <th>{m["col.usedPrice"]}</th>
                <th>{m["col.listings"]}</th>
              </tr>
            </thead>
            <tbody>
              {result.rows.map((v) => (
                <tr key={v.id} data-variant={v.id}>
                  <td>
                    <a href={localePath(lang, `/model/${v.modelId}/`)}>
                      {v.make} {v.model}
                    </a>
                  </td>
                  <td>{v.generation}</td>
                  <td>
                    {v.years.from}–{v.years.to ?? ""}
                  </td>
                  <td>{label(m, "body", v.body)}</td>
                  <td>{label(m, "fuel", v.fuel)}</td>
                  <td>{v.powerKw} kW</td>
                  <td>{label(m, "transmission", v.transmission)}</td>
                  <td>{v.newPriceCzk ? czk(v.newPriceCzk.min) : "–"}</td>
                  <td>{czk(v.used?.priceCzk.median)}</td>
                  <td>{v.used?.count ?? 0}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </div>
  );
}

function readFilters(params: URLSearchParams): VariantFilters {
  const filters: VariantFilters = {};
  for (const facet of FACETS) {
    const value = params.get(facet);
    if (value) (filters as Record<Facet, string[]>)[facet] = value.split(",");
  }
  return filters;
}

function writeFilters(filters: VariantFilters): URLSearchParams {
  const params = new URLSearchParams();
  for (const facet of FACETS) {
    const values = filters[facet];
    if (values?.length) params.set(facet, values.join(","));
  }
  return params;
}
