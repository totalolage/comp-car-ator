# The catalog comes from the Czech register; EEA and Wikidata only add to it

The catalog's Variants are counted out of the Czech vehicle register's open data (`rsv` Source): its monthly export lists every vehicle ever registered in CZ with its type-approval data, so vehicles that share make, model, type-approval type, body, fuel and power are one Variant once at least `minVehicles` (default 5) of them, made from 2000 on, back it. The EEA CO2 dataset (`eea-co2`) has no body, so it yields VariantFacts (engine size, WLTP CO2, mass, consumption) that the Ledger resolves onto those Variants. Wikidata is not a Source: it cannot state a Variant or a Spec the Ledger lacks, but it names generations and tells which types form one, so the `rsv` adapter joins it in, and a run fails without it (types would regroup and re-key Variants).

## How the register maps onto the vocabulary

- **Generation = type-approval type.** The register has no generation, but the EU type-approval type ("5E" Octavia III, "NX" Octavia IV, "204" C-Class W204) changes with each design cycle for most makes. The generation slug is the type's slug (`skoda/octavia/5e`); variant codes glued onto a type ("BWYD6BA") fold into the more common type they start with. Wikidata names a type when one of its dated generations of the same model starts within two years of the type's first core registration year and the type does not outlast it: the name then carries the numeral and the words listings use ("Golf VII (Mk7, 5G, AU)"), which the Resolver reads; types matching one Wikidata generation become one generation. A type Wikidata does not know is named by its code ("Octavia 5E"), so a listing that writes "Octavia III" resolves to the Model, not a Variant (the Resolver blocks generation claims the catalog lacks): coverage is lost, precision is not.
- **Model = the commercial name's model part.** "OCTAVIA COMBI 1.9 TDI" → Octavia, "C 220 CDI" → C-Class, "320D" → 3 Series (spellings the Resolver's alias groups know). Vehicles of a longer name ("Octavia Scout") whose type the shorter name also has belong to the shorter one; the rest keep their own model ("Tiguan Allspace", "Golf Plus" have types of their own).
- **Body** from the EU body code (AA sedan, AB hatchback, AC wagon, AD coupe, AE convertible, AF MPV); off-road category M1G is SUV. Older national approvals that state only doors ("5 DVEŘOVÁ") are skipped.
- **Fuel**: BA → petrol, NM → diesel, LPG, CNG; the electric flag → bev; the hybrid flag with class OVC-HEV → phev, NOVC-HEV → hev.
- **Production years** are the 2nd–98th percentile of the backing vehicles' manufacture years (else first registration, CZ or abroad); a Variant is ongoing (no `to`) while at least 2% of its vehicles are from the export's year.
- **Specs** are the value at least half the vehicles stating it share (Misra–Gries counters, so memory stays per Variant, not per vehicle); a split Spec (Kodiaq with 5 and 7 seats) is left out.
- Rows that cannot be mapped (no power, unknown fuel or body, no type) are counted and skipped; only a changed column set fails the run.

## Considered options

- **Wikidata as the generation source**: rejected. In 2026-10 only 181 Wikidata car generation items have dates, Octavia III/IV and every BMW generation among the missing ones.
- **A curated generation table** (make/model/type → numeral): deferred. It would let "Octavia III" listings match, but every entry needs checking against the register's years; start with the top CZ models when the Resolver's coverage numbers show the loss.
- **Dropping rare neighbours** (a Variant 20× smaller than one differing only in power ±3 kW, body or fuel): rejected after envoy-peer review. A missing Variant can make a listing match the wrong one; an extra one only makes it ambiguous.
- **EEA as a second CatalogEntry source**: rejected; without body it cannot identify a Variant (ADR 0003: VariantFacts).

## Consequences

- The export is about 19.5 million rows (≈10 GB of CSV). The stable URL serves it uncompressed; the monthly ZIP (≈2 GB) is found the way the site's page finds it (`GET /` hands out an `_ren` API token, the reports API lists the export's GUID and generation date). Neither supports Range, and the server resets long downloads (observed after 10 and 87 minutes), so the adapter streams the ZIP (`HttpRequest.stream`, ADR 0005; inflated on the fly), holds one record per candidate Variant, and starts the download over up to `attempts` (3) times; Variants are yielded only after a complete read. The generation date also lets an incremental run skip an export it has seen without downloading it.
- Generation slugs depend on which type is most common in a generation; a generation whose second type overtakes its first re-keys its Variants (ADR 0002). Rare in practice; a curated table would pin them.
- EEA data is CC BY 4.0 and needs visible attribution (`EEA_CO2_ATTRIBUTION`); the register's NKOD record states no terms of use (`RSV_ATTRIBUTION`). Showing them on the site is the web's job.
