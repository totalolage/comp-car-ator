/**
 * Compare tray behaviour (components/CompareTray.astro), without a framework: renders the
 * compare list from the store on every change from this page or another tab, and removes
 * or clears through the store. Items are kept per Variant id, so a re-render never takes
 * keyboard focus away; after a removal focus moves to the next remove button.
 */
import { type Lang, localePath } from "../i18n/locale.ts";
import { siteStore } from "../lib/store.ts";
import { COMPARE_MAX, writeCatalogState } from "../lib/url-state.ts";

const tray = document.querySelector<HTMLElement>("[data-tray]");
if (tray) mount(tray);

function mount(tray: HTMLElement) {
  const store = siteStore();
  const lang = (document.body.dataset.lang ?? "cs") as Lang;
  const text = tray.dataset as { count: string; remove: string; unnamed: string };
  const fill = (template: string, vars: Record<string, string | number>) =>
    template.replace(/\{(\w+)\}/g, (all, name: string) => String(vars[name] ?? all));
  const $ = <T extends Element>(selector: string) => tray.querySelector<T>(selector) as T;
  const list = $<HTMLOListElement>("[data-tray-items]");
  const template = $<HTMLTemplateElement>("[data-tray-item]");
  const count = $<HTMLElement>("[data-tray-count]");
  const full = $<HTMLElement>("[data-tray-full]");
  const open = $<HTMLAnchorElement>("[data-tray-open]");
  const items = new Map<string, HTMLLIElement>();

  function item(id: string): HTMLLIElement {
    let li = items.get(id);
    if (!li) {
      li = template.content.firstElementChild?.cloneNode(true) as HTMLLIElement;
      li.querySelector("button")?.addEventListener("click", () => remove(id));
      items.set(id, li);
    }
    return li;
  }

  function render() {
    const ids = store.compare();
    ids.forEach((id, i) => {
      const li = item(id);
      const label = store.compareLabel(id);
      const name =
        label?.[lang] ?? Object.values(label ?? {})[0] ?? fill(text.unnamed, { n: i + 1 });
      const span = li.querySelector(".tray-name") as HTMLElement;
      span.textContent = name;
      span.title = name;
      li.querySelector("button")?.setAttribute("aria-label", fill(text.remove, { name }));
      // Move only what is out of place: moving the focused item would blur it.
      if (list.children[i] !== li) list.insertBefore(li, list.children[i] ?? null);
    });
    for (const [id, li] of items) {
      if (ids.includes(id)) continue;
      li.remove();
      items.delete(id);
    }
    count.textContent = fill(text.count, { n: ids.length });
    full.hidden = ids.length < COMPARE_MAX;
    open.href = localePath(lang, "/compare/") + writeCatalogState({ compare: ids });
    tray.hidden = ids.length === 0;
    reserve();
  }

  function remove(id: string) {
    const ids = store.compare();
    const at = ids.indexOf(id);
    const rest = ids.filter((c) => c !== id);
    store.setCompare(rest);
    const next = rest[at] ?? rest[at - 1];
    const target = next ? items.get(next)?.querySelector("button") : null;
    (target ?? document.getElementById("main"))?.focus();
  }

  // The tray is fixed over the page bottom; the page reserves its height so nothing hides
  // under it (labels can wrap, so the height is measured, not assumed).
  function reserve() {
    const height = tray.hidden ? 0 : tray.offsetHeight;
    document.body.style.setProperty("--tray-space", `${height}px`);
  }

  $<HTMLButtonElement>("[data-tray-clear]").addEventListener("click", () => {
    store.setCompare([]);
    document.getElementById("main")?.focus();
  });
  new ResizeObserver(reserve).observe(tray);
  render();
  store.subscribe(render);
}
