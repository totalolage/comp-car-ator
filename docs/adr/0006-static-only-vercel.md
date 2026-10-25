# The website is a static Astro build on Vercel: no functions, no runtime database

cars.f8y.dev is a fully static site: Astro with `output: "static"` and no adapter, Preact islands for interactivity, and all data read from a Bundle staged into `public/bundle/` at build time. There are no serverless functions, no runtime database and no runtime calls to external sources; filtering and faceting run in the browser through the catalog query engine. This keeps the personal project at $0 and well within Vercel Hobby limits, makes the site immune to scraper outages (a failed ingest just means yesterday's Bundle stays up), and avoids exposing anything that could be abused to proxy requests to the scraped sites.

## Consequences

- `vercel.json` pins the build: install with pnpm, `pnpm --filter web build`, output `apps/web/dist`. The Vercel project's root directory must stay the repository root so the workspace packages resolve.
- Production builds download the Bundle from the newest Data release (`releases/latest/download/bundle.json.gz`, ADR 0014) and fail if they cannot, so a broken download keeps the previous deployment up; `BUNDLE_URL` or `BUNDLE_DIR` override the source. Preview and local builds use the committed sample Bundle, so every preview deploy works without data.
- Model pages are pre-rendered per Model; per-Variant or per-listing pages would multiply the file count and are avoided.
- Data freshness is bounded by the deploy cadence (daily ingest → deploy hook).
