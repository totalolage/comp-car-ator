# The web shell keeps view state in the URL, memory in one localStorage key, and locale in the path

The site has no accounts and no server, yet people need to share a filtered table, come back
to their compare list, and read it in Czech or English. Three modules in `apps/web` carry
that, each a small interface tested on its own:

- `lib/url-state.ts`: `readCatalogState(search)` / `writeCatalogState(state)` (and the
  `Listing` pair for model pages). The URL is the source of truth for a view: every filter,
  the sort and the compare list. `write` emits one canonical form (fixed parameter order,
  sorted lists, defaults omitted) so equal states give equal, short URLs
  (`?body=wagon&fuel=diesel&year=2015-2020&sort=-usedPrice&cmp=…`); `read` accepts anything a
  hand-edited or old link holds and drops what is not in the vocabulary. Values are split on
  literal commas before decoding, so a `%2C` inside a value survives. `cmp` absent means the
  view carries no compare list; `cmp=` means an explicitly empty one. Parameter names are
  short aliases of the catalog query engine's filter keys; `VariantFilters` and
  `ListingFilters` stay the definition of what a filter means.
- `lib/store.ts`: `siteStore()` holds the compare list (max 4, with each Variant's display
  name per locale), recently viewed models and saved searches under one versioned
  localStorage key (`cca:v1`). There is one instance per
  page, so islands and the shell script notify each other; other tabs arrive through the
  `storage` event. `openStore(storage)` builds it over any `Storage` (tests use an in-memory
  one). Saved searches store the canonical query string plus `lastTotal`, which is what
  deferred alerts will diff against. Corrupt data, a full quota or disabled storage degrade
  to an in-memory store, never an error.
- `i18n/i18n.ts`: `i18n(lang)` gives strings with `{var}` interpolation, Czech plural forms
  (`one`/`few`/`other` keys picked by `Intl.PluralRules`), vocabulary labels, and CZK, money,
  km, kW, l/100 km and Prague-date formats. Components never call `Intl` themselves.

Locale lives in the path (`/` Czech, `/en/` English), both pre-rendered. The language switch
is a plain link; the shell script rewrites its href at use time to carry the current query
and hash, so switching language keeps the view.

## Considered options

- **State in localStorage only**: not shareable, and two tabs fight. Rejected; localStorage
  only carries state across pages (compare list) and visits (recents, saved searches).
- **A per-key URL format (`?fuel=diesel&fuel=petrol`)**: longer URLs and order-dependent.
  Comma lists with a canonical order were chosen.
- **A storage port with browser and memory adapters**: the Web Storage interface already is
  that seam; tests pass an in-memory `Storage`. No extra port.
- **Locale by `Accept-Language` redirect**: needs a server or a client redirect with a flash.
  Czech is the default at `/`; English is one click away and links carry their locale.
- **Facet counts as "the total after this click"**: exact for make, model, body, fuel and
  transmission from the engine's disjunctive counts, but a Variant can be listed in several
  countries and sources, so for those the union needs one engine query per option, and
  every number in the rail would shift on each click. Per-value counts were chosen instead
  (Consequences).
- **The compare list in the URL only, or the URL's list shown without adopting it**: a
  shared link would then disagree with the tray and the pick boxes on the same page. The
  shared list replaces the remembered one instead (Consequences).
- **Loading the catalog index for the tray's names**: the index grows to megabytes at 50k
  Variants, and model pages load about 5 kB of JavaScript today. The store caches names.
- **Prefetching**: Astro's built-in hover prefetch (`prefetchAll`) handles navigation.
  Separately, the shell script loads the category tree into the Kategorie menu on pointer or
  focus with one fetch of `/categories/`; the “Všechny modely” link opts out of Astro
  prefetch, so the page is fetched once. The menu in the page holds only body types and that
  link (since 2026-10-28; the 140 makes were 13 kB on each of 3,500 pages); without
  JavaScript the link opens the full tree.

