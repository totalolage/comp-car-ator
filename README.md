<img src="assets/icon.svg" width="64" height="64" alt="">

# Car DB

A personal car comparison site for buying in Czechia: a catalog of car variants with new prices and used-price statistics, used listings from Czechia, Germany and Austria, and a landed-price estimate for imports. Live at [cardb.f8y.dev](https://cardb.f8y.dev); the old cars.f8y.dev redirects there.

- Domain vocabulary: [CONTEXT.md](CONTEXT.md)
- Architecture and decisions: [docs/adr/](docs/adr/) (start with [0001-module-map](docs/adr/0001-module-map.md))
- Working in the repo (checks, adding a Source, fixtures): [AGENTS.md](AGENTS.md)

```sh
corepack enable
pnpm install
pnpm --filter web dev        # site on the committed sample Bundle
pnpm test
```
