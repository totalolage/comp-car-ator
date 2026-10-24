# comp-car-ator

A personal car comparison site for a Czech buyer: a catalog of car variants with new prices and used-price statistics, plus individual used listings from Czechia, Germany and Austria, with an estimate of what an imported car costs once registered in Czechia.

## Language

### Catalog

**Make**:
A car manufacturer brand as buyers know it (Škoda, Volkswagen, Toyota).
_Avoid_: brand, manufacturer, marque

**Model**:
A named product line of a Make that spans several generations (Octavia, Golf).
_Avoid_: series, nameplate

**Generation**:
One design cycle of a Model with its own production years (Octavia IV, Golf VIII).
_Avoid_: mark, series, platform

**Variant**:
The unit of the catalog: one Generation in one technical configuration, identified by body, fuel, power and transmission. Trim and colour are not part of it.
_Avoid_: version, model (for this meaning), type, configuration

**Trim**:
A manufacturer equipment level sold on top of a Variant (Ambition, Style, Life); it changes the new price but not the Variant.
_Avoid_: grade, line, equipment

**Spec**:
A technical fact about a Variant (seats, consumption, CO2, engine displacement).
_Avoid_: attribute, feature

**New price**:
The current gross price a Czech buyer pays a dealer for a new car of a Variant and Trim, taken from manufacturer price lists.
_Avoid_: MSRP, list price (in prose)

### Listings

**Listing**:
One car offered for sale at a Source, with its asking price, odometer and history of prices.
_Avoid_: ad, offer, inzerát (in code)

**Market**:
The country where a Listing's car stands and is sold (CZ, DE, AT).
_Avoid_: country (alone), region, origin

**Condition**:
Whether a Listing's car is new, a demonstrator, or used.
_Avoid_: state, status

**Price basis**:
What a Listing's asking price includes with respect to VAT: gross, net, margin scheme, or unknown.
_Avoid_: VAT status, tax mode

**Days on market**:
Days from when a Listing was first seen (or posted, if earlier) until it was gone, or until today.
_Avoid_: age, listing age

**Gone**:
A Listing that is no longer offered: reported removed by its Source, or missing from two consecutive complete census runs.
_Avoid_: sold, deleted, expired

**Landed price**:
The estimated total in CZK to buy a Listing's car and register it in Czechia: price converted at the ČNB rate, Czech VAT where the car counts as new, transport, inspection, registration and eco fees. For Czech Listings it is the asking price.
_Avoid_: total cost, import price, final price

**Used-price statistics**:
Quantiles of asking prices over a Variant's active used Listings, also broken down by year and odometer band.
_Avoid_: price stats, market value

### Data

**Source**:
One external website, API or dataset that the app harvests (Sauto, AutoScout24 DE, the Czech vehicle register, ČNB).
_Avoid_: site, provider, scraper, feed

**Observation**:
One fact a Source saw during a run, in the app's shared vocabulary: a Listing seen, a Listing gone, a catalog entry, a new price, or an FX rate.
_Avoid_: record, event, item

**Run**:
One harvest of one Source, either incremental (only what is new) or full (a census of everything the Source covers).
_Avoid_: crawl, scrape, job

**Census**:
A complete full Run: every Listing the Source currently offers in its scope was seen, so absence means the Listing may be gone.
_Avoid_: full scan, sweep

**Resolution**:
The match of a Listing's or new price's raw make/model description to a catalog Variant, or only to a Model when the Variant is ambiguous.
_Avoid_: mapping, matching, normalization

**FX rate**:
The ČNB daily fixing: how many CZK one unit of a foreign currency costs on a given day.
_Avoid_: exchange rate (in code), kurz

**Ledger**:
The app's long-lived memory of everything Observed across Runs: Listings with their price history, the catalog, new prices and FX rates.
_Avoid_: database, store, warehouse

**Bundle**:
The published, read-only snapshot of the Ledger that the website renders: catalog index, per-Model files with Listings and price history.
_Avoid_: export, dump, dataset, build data

## Relationships

- A **Make** has many **Models**; a **Model** has many **Generations**; a **Generation** has many **Variants**.
- A **Listing** belongs to exactly one **Source** and one **Market**, and resolves to at most one **Variant** (or only a **Model**).
- A **Run** of a **Source** produces **Observations**; the **Ledger** records them; a **Bundle** is published from the **Ledger**.
- A **Landed price** is computed for a **Listing** from its **Market**, **Price basis**, **Condition** and the latest **FX rate**.
