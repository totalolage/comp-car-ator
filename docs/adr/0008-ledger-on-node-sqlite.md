# The Ledger is one SQLite file accessed through `node:sqlite`, with Resolution at snapshot time

The Ledger is a single SQLite file, opened with Node's built-in `node:sqlite` (`DatabaseSync`), with append-only migrations tracked in a `meta` table. A file is the natural unit to carry between ephemeral ingest runs as a release asset, and SQLite gives transactions, indexes and SQL for the read model without a server. We chose `node:sqlite` over `better-sqlite3` because it ships with Node 24: no native module to compile or download on home runners, CI and contributors' machines, and the same synchronous API shape. Tests open `:memory:`, which is why the Ledger has no port (a local-substitutable dependency; see ADR 0001).

Listings are matched to catalog Variants when the Ledger produces a snapshot, not when an Observation is recorded. The catalog changes monthly and the Resolver will keep improving (Wave 1 stream 11); resolving at snapshot time means every publish uses the latest catalog and Resolver, with no stored matches to migrate. The cost is re-resolving every listing per publish, which is in-process and cheap at the expected ~150k listings. Because the model a listing belongs to exists only in the snapshot, `snapshot().listings(ids)` reads given listings back by id: the Publisher makes one pass to group ids by model and then reads one model at a time, so it never holds every listing (ADR 0012, Scale). The alternative, storing each listing's Resolution so SQL can group by model, would bring back the stored matches this decision avoids.

## Consequences

- One writer at a time; the ingest job owns the file.
- Never edit a shipped migration; append a new one. A Ledger newer than the code refuses to open.
- If `node:sqlite` changes incompatibly before it is marked stable, swapping to `better-sqlite3` touches only `packages/ledger`.
