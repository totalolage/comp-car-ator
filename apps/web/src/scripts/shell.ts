/**
 * Shell behaviour on every page, without a framework: the language switch carries the
 * current URL state along, the header compare link and the recents list follow the store,
 * and the category menu closes on Escape or an outside click. Hover prefetch is Astro's
 * built-in `prefetch` (astro.config.mjs).
 */
import { type Lang, localePath } from "../i18n/locale.ts";
import { siteStore } from "../lib/store.ts";
import { writeCatalogState } from "../lib/url-state.ts";

const store = siteStore();
const lang = (document.body.dataset.lang ?? "cs") as Lang;

// Language switch: same page in the other locale, with this page's query and hash. The
// query is read at use time because islands rewrite it with history.replaceState.
for (const link of document.querySelectorAll<HTMLAnchorElement>("a[data-lang-switch]")) {
  const base = link.pathname;
  const sync = () => {
    link.href = base + location.search + location.hash;
  };
  for (const event of ["pointerenter", "focus", "pointerdown", "click"])
    link.addEventListener(event, sync);
}

// Remember model pages as recently viewed.
const { recentId, recentLabel } = document.body.dataset;
if (recentId && recentLabel) store.addRecent({ id: recentId, label: recentLabel });

function render() {
  const compare = store.compare();
  for (const link of document.querySelectorAll<HTMLAnchorElement>("a[data-compare-link]")) {
    link.hidden = compare.length === 0;
    link.href = localePath(lang, "/") + writeCatalogState({ compare });
    const badge = link.querySelector("[data-compare-count]");
    if (badge) badge.textContent = String(compare.length);
  }
  const recents = store.recents().filter((r) => r.id !== recentId);
  for (const section of document.querySelectorAll<HTMLElement>("[data-recents]")) {
    const list = section.querySelector("ul");
    if (!list) continue;
    list.replaceChildren(
      ...recents.map((r) => {
        const li = document.createElement("li");
        const a = document.createElement("a");
        a.href = localePath(lang, `/model/${r.id}/`);
        a.textContent = r.label;
        li.append(a);
        return li;
      }),
    );
    section.hidden = recents.length === 0;
  }
}
render();
store.subscribe(render);

// Category menu: close on Escape (focus back on its summary) and on a click outside it.
for (const menu of document.querySelectorAll<HTMLDetailsElement>("details[data-menu]")) {
  menu.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && menu.open) {
      menu.open = false;
      menu.querySelector("summary")?.focus();
    }
  });
  document.addEventListener("click", (e) => {
    if (menu.open && !menu.contains(e.target as Node)) menu.open = false;
  });
}
