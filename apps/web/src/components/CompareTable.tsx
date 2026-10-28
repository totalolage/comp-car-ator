/**
 * The compare page island: the compare list side by side, differences highlighted, built by
 * lib/compare-view.ts over the catalog. It owns the compare page's URL (`/compare/?cmp=…`):
 * a `cmp` it opens with replaces the remembered list (ADR 0009), and from then on it follows
 * siteStore() and writes the list back, so the address bar always shares what is on screen.
 */
import { fetchLoader, type VariantRow } from "@cca/bundle";
import { openCatalog } from "@cca/catalog";
import type { VariantId } from "@cca/vocabulary";
import { useEffect, useRef, useState } from "preact/hooks";
import { i18n } from "../i18n/i18n.ts";
import type { Lang } from "../i18n/messages.ts";
import { compareLabels, compareView, variantLabel } from "../lib/compare-view.ts";
import { siteStore } from "../lib/store.ts";
import { readCatalogState, writeCatalogState } from "../lib/url-state.ts";

interface Props {
  lang: Lang;
}

export default function CompareTable({ lang }: Props) {
  const t = i18n(lang);
  // null until hydrated: the static page cannot know the list.
  const [ids, setIds] = useState<VariantId[] | null>(null);
  const [byId, setById] = useState<Map<VariantId, VariantRow> | null>(null);
  const [failed, setFailed] = useState(false);
  const [differencesOnly, setDifferencesOnly] = useState(false);
  const [focus, setFocus] = useState<VariantId | "main" | null>(null);
  const box = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const store = siteStore();
    const shared = readCatalogState(location.search).compare;
    if (shared) store.setCompare(shared);
    let shown: VariantId[] = [];
    const sync = () => {
      const next = store.compare();
      // A removed column takes its focused remove button with it, whichever page or tab
      // removed it: hand focus to the next column's button, else the previous, else main.
      const active = (document.activeElement as HTMLElement | null)?.dataset?.remove;
      if (active && !next.includes(active)) {
        const at = shown.indexOf(active);
        const rest = shown.filter((id) => next.includes(id));
        setFocus(rest[at] ?? rest[at - 1] ?? "main");
      }
      shown = next;
      setIds(next);
    };
    sync();
    const off = store.subscribe(sync);
    openCatalog(fetchLoader(new URL("/bundle/", location.href), { gzip: true })).then(
      (c) => {
        const rows = c.query({ limit: Number.MAX_SAFE_INTEGER }).rows;
        setById(new Map(rows.map((v) => [v.id, v])));
        // Names only: the list is read now, so a removal made while loading stays removed.
        const current = store.compare();
        store.setCompare(current, compareLabels(current, rows));
      },
      () => setFailed(true),
    );
    return off;
  }, []);

  useEffect(() => {
    if (!ids) return;
    const url = location.pathname + writeCatalogState({ compare: ids }) + location.hash;
    if (url !== location.pathname + location.search + location.hash)
      history.replaceState(history.state, "", url);
  }, [ids]);

  useEffect(() => {
    if (!focus) return;
    const target =
      focus === "main"
        ? document.getElementById("main")
        : box.current?.querySelector<HTMLElement>(`[data-remove="${CSS.escape(focus)}"]`);
    target?.focus();
    setFocus(null);
  }, [focus]);

  if (failed && ids?.length) {
    return (
      <div class="empty" role="alert">
        <p>{t.t("compare.failed")}</p>
        <button type="button" class="button-quiet" onClick={() => location.reload()}>
          {t.t("compare.retry")}
        </button>
      </div>
    );
  }
  if (!ids || (ids.length > 0 && !byId)) {
    return (
      <p class="empty" aria-busy="true">
        {t.t("compare.loading")}
      </p>
    );
  }
  if (ids.length === 0 || !byId) {
    return (
      <div class="empty">
        <p>{t.t("compare.empty")}</p>
        <p>
          <a href={t.path("/")}>{t.t("compare.toCatalog")}</a>
        </p>
      </div>
    );
  }

  const store = siteStore();
  const view = compareView(ids, byId, t, { differencesOnly });
  const present = view.columns.filter((c) => c.variant).length;
  // Focus follows from the store update (see `sync`).
  const remove = (id: VariantId) => store.setCompare(ids.filter((c) => c !== id));
  const clear = () => {
    store.setCompare([]);
    setFocus("main");
  };

  return (
    <div ref={box}>
      <div class="compare-tools">
        <label>
          <input
            type="checkbox"
            checked={differencesOnly && present > 1}
            disabled={present < 2}
            onChange={(e) => setDifferencesOnly((e.target as HTMLInputElement).checked)}
          />
          {t.t("compare.onlyDiff")}
        </label>
        <span class="compare-legend">
          {present < 2 ? t.t("compare.one") : t.t("compare.legend")}
        </span>
        <button type="button" class="button-quiet" onClick={clear}>
          {t.t("compare.clear")}
        </button>
      </div>
      <div class="table-scroll">
        <table class="data compare-table">
          <caption class="visually-hidden">{t.t("compare.title")}</caption>
          <thead>
            <tr>
              <td />
              {view.columns.map(({ id, variant, name: shown, detail }, i) => {
                const label = store.compareLabel(id);
                const name = variant
                  ? variantLabel(variant, t)
                  : (label?.[lang] ??
                    Object.values(label ?? {})[0] ??
                    t.t("compare.unnamed", { n: i + 1 }));
                return (
                  <th key={id} scope="col">
                    {variant ? (
                      <>
                        <a href={t.path(`/model/${variant.modelId}/`)}>{shown}</a>
                        <span class="compare-detail">{detail}</span>
                      </>
                    ) : (
                      <>
                        {name}
                        <span class="compare-detail compare-gone">{t.t("compare.gone")}</span>
                      </>
                    )}
                    <button
                      type="button"
                      class="button-quiet"
                      data-remove={id}
                      aria-label={t.t("compare.remove", { name })}
                      onClick={() => remove(id)}
                    >
                      {t.t("compare.removeShort")}
                    </button>
                  </th>
                );
              })}
            </tr>
          </thead>
          {view.groups.map((group) => (
            <tbody key={group.id}>
              <tr class="compare-group">
                <th scope="rowgroup" colSpan={view.columns.length + 1}>
                  {group.label}
                </th>
              </tr>
              {group.lines.map((line) => (
                <tr key={line.id} data-differs={line.differs || undefined}>
                  <th scope="row">
                    {line.label}
                    {line.differs && (
                      <>
                        {" "}
                        <span class="compare-mark" aria-hidden="true">
                          ≠
                        </span>
                        <span class="visually-hidden">{t.t("compare.differs")}</span>
                      </>
                    )}
                  </th>
                  {line.values.map((value, i) => (
                    <td
                      key={view.columns[i]?.id}
                      data-gone={!view.columns[i]?.variant || undefined}
                    >
                      {value}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          ))}
        </table>
      </div>
      {view.groups.length === 0 && <p class="empty">{t.t("compare.noDiff")}</p>}
    </div>
  );
}
