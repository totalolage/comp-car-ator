# openpilot support from comma's own list, placed on Variants precision first

Buyers who want comma.ai's openpilot driver assistance (a comma 3X on the windscreen) need to know whether a car can run it. comma publishes the answer as a generated table, so the catalog shows it from there: a badge and a facet on catalog rows, and a section on the model page. A car wrongly shown as supported costs a buyer more than one not shown, so every step below drops a row rather than guess.

## Source

The `comma-openpilot` Source reads two generated Markdown files over plain HTTPS:

- `commaai/opendbc` `docs/CARS.md`, the current inventory: every known car with its package and support level (upstream, community, custom, under review, dashcam, not compatible). It is generated from opendbc's car definitions and matches comma.ai/vehicles. As of opendbc 8ceee62 (2026-10-05) it lists 406 cars, 341 of them upstream.
- `commaai/openpilot` `docs/CARS.md`, the older, detailed rendering of the upstream cars only: longitudinal control, the speeds below which openpilot does not engage or steer, and the harness. Its rows are joined on the exact make, model cell and package. A row without an exact join has no details; a fuzzy join could pin one car's harness on another.

There is no JSON form and no per-car link. comma.ai/vehicles embeds its data in a hashed script bundle, so each row links to its make's section of that page.

The list is a census, like the register: every run reads the whole list, and a full run's rows replace the previous ones. The Ledger stores the rows in their own table and retires the ones a full census no longer states, as it does catalog entries. It runs weekly, since comma regenerates the list every few weeks.

## Observation

`OpenpilotSupport` is one row: make and model as listed, the fuel only when the model name states it ("RAV4 Hybrid", "Kona Electric"), the model years, level, package, market, and the details. `market` is the row's own qualifier ("Europe only", "China only"), or "US", which the list says is its default. `europe` is true when the qualifier names Europe (or "Non-US"), false when it names only other markets, and absent for a US-referenced row, whose European version may differ.

## Placement (Ledger snapshot)

The Ledger places each row at snapshot time, as it resolves VariantFacts and Offers:

1. A row with `europe: false` is not placed.
2. The Resolver places make and model (fuel included, so "Kona Electric" is read as a Kona). An unknown model is not placed. The Resolver takes a longer name for a shorter one it knows ("Corolla Cross" as a Corolla), so the row is placed only when every word the listed name adds to the catalog's is a trim, fuel or body word (GTI, Hybrid, Electric, Hatchback...). Any other word may name a car the catalog lacks.
3. Generation: the row's model years are counted against each of the model's Generations (`from`-`to`, open-ended while in production). The Generation holding the most of them is taken if it holds more than any other, more than half of them, and at least two (or the row's only year). Model years run ahead of production years, so a year two Generations share ("Golf 2020") decides nothing. A row mostly outside every Generation the catalog has belongs to one it lacks ("Golf GTI 2015-21" against a catalog with only the Golf VIII). The register also files some cars under a wide type around the real one ("Octavia SE 2000-2019" around "Octavia 5E 2013-2020"); when both hold every year of a row of two or more years, the narrower is taken.
4. Variants of that Generation that were built in at least two of the row's model years (or in its only one, or in their only one), and that started less than four years before the row's first model year. A Variant that ends or starts in a row's boundary year is usually the design before or after (the Superb II, filed with the Superb III, ending in 2015). One type approval can span two designs (the register's Civic FK runs 2006-2021), and a Variant built since 2009 is not the 2015 car the list rates. The fuel must fit too: a row stating a fuel takes only that fuel. A row stating none takes only the combustion fuels (petrol, diesel, LPG, CNG), unless the Generation has no combustion Variant (Ioniq 5, ID.4). comma lists electrified versions under their own names ("Kona Electric", "Kuga Plug-in Hybrid"), and the US "Explorer" row says nothing about the European Explorer EV.

Each Variant then shows the best level among the rows placed on it, with the model years the list gives that level for. The Kona gets "upstream, 2020", not a bare "upstream" over 2022-23 cars the list rates dashcam. The model page shows every placed row with its package, years, market note and link. The facet filters on the Variant's level, with "unlisted" for a Variant no row reached.

## Considered options

- **New Observation vs VariantFacts.** VariantFacts fills missing Specs on one resolved Variant; openpilot support is not a Spec, spans Variants and years, and needs census retirement. Reusing it would change what VariantFacts means. Chosen: a new kind.
- **Placement in the Publisher vs the Ledger snapshot.** The snapshot already resolves VariantFacts and Offers against the merged catalog with the Resolver; doing the same here keeps one place that knows how Observations land in the catalog, and the Publisher only projects. Chosen: the snapshot, in a private module (`packages/ledger/src/openpilot.ts`) tested through `record`/`snapshot`.
- **A curated row-to-Generation table.** Exact, but 341+ rows to maintain by hand as comma adds cars. Rejected in favour of the conservative rule above, checked against the real catalog (matched and unmatched rows and a hand-checked sample, recorded in the PR). A deny list stays the remedy if a wrong placement turns up.
- **Taking every Generation with three or more of the row's years.** Would cover a facelift the register files as its own Generation, but ADR 0011's Generations follow type approvals and registration years, so a large overlap does not prove the same platform. Rejected after envoy-peer review: one Generation per row.
- **Unstated fuel matches every fuel, or every fuel its sibling rows do not name.** The first puts the US Explorer's rating on the European Explorer EV. The second (the plain "Kona" leaves out the fuels "Kona Electric" names) was the first draft; the envoy-peer pointed out that a sibling establishes its own coverage, not the complement of another row. Chosen: an unnamed fuel is the combustion car.
- **One "compatible" flag.** The list's levels differ in what a buyer can do (plug and play, a community fork, dashcam only), so all six are kept; the badge shows only upstream and community.

## Consequences

- Most rows reference US cars. The badge reads as "comma lists this model and year as supported" and the model page says which market the list refers to. European equipment can differ (radar, camera, steering rack), so the page tells the reader to check on comma.ai.
- The package matters and a Variant does not know it ("Adaptive Cruise Control (ACC) & Lane Assist"): the model page shows it next to the level.
- Bundle format: `VariantRow.openpilot` and `ModelFile.openpilot` are optional fields an older reader ignores, so `BUNDLE_FORMAT` stays 3.
