# Variant = make + model + generation + body + fuel + power + transmission

A catalog Variant is identified by make, model, generation, body, fuel, power (kW) and transmission, and its id is the path slug `make/model/generation/body-fuel-<kW>kw-transmission` (e.g. `skoda/octavia/mk4/wagon-diesel-110kw-automatic`). Trim, drive, colour and model year are not part of the identity. This is the level at which used listings can be told apart reliably: Czech and German listings state fuel, power and transmission far more often than trim, and the register and EEA datasets carry power and fuel but no trim. Trim lives on new prices (a Variant has a new-price range across trims) and as raw text on listings.

## Considered options

- **Include trim** (Octavia Style vs Ambition): rejected. Listings name trims inconsistently or not at all, so most listings would only resolve to the Model, and trims are renamed between model years.
- **Include drive** (FWD vs 4x4): rejected for now. Within one power output, 4x4 variants are rare, and listings often omit drive; the Resolver would turn many matches into ambiguities. Drive is a Spec; revisit if 4x4-heavy models (Kodiaq, Superb) show collisions.
- **Engine code or type-approval number**: rejected. Precise, but listings never show them, so Resolution could not use them.

## Consequences

- Ids are stable as long as a catalog Source keeps the same generation slug; renaming a generation slug re-keys its Variants.
- Two catalog Sources describing the same Variant converge on one id and are merged field by field in the Ledger.
- Power within ±3 kW counts as the same Variant during Resolution, to absorb kW/PS rounding.
