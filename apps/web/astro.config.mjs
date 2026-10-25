import preact from "@astrojs/preact";
import { defineConfig } from "astro/config";

// Static output only: no adapter, no server routes (docs/adr/0006-static-only-vercel.md).
export default defineConfig({
  site: "https://cars.f8y.dev",
  output: "static",
  integrations: [preact()],
  // Internal links fetch their page on hover, so the click opens from cache.
  prefetch: { prefetchAll: true, defaultStrategy: "hover" },
  i18n: {
    locales: ["cs", "en"],
    defaultLocale: "cs",
    routing: { prefixDefaultLocale: false },
  },
});
