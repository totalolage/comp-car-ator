# Web design system

cars.f8y.dev reads like a printed parts catalog for cars, after McMaster-Carr: the page is
the table, navigation is a text index, filters narrow the table in place, and every view is
a URL. No product cards, no hero, no imagery in the shell. Tokens live in
`src/styles/tokens.css`, shared components in `src/styles/base.css`.

## World

- **Paper and ink.** White ground, near-black text, hairline grey rules between rows. Dark
  mode is the same sheet inverted (`light-dark()` tokens follow the OS setting).
- **Motorway-sign green** (`--sign`) is the masthead band and nothing else; it marks "site
  chrome" the way the green D-road signs mark the motorway.
- **Highlighter yellow** (`--mark`) marks what the person chose or what differs: checked
  facets, the compare count, table row and facet hover (McMaster's pale `#FFFFB5`), and the
  compare page's differing values. Never decoration.
- **Links are blue** (`--link`), underlined on hover. Everything clickable that navigates is a
  plain link so it prefetches on hover and works without JavaScript.

## Type

One workhorse sans (Arial / Helvetica / Liberation Sans), no web fonts. Fixed rem scale,
McMaster's density: 11 (counts, footnotes), 12 (tables, facets; McMaster measures 12px
Arial), 13 (body), 15 (section titles), 20 px (page title, bold). Text is `#333`, links
`#006699`, facet heading bands and table headers `#EEE`, hover `#FFFFB5`, all as measured
on mcmaster.com (2026-10-25). Numbers in tables use tabular figures and right-align.
Sentence case everywhere; no uppercase labels.

## Layout

```
┌ masthead (green, 40px, sticky): wordmark · Kategorie ▾ ·········· Porovnání (n) · English ┐
│ Katalog › Škoda › Octavia                                                   (breadcrumb)  │
│ Page title                                                                                │
│ ┌ rail 15rem ──┐ ┌ results ─────────────────────────────────────────────────────────────┐ │
│ │ facet groups │ │ count · dense table in .table-scroll, sticky header row              │ │
│ └──────────────┘ └──────────────────────────────────────────────────────────────────────┘ │
│ footer: data date, counts, note                                                            │
└ compare tray (fixed bar while the list has Variants): Porovnání 2 ze 4 · names × · Porovnat ┘
```

- Category tree: the "Kategorie" disclosure in the masthead opens a full-width index of makes
  with their models (CSS columns) and body types, with Variant counts, plus recently viewed
  models. It is `<details>`, so it needs no script; the shell script only closes it on Escape
  or an outside click.
- `.split` = rail + results. Below 48rem it stacks and the rail becomes a grid of facet groups.
- Tables sit in `.table-scroll`, a box at most one viewport tall (below the masthead) that
  scrolls both ways: a table wider than its column never widens the page, and the header row
  sticks to the top of the box at every width.
- Content is fluid up to `--page-max` (100rem), with a 16px gutter (12px narrow).

## Catalog page

- The catalog is one island (`CatalogExplorer`) over the catalog query engine; what it shows
  (rail order, columns, option order) is `lib/catalog-view.ts`, the one place that reads
  Variant aggregates. Every click, keystroke or sort re-runs `query()` and rewrites the URL.
- Category tree pages are the catalog with a fixed scope: `/make/<make>/` (the make's
  models listed above the table) and `/body/<body>/` (the makes that build it, each linking
  to `/make/<make>/?body=<body>`). They render pre-narrowed at build time; the scope never
  appears in the query string.
- Facet rail, top to bottom: make, model (once a make is chosen), body, fuel, transmission,
  production years, power, new price, used price, odometer (with one quick pick per Bundle
  odometer band), seats, consumption, listing country, listing source. Counts are per value:
  how many Variants have it under the other facets' filters, so checking a value never
  changes its own facet's counts (clearing the last make also drops the model choice). In a facet with a checked value, unchecked make, model,
  body, fuel and transmission options show "+N", exactly what checking them adds; country
  and source counts overlap, so they stay plain. A footnote under the rail says this, and
  each checkbox's accessible name carries the count's meaning (ADR 0009). Enum options keep a fixed
  order (vocabulary order, or by name), and a chosen value with no matches stays listed so it
  can be unchosen. Lists over 12 values scroll inside their group.
