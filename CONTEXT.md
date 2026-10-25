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
The unit of the catalog: one Generation in one technical configuration, identified by body, fuel and power. Trim, transmission and colour are not part of it; the gearboxes a Variant is offered with are a Spec, stated only by Sources that know them.
_Avoid_: version, model (for this meaning), type, configuration

**Trim**:
A manufacturer equipment level sold on top of a Variant (Ambition, Style, Life); it changes the new price but not the Variant.
_Avoid_: grade, line, equipment

**Spec**:
A technical fact about a Variant (seats, consumption, CO2, engine displacement).
_Avoid_: attribute, feature

**New price**:
The current gross price a Czech buyer pays a dealer for a new car of an Offer, taken from manufacturer price lists. A Variant's New price is the range over its Offers; a Variant without a current Offer takes the range of landed prices of active Czech dealer Listings of new cars, labelled as such.
_Avoid_: MSRP, list price (in prose)

**Offer**:
One priced configuration on a manufacturer price list (Trim, engine, drive, gearbox, model year), identified by its Source across price-list editions. Several Offers usually belong to one Variant; each edition of an Offer is valid from a day, and optionally until a day.
_Avoid_: price-list item, configuration

### Listings

**Listing**:
One car offered for sale at a Source, with its asking price, odometer and history of prices.
_Avoid_: ad, offer (that is a price-list Offer), inzerát (in code)

**Market**:
The country where a Listing's car stands and is sold (CZ, DE, AT).
_Avoid_: country (alone), region, origin

**Condition**:
Whether a Listing's car is new, a demonstrator, or used.
_Avoid_: state, status

**New means of transport**:
A car that counts as new for VAT when it moves between EU states: at most 6 months since first registration or at most 6,000 km. Its Czech buyer pays Czech VAT on the price net of the Market's VAT. Decided from registration and odometer, not from Condition.
_Avoid_: new car (for the VAT test)

**Price basis**:
What a Listing's asking price includes with respect to VAT: gross, net, margin scheme, or unknown.
_Avoid_: VAT status, tax mode

**Seller extras**:
Charges a Listing's seller invoices on top of the asking price that the buyer cannot decline (delivery, preparation, dealer fees), with their own Price basis. Transport the buyer arranges is not one.
_Avoid_: fees (alone), add-ons

**Days on market**:
Days from when a Listing was first seen (or posted, if earlier) until it was gone, or until today.
_Avoid_: age, listing age

**Gone**:
A Listing that is no longer offered: reported removed by its Source, or missing from two consecutive complete census runs.
_Avoid_: sold, deleted, expired

**Landed price**:
The estimated total in CZK to buy a Listing's car and register it in Czechia: price and seller extras converted at the ČNB rate, Czech VAT on both where the car counts as new, transport, inspection, registration and eco fees. For Czech Listings it is the asking price plus seller extras.
_Avoid_: total cost, import price, final price

**Used-price statistics**:
Count, p10, median and p90 of asking prices in CZK over a Variant's (or Model's) active Listings, after the outlier rule leaves out implausible prices; per Market, and broken down by Condition, year and odometer band.
_Avoid_: price stats, market value

### Data

**Source**:
One external website, API or dataset that the app harvests (Sauto, AutoScout24 DE, the Czech vehicle register, ČNB).
_Avoid_: site, provider, scraper, feed

**Observation**:
One fact a Source saw during a run, in the app's shared vocabulary: a Listing seen, a Listing gone, a catalog entry, a new price, an FX rate, or a Slice done.
_Avoid_: record, event, item

**Run**:
One harvest of one Source, either incremental (only what is new) or full (a census of everything the Source covers).
_Avoid_: crawl, scrape, job

**Census**:
The full Runs of a Source's scope up to and including a complete one: together they saw every Listing the Source currently offers in that scope, so absence means the Listing may be gone. Failed full Runs in between contribute the Slices they finished.
_Avoid_: full scan, sweep

**Slice**:
A part of a Source's scope that its adapter harvests as one unit, keyed by the adapter (an AutoScout24 make/model/year/price query under the result cap). A full Run reports each Slice it finished, so a Census that fails part way resumes with the Slices left.
_Avoid_: shard, partition, chunk

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

**Run log**:
A Run written to a file instead of the Ledger: its Observations and whether the harvest completed. Harvest jobs write them; one job records them into the Ledger.
_Avoid_: dump, artifact (in code)

**Data release**:
A GitHub Release of the public repo holding one ingest's Ledger, the Bundle published from it and a manifest. The newest is where the next ingest starts and what the site builds from.
_Avoid_: snapshot, backup, export

## Relationships

- A **Make** has many **Models**; a **Model** has many **Generations**; a **Generation** has many **Variants**.
- A **Listing** belongs to exactly one **Source** and one **Market**, and resolves to at most one **Variant** (or only a **Model**).
- A **Run** of a **Source** produces **Observations**; the **Ledger** records them; a **Bundle** is published from the **Ledger**.
- A daily ingest restores the **Ledger** from the newest **Data release**, records each **Run log**, and releases the new **Ledger** with its **Bundle** as the next **Data release**.
- A **Landed price** is computed for a **Listing** from its **Market**, seller, **Price basis**, whether it is a **New means of transport**, and the latest **FX rate**.