## Consequences

- Every island that owns filters reads and writes them through `url-state.ts` with
  `history.replaceState`; new filters are a row in its field table plus a test case.
- Static pages render unfiltered; an island applies the URL state after hydration, so a
  shared filtered link briefly shows the unfiltered first paint.
  Category tree pages (`/make/<make>/`, `/body/<body>/`) avoid that for the common entry
  points: the category is the island's fixed scope, rendered narrowed at build time and kept
  out of the query string (`withoutScope` drops a conflicting URL value).
- Model pages carry no Listings (2026-10-28). Rendering the first 25 rows, their rail and
  the props to hydrate them cost about 47 kB of HTML per model page with Listings, in both
  languages: a quarter of the deployment. The island fetches the model's first page instead
  (`/model/<id>/first.json.gz`, written once per model by the build, a few kB) and shows the
  rail and rows when it arrives; a URL with listing state skips it and opens the listing
  index (ADR 0004) directly, so a shared filtered link no longer flashes the unfiltered view.
  The Variants table, price statistics and history chart stay in the page. A model without
  Listings has no island. Without JavaScript a model page now shows no Listings (a
  `<noscript>` note says so); before, it showed the first 25.
- The compare list is one list per browser, in the store; everything that shows it renders
  from the store and follows it across islands and tabs. Every URL has one owner, and only
  that owner reads or writes `cmp` in it: `CatalogExplorer` on catalog pages, `CompareTable`
  on the compare page (`/compare/?cmp=…`). A `cmp` a page opens with (even `cmp=`) replaces
  the remembered list, so a shared link shows its sender's comparison; the owner then writes
  the store's list back into its URL on every change. The compare tray (a bar on every page
  but the compare page) and the header compare link never touch a URL: they change the list
  through the store and link to `/compare/?cmp=…`. Model pages have no `cmp`; they add
  Variants with `siteStore().toggleCompare(id, label)`. An open comparison therefore changes
  when another tab changes the list, which is the point of one list.
- The store caches each compared Variant's name in every locale (`toggleCompare(id,
  label)`, `setCompare(ids, labels)`), so the tray can name the list on pages that never load
  the catalog. Pages that load it refresh the names with `setCompare(store.compare(), …)`,
  reading the list at that moment, so a refresh never brings a removed Variant back; a write
  that changes nothing does not notify. An id the catalog no longer has (an old link, a
  changed Variant id) stays in the list as a "no longer in the catalog" column until removed.
- Facet counts in the catalog rail are per value: how many Variants have that value under
  every other facet's filters (the engine's disjunctive counts, unchanged). Checking or
  unchecking a value never changes the counts in its own facet (clearing the last make also
  clears the model choice, so the make counts then widen with it). In a facet with a checked
  value, unchecked make, model, body, fuel, transmission and openpilot options read "+N":
  each Variant has one such value, so checking it adds exactly N. Listing country and source keep the
  plain count there, since their Variants overlap and a click adds at most N. The rail
  footnote and each checkbox's accessible name say which meaning a number has.
  `facetOptions` and `toggleValue` in `lib/catalog-view.ts` own this and are tested
  against the engine.
- Message catalogs ship to islands as one shared chunk with both languages (about 3 kB
  gzipped today); the shell script imports only `i18n/locale.ts`.
- `openpilot` is the catalog parameter for comma.ai openpilot support (ADR 0016): a list of
  `OPENPILOT_LEVELS` plus `unlisted` (`?openpilot=community,upstream`), written after
  `source`. Its option labels, the catalog row badge and the model page section take their
  strings from `lib/openpilot-view.ts`, not the shared message catalog: the labels and badge
  reach the catalog island only and the section renders at build time, so a model page, the
  page nearest its JS budget, ships none of them.
- A performance budget per page is enforced at build time (`apps/web/DESIGN.md`).
