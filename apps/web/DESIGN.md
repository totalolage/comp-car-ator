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
  facets, the compare count, table row and facet hover (McMaster's pale `#FFFFB5`). The compare tray (#17) uses it for
  diff highlighting. Never decoration.
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
└ tray slot (compare tray, #17) ─────────────────────────────────────────────────────────────┘
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
  changes its own facet's counts. In a facet with a checked value, unchecked make, model,
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

## Components (classes in base.css)

`masthead`, `menu` / `menu-panel` / `tree`, `crumbs`, `page-title`, `page-summary`,
`section-title`, `split` / `rail` / `results`, `facet` / `facet-option` / `facet-note`, `button-quiet`,
`facet-scroll`, `range`, `bands` / `band`, `rail-toggle`, `data` (table; `.num` right-aligns;
`.sort` header buttons), `table-scroll`, `results-more`, `subcategories`, `count`, `badge`,
`empty`, `colophon`.
Rows are ~19px (2px vertical cell padding at 12px text), hairline rules, no zebra striping. A table's first cell is a row
header (`<th scope="row">`) holding the link.

## Accessibility floor

Skip link to `#main`; visible `:focus-visible` outline (blue on paper, yellow on the green
masthead); all text at least 4.5:1 against its ground in both schemes; checkbox facets are
real `<input>`s inside `<label>`s with `<fieldset>`/`<legend>` groups; result counts are
`aria-live`; breadcrumb is a labelled `<nav>` with `aria-current`.

## Performance budget

Enforced on every build by `scripts/check-budget.mjs` (fails the build), gzipped, per page:

|                                | budget | catalog page | model page |
| ------------------------------ | ------ | ------------ | ---------- |
| HTML                           | 30 kB  | 6.9 kB       | 1.9 kB     |
| CSS                            | 8 kB   | 2.5 kB       | 2.5 kB     |
| JS (all chunks the page loads) | 30 kB  | 19.1 kB      | 3.9 kB     |
| Total                          | 60 kB  | 28.5 kB      | 8.3 kB     |

Measured on the sample Bundle (2026-10-25). The catalog page's JS is Preact, its hooks, the
island (with the catalog query engine) and the shared url-state/i18n chunk; category pages
are the same page. A model page loads only the shell script and Astro's prefetch.

Query time is measured by `node apps/web/scripts/bench-catalog.ts` on a synthetic Bundle of
50k Variants (about 110k Variant × listing-group rows). On devbox (2026-10-25, under load):
a facet click, range edit or sort takes 11–15 ms (median), the first query 0.2 s (the
engine reads the rows into columns once), parsing `catalog.json` 0.4 s.

Bundle data (`/bundle/*.json`) is reported, not budgeted: its size follows the catalog and
is owned by the Bundle format and the catalog page. Rules that keep the shell inside the
budget: no web fonts, no images in chrome, one shared CSS file, Preact islands only where
state changes in place, the shell script stays framework-free and does not import the
message catalogs (`i18n/locale.ts` holds what it needs).
