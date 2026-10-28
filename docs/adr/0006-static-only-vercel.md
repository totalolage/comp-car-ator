# The website is a static Astro build on Vercel: no functions, no runtime database

cars.f8y.dev is a fully static site: Astro with `output: "static"` and no adapter, Preact islands for interactivity, and all data read from a Bundle staged into `public/bundle/` at build time. There are no serverless functions, no runtime database and no runtime calls to external sources; filtering and faceting run in the browser through the catalog query engine. This keeps the personal project at $0 and well within Vercel Hobby limits, makes the site immune to scraper outages (a failed ingest just means yesterday's Bundle stays up), and avoids exposing anything that could be abused to proxy requests to the scraped sites.

## Consequences

- `vercel.json` pins the build: install with pnpm, `pnpm --filter web build`, output `apps/web/dist`. The Vercel project's root directory must stay the repository root so the workspace packages resolve.
- Production builds download the Bundle from the newest Data release in the private ingest repo with the read-only `BUNDLE_TOKEN` (ADR 0014) and fail if they cannot, so a broken download keeps the previous deployment up; `BUNDLE_DIR` overrides the source. Preview and local builds use the committed sample Bundle, so every preview deploy works without data or token.
- Model pages are pre-rendered per Model; per-Variant or per-listing pages would multiply the file count and are avoided.
- The staged Bundle is stored gzipped (`<path>.gz`, ADR 0004), and model pages carry no Listings (ADR 0009), so a deployment stays a few hundred MB with every Listing in it: daily deploys kept 30 days fit Hobby's deployment storage several times over. `apps/web/scripts/check-budget.mjs` reports the Bundle's size on every build.
- Data freshness is bounded by the deploy cadence (daily ingest → deploy hook).
