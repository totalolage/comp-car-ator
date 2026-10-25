# Manufacturer price lists: read the importers' PDFs, withdraw from the Ledger's editions

New prices come from the Czech importers' own price lists (ceníky), one Source per brand: `skoda-pricelist` and `vw-pricelist`. Both are thin brand adapters over one price-list module (`packages/sources/src/pricelist/`), which owns fetching, PDF text extraction (unpdf, pure JS), turning rows into `ListPrice`, rejecting malformed rows and withdrawing Offers. A brand adapter says where its lists are (`models`) and how one reads (`read`). The two brands vary in exactly that, so the split is a seam with two adapters; Toyota, Hyundai or Kia would be a third.

## Decisions

- **The PDF is the authority.** It is the only public document that prices every Offer and states the day its prices start ("Platnost od"). The brands' configurator APIs (Škoda CC3, VW's Porsche Informatik CC) publish codes, model years and "from" prices per trim, but no per-Offer price and no date, so an edition's `validFrom` would have to be guessed. Škoda's configurator still supplies two fields its lists leave out: model year and body, per model name.
- **Offer codes.** VW rows carry the manufacturer's sales code (`CT1CPT03`), which is the code. Škoda rows carry none, so the code is built from what the row prices: model (with Combi/Coupé), engine, fuel, gearbox, drive and trim line (`octavia-combi.2-0-tdi-110-kw.diesel.a7.fwd.selection`). Model year stays out of both: VW's file names show it only sometimes, and an Offer must keep its ref across editions. A ref is `<model key>/<code>`, so the Ledger's editions say which model's lists an Offer came from.
- **Withdrawal.** Manufacturers keep no archive of earlier editions, so the Source compares the current lists with `checkpoint.offersInForce()` (ADR 0003). Only full runs withdraw, and only Offers of a model whose every list was fetched and read without a rejected row, ending the day before that model's newest list starts; a model that left the brand's index ends the day before the run, provided another model read cleanly. Incremental runs read the same lists and never withdraw.
- **Failure.** An unreadable list (not a PDF, no date, a layout that yields no row) is skipped with a warning and withdraws nothing; the run fails only when no list of the brand reads, which is what a redesign looks like. Blocked or unreachable Http fails the run as for any Source.

## Alternatives

- **Configurator JSON as the price source.** Machine-readable, but undated and incomplete per Offer; rejected as the authority, kept for model year and body.
- **The Ledger infers withdrawals** (Offers a complete full run did not see end), as it does for listings. Rejected in ADR 0003: the Ledger cannot tell which document an Offer came from, so one unreadable PDF would retire a whole model.
- **pdftotext (poppler) for extraction.** Simpler layout output, but a system dependency on every runner; unpdf's positioned text plus column assignment by header position covers both brands' tables.
- **VW Group OKAPI.** Official, but needs company registration and approval; not available to this project.