- Range fields narrow on every keystroke that parses (Czech `1,5` is fine); the placeholder
  shows the bound the other filters leave.
- Table: make and model link to the model page, then generation, years, body, fuel, power,
  transmission, consumption, seats, new price (from), used median, landed-in-CZ median,
  listing countries, listing count. Headers with a sort are buttons; `aria-sort` marks the
  current one. 100 rows, then "show 100 more".
- Below 48rem the rail folds behind a "Filters (n)" button above the table.

## Compare

- One compare list per browser (max 4, in the order added), kept by `siteStore()`; ADR 0009
  has who may write `cmp` into which URL.
- Catalog rows start with a pick box (`.pick`) whose accessible name is the Variant's full
  label. Unchecked boxes are disabled while 4 are picked; the tray says the list is full.
- The tray (`CompareTray.astro` + `scripts/tray.ts`, no framework) is fixed to the page
  bottom on every page but the compare page, only while the list has Variants: title with
  "n ze 4", one item per Variant (name, × remove), "clear", and "Porovnat →" to
  `/compare/?cmp=…`. The page reserves the tray's measured height. Items are kept per
  Variant, so a store update never takes keyboard focus; a removal moves focus to the next
  remove button, clearing to the main content. Below 48rem the names scroll sideways in one
  row.
- The compare page (`CompareTable` island over `lib/compare-view.ts`): one column per
  Variant (name linking to its model page, power · body · fuel · transmission, remove), line
  labels in a sticky first column, grouped Variant / specifications / new price / used cars.
  A line whose printed values differ between two or more Variants gets yellow (`--mark`)
  value cells and a "≠" with a spoken "differs"; lines with no value anywhere are left out;
  "only differences" hides the rest. A Variant the catalog no longer has keeps its column
  ("no longer in the catalog") and stays out of the comparison.

## Model page

- `/model/<make>/<model>/` (and `/en/…`), one per model in the Bundle, breadcrumb Katalog ›
  make (`/make/<make>/`) › model. Top to bottom: the model's Variants (generation, body, fuel,
  power; years, consumption, new price from, used median per Market from the published cells,
  active listing count linking to `?variant=<id>`, a "Porovnat" toggle that edits the compare
  list through `siteStore`; the tray itself is #17), then the listings island
  (`ModelExplorer`). EEA attribution shows under the Variants only once the Bundle has run
  the `eea-co2` Source and a Variant carries CO₂ data.
- `ModelExplorer` mirrors the catalog island over `model(id).listings()`: listing rail
  (Variant, condition, country, registration year, odometer with one quick pick per published
  band, landed price, asking price, power, fuel, gearbox, body, source; an enum facet with a
  single value is hidden; "include sold (last 30 days)"), price statistics, the price history
  chart, and the listings table. It owns only the listing URL state (`readListingState` /
  `writeListingState`); a `cmp` the URL carries is kept and follows the store.
  What it shows is `lib/listing-view.ts`, the one place in the UI that reads model-file shapes.
- Listings table: title (links to the source; condition, sold and "not in statistics" tags;
  its Variant on a second line), year, odometer, gearbox (from the listing), asking price in
  its own currency with the move since first seen (▼/▲ %), landed price in CZ, country,
  source, days listed. Default order is landed price ascending, so Czech and imported cars
  compare directly; year, odometer, price, landed and days sort. Listings the outlier rule
  left out of statistics (placeholder prices) always come last, tagged. The landed price is a
  button (hover shows the breakdown as a tooltip): it expands the row to the landed-price
  lines from Pricing with their notes, the original price and ČNB rate, the price history,
  first/last seen, seller and location, and up to three photos (lazy, secondary).
- Price statistics: p10, median, p90 of asking prices (CZK) and median days listed, one row
  per country × condition (never pooled), for the current filters. A selection the Publisher
  precomputed (at most one Variant, one year, one band pick) reads its cell; any other is
  recomputed from the Listings by the same rules (ADR 0012); fewer than 3 Listings show no
  quantiles.
