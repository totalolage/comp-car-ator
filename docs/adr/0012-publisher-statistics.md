# The Publisher's rules for statistics, new prices and compaction

`publish(ledger, { now }) → BundleFiles` stays the Publisher's whole interface. Behind it, one streaming pass over `snapshot().listings()` builds the model files' Listing rows and samples the price history, and everything else (outliers, statistics, new prices, compaction) follows from the rules below. Same Ledger state and `now` give byte-identical files: every list is sorted by code-unit order or by the vocabulary's value order (`MARKETS`, `CONDITIONS`, `ODOMETER_BANDS`), never by locale or recording order. The numbers land in the Bundle v2 shapes of ADR 0004.

## Outlier rule

Applied before every statistic; outliers stay in the model file (flagged `excluded`) and in the catalog's (market, source) groups, so they remain findable through filters.

1. Floor: an asking price below 10,000 CZK is left out. Czech and German sites use 1 CZK / 1 € placeholders, monthly instalments and deposits as prices; a real 2000+ car under 10,000 CZK is rare enough to lose. This is product policy, not a proof of bad data.
2. Fences: within one cohort, resolution target (the Variant, or the model for Listings resolved only to the model) × Market × Condition over active Listings, with at least 8 prices above the floor and a nonzero interquartile range of ln(price), prices outside Tukey's far fences [Q1 − 3·IQR, Q3 + 3·IQR] on ln(price) are left out. Logs make the fences multiplicative, so a ten-times typo is caught while the ~3× spread across one generation's years is kept. Small cohorts (n < 8) and flat ones (IQR = 0, e.g. many identical dealer prices) get only the floor; their quartiles say nothing.
3. History points apply only the floor: a per-day median is robust already, and per-day fences would need per-day cohorts.

Gone Listings still in a model file are judged against the fences of their active cohort, so `excluded` means the same thing on every row.

## Statistics

Quantiles are p10, median and p90 by linear interpolation between order statistics, rounded to whole CZK (or km), each with the sample count behind it. Asking prices are converted at the Bundle's ČNB rates (the latest fixing per currency in the Ledger). The catalog row carries the Variant's active used Listings: availability `count` (outliers included), price/landed/odometer quantiles of the kept ones, and asking price per Market. The model file's cells cover new, demo and used Listings separately; year is first-registration year, else manufacture year; odometer bands are 0-10k, 10-50k, 50-100k, 100-150k, 150-200k, 200k+ km (lower bound inclusive). A cell under 3 Listings is left out. Selections across several years, Markets or any listing filter are recomputed from the model file's Listings by the model page.

## New price precedence

1. `list`: the Variant's current Czech manufacturer list-price editions on the publish day (per Offer the latest edition already in force, unless it has expired; an expired edition never revives an older one). Range over the Offers, `count` = Offers.
2. `dealer`: no current list price, so active Czech Listings of new cars from dealers resolved to the Variant and kept by the outlier rule, valued at their landed price (asking price plus seller extras, net prices normalised by Pricing). Range = actual min-max, `count` = Listings.

Demonstrators never set a new price (they are discounted); German and Austrian new cars never set the Czech one. Both appear in the model file's cells under their Market and Condition.

## Compaction

- Model files list active Listings plus those gone in the last 30 days; older gone Listings feed only `history`. A model page shows "recently sold" without carrying years of sold cars.
- A Listing row keeps its first 3 photos; the Source has the rest (`url`).
- `history` is weekly: one point per Monday plus the publish day, per Market. Daily points over years × 3 Markets × ~1,500 models would add ~100 MB to the Bundle for a chart that cannot show that resolution. A week without active Listings has no point (a gap, not zero). A Listing counts as active from its first sighting until it went; a Listing that reappears after being marked gone has its `gone` cleared by the Ledger, so the history shows it as active through the absence (the Ledger keeps no availability intervals).

## Scale

Measured run with `packages/publisher/scripts/scale.ts` on a synthetic Ledger (`src/synthetic.ts`: Zipf-skewed model popularity, 3 Markets, price changes, gone Listings, 1% outliers, 12 photos per Listing, Variants with full specs), Bundle in the columnar encoding of ADR 0004:

| Measure                       | Result                                                                                                           |
| ----------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| Synthetic Ledger              | 200,000 Listings (424,823 Observations over 180 daily runs), 50,000 Variants in 2,500 models, SQLite file 252 MB |
| `publish`                     | 7.8 s, peak RSS 598 MB (Node 24.18, 12-core devbox shared with other jobs)                                       |
| Bundle                        | 2,502 files, 54.6 MB raw, 9.8 MB gzip; 93,262 Listings published (active plus gone ≤ 30 days)                    |
| `catalog.json` (50k Variants) | 10.3 MB raw, 1.44 MB gzip, 0.62 MB brotli; opening and decoding it in Node takes ~0.2 s                          |
| Largest model file            | 2.25 MB raw, 0.39 MB gzip (the most popular model); median model file 10 KB                                      |

Before the columnar encoding the same Bundle was 119.5 MB raw and `catalog.json` 25.7 MB raw with sparser specs (stream 15 measured 41 MB with full specs). Synthetic data repeats itself more than real listings, so expect real compressed sizes up to ~2× these. Time and memory grow with the published Listings plus the history samples: one number per used Listing per week it was active, kept for every Listing the Ledger ever saw (~8 bytes each; a Listing on sale 2 months adds ~9). Extrapolated, not measured: a 1M-Listing Ledger with ~450k published Listings needs ~40 s and ~3 GB, dominated by the published rows; the history part stays under ~100 MB until the Ledger holds roughly ten million Listing-weeks. If it outgrows that, the fix inside the Publisher is a retention window for history.

Vercel Hobby (checked 2026-10-26, vercel.com/docs/limits): no limit on build output files created during a build (the 15,000-file and 100 MB total-size caps apply only to the source files a CLI deployment uploads; neither is a per-file limit), automatic gzip/brotli for JSON, 100 GB/month transfer and 1M CDN requests/month. Transfer is the binding limit, so per-model files and `catalog.json` are sized by their compressed bytes.

## Considered options

- **Pool Markets in statistics.** Rejected: German dealer prices are often net and Czech ones gross; one median hides the difference a buyer compares.
- **Mean ± k·σ or a fixed percentage trim.** Rejected: σ is dominated by the very outliers it should catch, and a fixed trim always drops data even from clean cohorts.
- **Precompute statistics for every filter combination.** Rejected (as B4 in ADR 0004): combinatorial; the model file carries the Listings to recompute any selection.
- **Daily history and all gone Listings.** Rejected for size, above.
