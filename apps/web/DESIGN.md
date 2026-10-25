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
│ │ facet groups │ │ count · dense table, sticky header row under the masthead            │ │
│ └──────────────┘ └──────────────────────────────────────────────────────────────────────┘ │
│ footer: data date, counts, note                                                            │
└ tray slot (compare tray, #17) ─────────────────────────────────────────────────────────────┘
```

- Category tree: the "Kategorie" disclosure in the masthead opens a full-width index of makes
  with their models (CSS columns) and body types, with Variant counts, plus recently viewed
  models. It is `<details>`, so it needs no script; the shell script only closes it on Escape
  or an outside click.
- `.split` = rail + results. Below 48rem it stacks; the rail becomes a grid of facet groups and
  tables scroll sideways inside `.table-scroll`.
- Content is fluid up to `--page-max` (100rem), with a 16px gutter (12px narrow).

## Components (classes in base.css)

`masthead`, `menu` / `menu-panel` / `tree`, `crumbs`, `page-title`, `page-summary`,
`section-title`, `split` / `rail` / `results`, `facet` / `facet-option`, `button-quiet`,
`data` (table; `.num` right-aligns), `table-scroll`, `count`, `badge`, `empty`, `colophon`.
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
| HTML                           | 30 kB  | 6.5 kB       | 1.9 kB     |
| CSS                            | 8 kB   | 2.3 kB       | 2.3 kB     |
| JS (all chunks the page loads) | 30 kB  | 16.0 kB      | 3.8 kB     |
| Total                          | 60 kB  | 24.8 kB      | 7.9 kB     |

Measured on the sample Bundle (2026-10-25). The catalog page's JS is Preact, its hooks, the
island and the shared url-state/i18n chunk; a model page loads only the shell script and
Astro's prefetch.

Bundle data (`/bundle/*.json`) is reported, not budgeted: its size follows the catalog and
is owned by the Bundle format and the catalog page. Rules that keep the shell inside the
budget: no web fonts, no images in chrome, one shared CSS file, Preact islands only where
state changes in place, the shell script stays framework-free and does not import the
message catalogs (`i18n/locale.ts` holds what it needs).
