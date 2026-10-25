# Fetch tiers are internal to Http; callers see only `get(request) → Page`

Sources reach websites through one Http module whose interface is `get(request) → Page`. Inside, three fetch tiers sit behind an internal seam (`TierFetcher`): T0 is plain `fetch` with browser headers; T1 is TLS/HTTP2 impersonation (Impit); T2 is a stealth browser (Patchright or Camoufox under Xvfb). Http starts at T0 (or the request's `minTier`), recognizes bot challenges (Cloudflare `cf-mitigated`, Akamai 403, EdgeOne), and escalates to the next available tier; a challenge at the highest tier rejects with `HttpBlockedError`. Pacing (~1 request/s per host by default, serialized per host, hosts in parallel), retry with backoff on 429/5xx and network errors, and charset decoding live here too. We hid the tiers because the research showed protection differs by site and changes over time (TipCars passes T0 with a Chrome UA today but may need T1 from datacenter IPs); if each adapter chose its own tool, every protection change would touch adapters instead of one module.

## Consequences

- Wave 0 ships T0 only; T1 and T2 are stubs that report themselves unavailable (Wave 1 stream 1). A request for an unavailable tier falls back to the highest available one.
- The replay adapter applies the same challenge rule to recorded responses, so an adapter's handling of blocks is testable from fixtures.
- Any final HTTP status is a Page; deciding that 404 means "listing gone" is the adapter's job.
- Http is GET-only. `binary: true` returns raw bytes (`Page.bytes`) for PDF price lists and ZIP datasets; cassettes store them base64-encoded. Responses are buffered in memory, so multi-GB bulk downloads (the full vehicle register) need a streaming addition when stream 8 gets there.
- `request.signal` aborts in-flight fetches and backoff waits.
- The raw response cache from the plan is not built yet (Wave 1 stream 1).
