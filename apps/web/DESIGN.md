# Web design system

cars.f8y.dev reads like a printed parts catalog for cars, after McMaster-Carr: the page is
the table, navigation is a text index, filters narrow the table in place, and every view is
a URL. No product cards, no hero, no imagery in the shell apart from the logo mark. Tokens
live in `src/styles/tokens.css`, shared components in `src/styles/base.css`.

## World

- **Paper and ink.** White ground, near-black text, hairline grey rules between rows. Dark
  mode is the same sheet inverted (`light-dark()` tokens follow the OS setting).
- **Motorway-sign green** (`--sign`) is the masthead band and nothing else; it marks "site
  chrome" the way the green D-road signs mark the motorway.
- **The c-c mark** sits before "comp-car-ator" in the masthead: a car drawn as one line whose
  wheels are two lowercase c's with a hyphen between them. It is the one image in the chrome,
  an inline SVG in `currentColor` (white on the green), 26px wide (1.75 × `--text-lg`) at
  every width, its bottom on the text baseline. The name stays live text and does not wrap; below
  30rem only the mark shows and the name is visually hidden link text. Masters,
  favicons and usage rules: `assets/logo/README.md`.
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
│ │ facet groups │ │ count · dense table in .table-scroll                                 │ │
│ └──────────────┘ └──────────────────────────────────────────────────────────────────────┘ │
│ footer: data date, counts, note                                                            │
└ compare tray (fixed bar while the list has Variants): Porovnání 2 ze 4 · names × · Porovnat ┘
```

- Category tree: the categories page (`/categories/`) lists every make with its models (CSS
  columns) and the body types, with Variant counts. The "Kategorie" disclosure in the
  masthead opens the same index as a full-width panel, plus recently viewed models. Its HTML
  holds body types only, with a "Všechny modely" link to the categories page: 1,600 model
  links on every page would be 19 kB gzip of each page's 30 kB, and the 140 makes alone were
  13 kB raw on each of 3,500 pages (a sixth of the deployment). The shell script fetches the
  categories page when the pointer or focus reaches the menu (or it opens) and swaps its
  makes-with-models tree in, keeping focus on the same link; it also closes the
  menu on Escape or an outside click. The menu is `<details>` and plain links, so without
  script it still opens, and the link leads to the full tree.
- `.split` = rail + results. Below 48rem it stacks and the rail becomes a grid of facet groups.
- Scrolling: the masthead sticks to the top. From 48rem both `.split` columns stick to the top
  under the masthead (plain `position: sticky`) and neither scrolls on its own: the taller one
  scrolls with the page; the shorter one stays stuck under the masthead until the end of the
  split reaches it, and then both scroll off together. This holds even when the shorter column
  is taller than the viewport, so its lower part comes into view only at the end of the split,
  and keyboard focus moved there stays below the viewport until then: the trade-off for plain
  sticky behaviour.
- The page is the only vertical scroller on the catalog, model and compare pages: no table,
  list or panel scrolls vertically on its own. The one exception is the Kategorie menu panel,
  which overlays the page and scrolls itself when it is taller than the viewport.
- Tables sit in `.table-scroll`, a box as tall as its table that only scrolls sideways: a
  table wider than its column never widens the page. The header row stays under the masthead
  while its table's rows pass and leaves with the last rows (a header row taller than the
  table's `--table-head` allowance is clipped as it leaves). A sideways scroll box would
  catch a sticky header, so a CSS view timeline moves the header cells instead; where view
  timelines are missing (Firefox) the header row scrolls away with the rows.
- Viewport heights use `dvh`, so they follow mobile browser chrome as it slides in and out
  instead of assuming the tallest viewport.
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
  can be unchosen. Long lists (makes, models) show in full; the page scrolls them.
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
  list through `siteStore().toggleCompare(id, label)` with the Variant's tray name in both
  languages), then the listings island
  (`ModelExplorer`). The Variants table lists every Variant with Listings (sold ones too) or a
  used median, and fills up to 30 rows with the others in order (`listedVariants`); a popular
  model has hundreds of Variants from price lists and the register, most never on sale, so a
  link ("+ 304 variant v katalogu") opens the catalog filtered to the model, which lists them
  all. EEA attribution shows under the Variants only once the Bundle has run
  the `eea-co2` Source and a Variant carries CO₂ data.
- `ModelExplorer` mirrors the catalog island over `model(id).listings()`: listing rail
  (Variant, condition, country, registration year, odometer with one quick pick per published
  band, landed price, asking price, power, fuel, gearbox, body, source; an enum facet with a
  single value is hidden; "include sold (last 30 days)"), price statistics, the price history
  chart, and the listings table. It owns only the listing URL state (`readListingState` /
  `writeListingState`); model pages have no `cmp` (ADR 0009).
  What it shows is `lib/listing-view.ts`, the one place in the UI that reads model-file shapes.
- Listings table: title (links to the source; condition, sold and "not in statistics" tags;
  its Variant on a second line), year, odometer, gearbox (from the listing), asking price in
  its own currency with the move since first seen (▼/▲ %), landed price in CZ, country,
  source, days listed. 25 rows, then "show 50 more" from the model file the island loaded.
  Default order is landed price ascending, so Czech and imported cars compare directly; year, odometer, price, landed and days sort. Listings the outlier rule
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

`masthead`, `wordmark` (mark + site name), `menu` / `menu-panel`, `categories` /
`categories-makes` / `categories-bodies` / `categories-all` / `tree`, `crumbs`,
`page-title`, `page-summary`, `section-title`, `split` / `rail` / `results`, `facet` / `facet-option` / `facet-note`, `button-quiet`,
`range`, `bands` / `band`, `rail-toggle`, `data` (table; `.num` right-aligns;
`.sort` header buttons), `table-scroll`, `results-more`, `subcategories`, `count`, `badge`,
`empty`, `colophon`, `pick`, `tray` / `tray-items` / `tray-item` / `tray-remove`,
`compare-tools`, `compare-table` / `compare-group` / `compare-detail` / `compare-gone`; model page: `variants`, `stats`, `data-auto`, `tag` / `tag-quiet`, `sub`, `change`,
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

|                                | budget | catalog page | compare page | model page | largest model page |
| ------------------------------ | ------ | ------------ | ------------ | ---------- | ------------------ |
| HTML                           | 30 kB  | 19.0 kB      | 3.8 kB       | 8.7 kB     | 12.8 kB            |
| CSS                            | 8 kB   | 4.3 kB       | 4.3 kB       | 4.3 kB     | 4.3 kB             |
| JS (all chunks the page loads) | 30 kB  | 27.4 kB      | 25.1 kB      | 29.0 kB    | 29.0 kB            |
| Total                          | 60 kB  | 50.6 kB      | 33.2 kB      | 42.0 kB    | 46.0 kB            |

Measured on the real Bundle of 2026-10-28 (1,601 models, 20k Variants, 810k Listings; 3,506
pages), republished in Bundle format 3; "model page" is the Opel Corsa (13,774 Listings),
"largest model page" the Mercedes-Benz E-Class. The catalog page's JS is Preact, its hooks,
the island (with the catalog query engine), the shared url-state/i18n chunk, which carries
both languages' messages, and the shell script (with the tray); category pages are the same
page, and the compare page is the same stack with its own island. A model page adds its
island (listing view, chart) and is the page closest to the JS budget: new messages or island
code land on it first. It does not load the catalog page's view code (`RangeFilter` takes
`rangeFromText` from url-state, not catalog-view) nor its Variant engine
(`@cca/catalog`'s `model.ts` holds what a model page needs).

A model page's HTML grows with the listed Variants (each with its tray name), the names of
the Variants its Listings belong to and the weekly history it serializes for hydration; it
carries no Listings. On load the island fetches the model's first listing page
(`/model/<id>/first.json.gz`, at most 3.5 kB gzip); the first filter, sort, "show more" or
expanded row loads the model's listing index (at most 121 kB gzip, the Octavia; most models a
few kB) and the rows files of the shown page (about 5 kB each). A URL with listing state loads
the index at once.

The whole build output was 220 MB in 32,016 files on that Bundle (906 MB before format 3), and
the build took 56 seconds on devbox:
the Bundle 126 MB gzipped as stored, HTML 92 MB, first pages 2 MB. `scripts/check-budget.mjs`
prints the Bundle's size, its largest model index and the largest first page on every build.
The header menu carries body types only; the makes and models load from `/categories/` when
it is about to open (ADR 0009).

Query time is measured by `node apps/web/scripts/bench-catalog.ts` on a synthetic Bundle of
50k Variants (about 110k Variant × listing-group rows). On devbox (2026-10-25, under load):
a facet click, range edit or sort takes 11–15 ms (median), the first query 0.2 s (the
engine reads the rows into columns once), parsing `catalog.json` 0.4 s.

Bundle data (`/bundle/**/*.json.gz`) is reported, not budgeted: its size follows the catalog
and is owned by the Bundle format. Rules that keep the shell inside the
budget: no web fonts, no images in chrome except the inline mark (one path, under 0.4 kB),
one shared CSS file, Preact islands only where state changes in place, the shell script
stays framework-free and does not import the message catalogs (`i18n/locale.ts` holds what
it needs).

## Install and offline

The site installs as an app (`public/manifest.webmanifest`: standalone, start and scope `/`,
the tile icons from `assets/logo/`, plus the maskable one). On iOS the `apple-mobile-web-app-*`
meta make Add to Home Screen open standalone with a translucent status bar: the page runs
under it (`viewport-fit=cover`), the masthead pads itself by `env(safe-area-inset-top)` so its
green fills the bar, `--masthead` includes that inset for everything that sticks below it, and
`--gutter` grows to the side insets in landscape.

The service worker (`scripts/service-worker.mjs`, written to `/sw.js` after the build) keeps
pages and Bundle data network first, so online nothing is older than the last deploy, and
answers from its cache only when the network fails; a page never kept falls back to
`/offline/` (`/en/offline/`), which lists the recently viewed models; a 5xx also gets the
kept copy, a 404 does not. The catalog pages and `/_astro/` assets are precached, so the
installed app opens offline, but its filters need `catalog.json`, which is only kept once
fetched. Offline reads are best effort: a model's kept index and rows files may come from
different deploys, and the rows stamp check then fails as it would online. Other origins
(listing photos), `/_vercel/` and requests that carry their own credentials (an
`Authorization` header, a script's fetch with `credentials: "include"`) bypass the worker.
Every cache carries the worker's version, a hash of what it precaches. A deploy's new worker
waits until no tab runs the old one, so an open tab still loads its own deploy's chunks from
the old cache after the server has dropped them; when the new worker activates it drops the
older caches. Nothing announces an update: the next visit after the tabs close gets it.
`shell.ts` registers it (a few dozen bytes); `vercel.json` serves `/sw.js` with `no-cache`.
