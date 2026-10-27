# Ingest runs from a private repo on self-hosted home runners; this public repo uses GitHub-hosted runners only

Scheduled ingest runs in the private repository `totalolage/comp-car-ator-ingest`, on ephemeral self-hosted runners at home (residential IP), and checks out this public repository at `main` to run the ingest CLI. This repository's CI runs only on GitHub-hosted runners. Residential egress is what gets most target sites to answer at T0/T1 (datacenter IPs score worse with Cloudflare and Akamai), but a self-hosted runner attached to a public repository would let anyone's fork pull request run code on a home machine, so the runners are registered only to the private repo.

## Consequences

- Never add `runs-on: self-hosted` (or any self-hosted label) to a workflow in this repository.
- The Ledger persists between runs in Data releases of the private repo; the ingest workflow restores the previous Ledger, runs Sources, publishes, releases the new Ledger and Bundle, and calls the Vercel deploy hook (ADR 0014). Only the Bundle the site serves is public.
- Everything the ingest job runs is code from this public repo's `main`, so it is reviewed like any other change; the private repo holds only workflow wiring and secrets.
- Runner infrastructure lives in the private `totalolage/home-runners` repo.
