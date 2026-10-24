# Bundle owns the format (writer + reader); the catalog query engine owns querying

The published data is a Bundle: a directory of static files written by the Publisher and read by the website. One module, `@cca/bundle`, owns both sides of the format: the decoded document types (`BundleContent` = manifest + catalog index + one model file per Model), a pure writer `encodeBundle(content) → files`, and a reader `openBundle(loader)` with `catalog()` and `model(id)`. The catalog query engine, `@cca/catalog`, sits on the reader: `openCatalog(loader)` loads the manifest and catalog index once, then `query(filters, sort, page)` is synchronous and returns rows plus facet counts, and `model(id)` returns a view whose `listings(query)` runs the same facet engine over that model's listings. File names, sharding and encoding are private to Bundle, so the Publisher and the web never change when the layout does.

## Format v1

- `manifest.json`: format version, publish time, FX rates used, source run times, counts. The reader refuses any other format version (`BundleFormatError`); bump `BUNDLE_FORMAT` for any change an older reader cannot read.
- `catalog.json`: makes, models, and one row per Variant with specs, new-price range and used-price statistics. Loaded once by the browser; everything the facet rail needs.
- `models/<make>/<model>.json`: generations, the model's listings (with landed price and price history), statistics by year and odometer band, and the daily median price series. Loaded on demand.

Plain JSON for v1. At ~50k Variants `catalog.json` will be several MB uncompressed; switching it to a columnar, dictionary-encoded layout is a change inside Bundle only.

## Facet semantics

Values inside one facet are OR-ed and facets are AND-ed. Counts are disjunctive: each facet's counts apply every active filter except its own, so the rail always shows what another choice would yield (the McMaster-Carr behaviour).

Listing-level filters on the catalog (market, source, used price, odometer) must hold together: each Variant row carries its active used listings split into (market, source) groups with price, odometer and year ranges, and a Variant matches when one group satisfies all of them. Without the groups, a Variant with Czech listings on Sauto and German ones on AutoScout24 would wrongly match "Germany + Sauto" (found by the envoy-peer review). Inside a group, price and odometer are compared by range overlap, so the catalog stays an approximation; exact per-listing filtering (and landed price) happens in `model(id).listings(query)`. The query engine expands each Variant into one row per group and counts distinct Variants.

## Considered options (design it twice)

- **B1, chosen: Bundle = format (types + writer + reader), catalog = query engine on the reader.** Format locality in one module, query locality in another; the decoded types are a shared contract that the Astro build, the islands and the Publisher all use.
- **B2: merge reader and query engine into one module.** The encoding could be co-designed with querying (precomputed facet bitsets, columnar scans), but the Publisher (Node) would depend on the query engine, and pages that just render a model file would have to go through query calls. Kept as a later option: the writer may emit extra precomputed indexes that the query engine consumes, still behind Bundle.
- **B3: publish the Ledger read model as SQLite and query it in the browser (sql.js + HTTP range requests).** One format and SQL for facets, but ~1 MB of wasm before first paint, awkward caching on static hosting, and the web would be coupled to the Ledger schema (no format locality at all). Rejected.
- **B4: pre-render every filter combination as static JSON.** Combinatorial explosion. Rejected.
- **B5: row iterators (`variants()`, `listings(modelId)`) instead of whole documents.** Streaming is pointless when the browser needs the whole catalog index in memory for instant faceting; more interface for no caller. Rejected.

## Loader seam

`Loader = (path) => Promise<string | null>` has three adapters: `fetchLoader(baseUrl)` in the browser, `fsLoader(dir)` at build time and in Node (`@cca/bundle/node`), and `memoryLoader(files)` in tests, fed straight from `encodeBundle`. Three real adapters, so a real seam.