- Price history: the published weekly median per country as lines (inline SVG stretched to
  the box, HTML labels so text stays 11px at any width; colours = categorical slots 1-3,
  validated in both schemes, plus legend, end labels and a data table under the chart).
  Hovering or touching the plot shows a crosshair at the nearest week with each country's
  value; the data table is built when opened, so long histories add no first-paint HTML.
  It is always the whole model's used
  Listings: only the country filter applies, since a model file no longer has the Listings
  that past weeks were computed from.

## Components (classes in base.css)

`masthead`, `menu` / `menu-panel` / `tree`, `crumbs`, `page-title`, `page-summary`,
`section-title`, `split` / `rail` / `results`, `facet` / `facet-option` / `facet-note`, `button-quiet`,
`facet-scroll`, `range`, `bands` / `band`, `rail-toggle`, `data` (table; `.num` right-aligns;
`.sort` header buttons), `table-scroll`, `results-more`, `subcategories`, `count`, `badge`,
`empty`, `colophon`, `pick`, `tray` / `tray-items` / `tray-item` / `tray-remove`,
`compare-tools`, `compare-table` / `compare-group` / `compare-detail` / `compare-gone`; model page: `data-auto`, `tag` / `tag-quiet`, `sub`, `change`,
`disclose`, `detail` / `detail-grid`, `breakdown`, `note`, `facts`, `photos`, `facet-flag`,
`chart` (`chart-legend`, `chart-key`, `chart-box`, `chart-plot`, `chart-line`, `chart-point`,
`chart-dot`, `chart-label`, `chart-x`, `chart-y`, `chart-data`), `visually-hidden`.
Rows are ~19px (2px vertical cell padding at 12px text), hairline rules, no zebra striping. A table's first cell is a row
header (`<th scope="row">`) holding the link.

## Accessibility floor

Skip link to `#main`; visible `:focus-visible` outline (blue on paper, yellow on the green
masthead); all text at least 4.5:1 against its ground in both schemes; checkbox facets are
real `<input>`s inside `<label>`s with `<fieldset>`/`<legend>` groups; result counts are
`aria-live`; breadcrumb is a labelled `<nav>` with `aria-current`.

## Performance budget

Enforced on every build by `scripts/check-budget.mjs` (fails the build), gzipped, per page:

|                                | budget | catalog page | model page | large model page |
| ------------------------------ | ------ | ------------ | ---------- | ---------------- |
| HTML                           | 30 kB  | 7.2 kB       | 8.9 kB     | 18.1 kB          |
| CSS                            | 8 kB   | 3.5 kB       | 3.5 kB     | 3.5 kB           |
| JS (all chunks the page loads) | 30 kB  | 22.7 kB      | 27.2 kB    | 27.2 kB          |
| Total                          | 60 kB  | 33.4 kB      | 39.6 kB    | 48.9 kB          |

Measured on the sample Bundle (2026-10-26); "large model page" is the Octavia page built from
`node apps/web/scripts/large-model-bundle.ts <dir>` (a 2.06 MB raw model file of 6,000
Listings with two years of weekly history, about the most popular model at scale) with
`BUNDLE_DIR=<dir>`. The catalog page's JS is Preact, its hooks, the island (with the catalog
query engine) and the shared url-state/i18n chunk, which carries both languages' messages
(about 4.5 kB gzip); category pages are the same page. A model page adds its island
(listing view, chart) and the store. The model page's HTML grows with the first 50 listing
rows and the weekly history it serializes for hydration; the chart's data table is built
only when opened.

Query time is measured by `node apps/web/scripts/bench-catalog.ts` on a synthetic Bundle of
50k Variants (about 110k Variant × listing-group rows). On devbox (2026-10-25, under load):
a facet click, range edit or sort takes 11–15 ms (median), the first query 0.2 s (the
engine reads the rows into columns once), parsing `catalog.json` 0.4 s.

Bundle data (`/bundle/*.json`) is reported, not budgeted: its size follows the catalog and
is owned by the Bundle format and the catalog page. Rules that keep the shell inside the
budget: no web fonts, no images in chrome, one shared CSS file, Preact islands only where
state changes in place, the shell script stays framework-free and does not import the
message catalogs (`i18n/locale.ts` holds what it needs).
