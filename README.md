<img src="assets/icon.svg" width="64" height="64" alt="">

# comp-car-ator

A personal car comparison site for buying in Czechia: a catalog of car variants with new prices and used-price statistics, used listings from Czechia, Germany and Austria, and a landed-price estimate for imports. Live at [cars.f8y.dev](https://cars.f8y.dev).

- Domain vocabulary: [CONTEXT.md](CONTEXT.md)
- Architecture and decisions: [docs/adr/](docs/adr/) (start with [0001-module-map](docs/adr/0001-module-map.md))
- Working in the repo (checks, adding a Source, fixtures): [AGENTS.md](AGENTS.md)

```sh
corepack enable
pnpm install
pnpm --filter web dev        # site on the committed sample Bundle
pnpm test
```
