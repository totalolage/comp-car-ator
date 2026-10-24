# Source seam: `harvest(ctx) → AsyncIterable<Observation>` over a closed Observation union

Every Source adapter satisfies one interface, `Source { id; scope?; harvest(ctx) }`, and emits Observations from one closed union: `ListingSeen | ListingGone | FxRate | CatalogEntry | VariantFacts | ListPrice`. The context gives the adapter everything it may touch: the Http module, the harvest mode (incremental or full), a read-only Checkpoint (`lastRunAt`, `isKnown(ref)`), the run's clock, a logger and an abort signal. Observations carry no source id and no timestamp; the Ledger stamps both from the run. This is the one external seam with many adapters (Sauto, TipCars, Bazoš, AAA Auto, Autoesa, AutoScout24, mobile.de, the vehicle register, EEA, Wikidata, price lists, ČNB), so its depth decides how much each Wave 1 stream has to know: an adapter author learns one method and six Observation shapes, and everything else (paging, parsing, query slicing, stop rules) stays inside the adapter.

## Contract

- Lazy: no request before the first `next()`. Duplicates are allowed; the Ledger is idempotent.
- `full` means census of the adapter's `scope`: it yields a ListingSeen for every listing in that scope or throws. Census inference only touches listings last seen under the same scope, so AutoScout24 slices (one adapter instance per slice, e.g. `scope: "makes:skoda"`) never retire each other's listings. A thrown harvest, or a full run with any rejected Observation, never counts as a census, so a broken parser cannot mark the site gone. Misses count at most once per day, so re-running a full harvest the same day is harmless.
- `incremental` may stop early (newest first, stop at `isKnown`). The Ledger never infers absence from incremental runs, and incremental runs do not refresh prices of listings they skip; price changes of known listings come from full runs, so each listing Source needs a full-run cadence (weekly or better).
- All network access goes through `ctx.http`, passing `ctx.signal` so aborts interrupt in-flight requests; the clock only through `ctx.now`. That is what makes the adapter testable through `harvest` with the replay Http adapter and a fixed `now`.

## Considered options (design it twice)

- **A1, chosen: one async-iterable `harvest` per adapter, closed union, run-stamped envelope.** One seam, one code path in the Ledger and runner. Streaming lets the Ledger batch transactions and lets the runner abort.
- **A2: two-phase adapter `listPages(query) → raw` + `parse(raw) → Listing[]`** (the shape the scrape research suggested). Parsing becomes testable without Http, but pagination and stopping move into the runner, and every site paginates differently (offsets, per-make categories, query slicing under AutoScout24's 4,000-result cap). The runner would grow per-site branches: shallow adapters, leaky runner. Rejected; adapters can still keep `parse` as an internal function with its own tests.
- **A3: one interface per kind (`ListingSource`, `CatalogSource`, `FxSource`)** with typed returns. The type would say what a Source emits, but it triples the seam and the runner's code paths, and real Sources emit several kinds (Sauto: used and new listings; a manufacturer price list: ListPrice and CatalogEntry). Rejected.
- **A4: push style `harvest(ctx, emit)`.** Simple to write, but no backpressure or natural cancellation, and tests need a fake sink. Rejected.
- **A5: adapter-stamped envelope (`source`, `observedAt` on each Observation).** Every adapter would have to get both right, and the run already knows them. Rejected.

An envoy-peer review (another model family) agreed A1 beats A2–A5 and pushed for the census-scope, rejection and same-day rules above, which are now part of the contract.

## Observation vocabulary notes

- `VehicleDescriptor` is the raw description a Source gives (make/model/trim text, source taxonomy ids, registration, specs it states); it is the Resolver's input, together with the SourceId that namespaces the taxonomy ids. Sources map their own labels onto the closed value sets and leave a field undefined rather than guess.
- `CatalogEntry` fully identifies a Variant and is the only kind that creates one. `VariantFacts` carries partial Spec evidence from Sources that cannot identify a Variant on their own (EEA has no body, Wikidata is sparse): the Ledger resolves it at snapshot time and fills Specs the CatalogEntries left empty, never overriding them. Catalog Sources therefore never guess missing identity fields.
- `ListPrice` is a new price from a manufacturer price list, one per trim and edition (`validFrom`). Dealer new and demo cars are `ListingSeen` with `condition` new/demo, not ListPrice.
- `ListingSeen.inspectionValidUntil` carries a shown German/Austrian inspection date into the landed price.
- `FxRate` is per single unit (`kurz / množství`), so per-100 quotes are normalized at the Source.
- Adding an Observation kind is a breaking change to the seam: extend the union, the Ledger's validation and recording, and this ADR together.
