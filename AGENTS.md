# comp-car-ator: agent guide

Domain words (Variant, Listing, Observation, Ledger, Bundle, landed price…) are defined in `CONTEXT.md`; use them exactly. Decisions and the alternatives behind them are in `docs/adr/`; read the ADR for a module before changing its interface.

## Checks

Run from the repo root (pnpm via corepack, Node 24):

```sh
pnpm install && pnpm lint && pnpm typecheck && pnpm test && pnpm --filter web build
```

`pnpm format` applies Biome fixes. CI runs the same five steps on GitHub-hosted runners.

## Where contracts live

Each interface lives in the package that owns it (`docs/adr/0001-module-map.md` has the full map):

- Observation union and value sets: `packages/vocabulary/src/observation.ts`, `vehicle.ts`, `catalog.ts`
- Source seam: `packages/sources/src/source.ts`
- Http: `packages/http/src/types.ts`
- Ledger: `packages/ledger/src/types.ts`
- Bundle format: `packages/bundle/src/format.ts`, reader/writer in `bundle.ts`
- Catalog query engine: `packages/catalog/src/types.ts`
- Landed price: `packages/pricing/src/pricing.ts`

Changing one of these is a contract change: update its ADR in the same PR, and regenerate the sample Bundle (`pnpm fixtures:bundle`) if the Bundle output changes.

## Design rules

The repo follows the codebase-design vocabulary: module, interface, seam, adapter, depth, leverage, locality.

- Build deep modules: a small interface over a lot of behaviour. Apply the deletion test to anything new: if deleting it moves no complexity into its callers, fold it away.
- Add a seam only where two or more adapters vary (today: Http live/replay, Source adapters, Loader fetch/fs/memory). Interfaces stay with their owning package; shared type grab-bags and a Ledger port stay out (the Ledger is tested on SQLite `:memory:`).
- The interface is the test surface: test Sources through `harvest`, the Ledger through `record`/`snapshot`, the Bundle through `encodeBundle`/`openBundle`, queries through `openCatalog`. Internal seams (Http's `TierFetcher`) may have their own tests inside their package.
- Replace, don't layer: when a test at a deeper interface covers a shallow one, delete the shallow test.
- Workspace packages export TypeScript source (`"exports": "./src/index.ts"`) and import with `.ts` extensions; Node 24 runs them directly. Keep syntax erasable (no enums, no parameter properties).
- Browser code imports `@cca/bundle`, never `@cca/bundle/node`.
- Mark deferred work `TODO(wave1-streamN)` with the stream that owns it.

## Adding a Source adapter

1. Create `packages/sources/src/<id>/<id>.ts` exporting `<id>Source(options?) : Source`, with `id` in kebab-case (`sauto`, `autoscout24-de`).
2. Fetch only through `ctx.http` (pass `signal: ctx.signal`; `binary: true` for PDF/ZIP), read time only from `ctx.now`.
3. Map site data onto Observations; leave a field undefined rather than guess. Put the site's own make/model ids in `vehicle.sourceTaxonomy`.
4. Incremental: newest first, stop when a page is all `ctx.checkpoint.isKnown(ref)`. Full: yield every listing in the adapter's `scope` or throw (a full run is a census). A site too large for one run slices its scope inside the adapter: yield `SliceDone` after each finished slice and skip slices whose `ctx.checkpoint.sliceDoneAt(slice)` is set, so a failed census resumes (ADR 0003). Price lists give each Offer a stable `ref` and withdraw it by re-emitting its edition with `validTo`. Catalog data that cannot fully identify a Variant goes out as `VariantFacts`, not a guessed `CatalogEntry`.
5. Register it in `packages/sources/src/registry.ts` (one line).
6. Record fixtures (below) and write `<id>.test.ts` that runs `harvest` against `createReplayHttp`, covering incremental, full, and one failure path (blocked or changed page).
7. Run the checks; the ingest CLI can then run it: `pnpm ingest run --source <id> --mode incremental --ledger /tmp/ledger.sqlite`.

## Fixture recording

- Record cassettes from the live site with the real adapter:
  `pnpm --filter @cca/sources record <id> <incremental|full> src/<id>/fixtures/<case>.cassette.json --now <ISO> [--last-run <ISO>]`
- Commit cassettes next to the test as `fixtures/<case>.cassette.json`; tests use the same `now` the cassette was recorded with.
- Keep cassettes small: limit pages through adapter options for the recording, and trim bodies by hand if a page is huge (keep the structure the parser reads). The recorder drops `set-cookie`; check for anything else personal before committing.
- Replay matches by URL with query order ignored; an unrecorded request fails with `ReplayMissError`, which means re-record.
- The sample Bundle in `fixtures/sample-bundle/` is generated from `fixtures/sample-observations.json` plus the ČNB cassette. Edit the observations, then run `pnpm fixtures:bundle`; a test fails when the committed Bundle drifts from the pipeline's output.
