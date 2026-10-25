# Module map: deep modules in a pnpm monorepo, seams only where adapters vary

The codebase is a TypeScript pnpm workspace (Node 24) of deep modules, one package each, with interfaces living in the package that owns them. There is no shared `ports` or `types` grab-bag: the only cross-cutting package is the domain vocabulary, and a seam exists only where at least two adapters vary behind it (Http: live and replay; Source: one adapter per site; Loader: fetch, file system and memory). We chose this over a hexagonal layout with a port for every dependency because most dependencies here are in-process or local-substitutable, and a port with one adapter is indirection that costs every caller.

## Modules

| Package             | Interface (the test surface)                                                                                 | Hides                                                                                                   |
| ------------------- | ------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------- |
| `@cca/vocabulary`   | Observation union, value sets (Fuel, Body, Market…), `VehicleDescriptor`, `VariantSpec`, id functions        | The Variant identity rule, slugging, Prague dates                                                       |
| `@cca/http`         | `Http.get(request) → Page`; adapters `createLiveHttp()`, `createReplayHttp(cassette)`, `recordingHttp(http)` | Tier escalation T0 → T1 → T2, per-host pacing, retry/backoff, challenge detection, charset decoding     |
| `@cca/sources`      | `Source.harvest(ctx) → AsyncIterable<Observation>`; registry `sources`                                       | Per-site pagination, parsing, query splitting, incremental stop rules                                   |
| `@cca/ledger`       | `openLedger(path)` → `record(run, observations)`, `checkpoint(source)`, `snapshot()`                         | SQLite schema and migrations, batching, dedup, price history, gone inference, catalog merge, Resolution |
| `@cca/resolver`     | `createResolver(catalog).resolve(descriptor, source?) → Resolution`                                          | Make aliases, model prefix match, generation by year, spec narrowing                                    |
| `@cca/pricing`      | `landedPrice(input, env) → LandedResult`                                                                     | CZ/DE/AT VAT rules, the "new means of transport" test, fees                                             |
| `@cca/bundle`       | Decoded document types; `encodeBundle(content) → files`; `openBundle(loader) → reader`                       | File layout, sharding, encoding, format versioning, read caching                                        |
| `@cca/publisher`    | `publish(ledger, { now }) → files`                                                                           | Grouping by model, used-price statistics, landed prices, price history series                           |
| `@cca/catalog`      | `openCatalog(loader)` → `query(q)`, `model(id).listings(q)`                                                  | Filter evaluation, disjunctive facet counts, range bounds, sort, paging                                 |
| `@cca/ingest` (app) | CLI `run`, `publish`, `import`, `sample-bundle`                                                              | Composition only                                                                                        |
| `web` (app)         | Static Astro site; `read/writeCatalogState`, `openStore`, `i18n(lang)` (ADR 0009)                            | Presentation over `@cca/catalog`; canonical URL state, browser memory, cs/en strings and formats        |

Dependency direction: vocabulary ← http ← sources ← ledger (also ← resolver) ← publisher (also ← pricing, bundle) ← ingest; web → catalog → bundle → pricing (types) → vocabulary. The web never imports Node-only code; `@cca/bundle/node` holds the file-system helpers.

## Deletion test

- Delete **Http** and pacing, retries, tier escalation and fixture replay reappear in every Source adapter.
- Delete **Ledger** and dedup, history and gone inference reappear in the ingest runner and the Publisher.
- Delete **Bundle** and the file layout leaks into both the Publisher and the web; any format change touches both.
- Delete **catalog** and every page re-implements faceting.
- Delete **Resolver** and its logic lands inside the Ledger, where Wave 1 stream 11 could not test it on its own.
- **vocabulary** is not a pass-through: it is the Source seam's contract plus the Variant identity rule.

## Rules for new code

- Put a new interface in the package that owns the behaviour, not in a shared package.
- The Ledger has no port; tests use SQLite `:memory:`. Do not add a Store interface.
- Test through the interface: Source adapters through `harvest` with the replay Http, the Ledger through `record`/`snapshot`, the Bundle through `encodeBundle`/`openBundle`, the query engine through `openCatalog`.
