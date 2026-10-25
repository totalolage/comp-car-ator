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
- `lib/store.ts`: `siteStore()` holds the compare list (max 4), recently viewed models and
  saved searches under one versioned localStorage key (`cca:v1`). There is one instance per
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
- **A custom hover-prefetch script**: Astro's built-in `prefetch` (`prefetchAll`, `hover`)
  does it in about 1 kB, so the shell has no prefetch code of its own.

## Consequences

- Every island that owns filters reads and writes them through `url-state.ts` with
  `history.replaceState`; new filters are a row in its field table plus a test case.
- Static pages render unfiltered; an island applies the URL state after hydration, so a
  shared filtered link briefly shows the unfiltered first paint.
  Category tree pages (`/make/<make>/`, `/body/<body>/`) avoid that for the common entry
  points: the category is the island's fixed scope, rendered narrowed at build time and kept
  out of the query string (`withoutScope` drops a conflicting URL value).
- The compare tray (#17) reads the list from `cmp` when the URL has it (even empty) and from
  the store otherwise; the header compare link already follows the store. The catalog URL
  has one owner, `CatalogExplorer`: it subscribes to the store and writes a changed compare
  list back as `cmp` with the filters, so the tray changes the list only through the store.
- Message catalogs ship to islands as one shared chunk with both languages (about 3 kB
  gzipped today); the shell script imports only `i18n/locale.ts`.
- A performance budget per page is enforced at build time (`apps/web/DESIGN.md`).
