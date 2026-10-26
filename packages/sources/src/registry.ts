import { aaaautoSource } from "./aaaauto/aaaauto.ts";
import { autoesaSource } from "./autoesa/autoesa.ts";
import { autoscout24Source } from "./autoscout24/autoscout24.ts";
import { bazosSource } from "./bazos/bazos.ts";
import { cnbSource } from "./cnb/cnb.ts";
import { eeaCo2Source } from "./eea-co2/eea-co2.ts";
import { mobiledeSource } from "./mobilede/mobilede.ts";
import { rsvSource } from "./rsv/rsv.ts";
import { sautoSource } from "./sauto/sauto.ts";
import { skodaPricelistSource } from "./skoda-pricelist/skoda-pricelist.ts";
import type { Source, SourceId } from "./source.ts";
import { tipcarsSource } from "./tipcars/tipcars.ts";
import { vwPricelistSource } from "./vw-pricelist/vw-pricelist.ts";

/**
 * Every Source adapter the ingest runner can run, by id. Adding an adapter = one line here
 * (see AGENTS.md "Adding a Source adapter").
 */
export const sources: Record<SourceId, () => Source> = {
  aaaauto: () => aaaautoSource(),
  autoesa: () => autoesaSource(),
  cnb: () => cnbSource(),
  "eea-co2": () => eeaCo2Source(),
  rsv: () => rsvSource(),
  tipcars: () => tipcarsSource(),
  "autoscout24-de": () => autoscout24Source({ country: "DE" }),
  "autoscout24-at": () => autoscout24Source({ country: "AT" }),
  /**
   * Experimental: T2 only, not scheduled; `CCA_MOBILEDE_MAKES=25200,3500` scopes it to those
   * makes (docs/adr/0015-mobile-de-experimental.md).
   */
  "mobile-de": () =>
    mobiledeSource({ makes: process.env.CCA_MOBILEDE_MAKES?.split(",").map(Number) }),
  sauto: () => sautoSource(),
  "skoda-pricelist": () => skodaPricelistSource(),
  "vw-pricelist": () => vwPricelistSource(),
  bazos: () => bazosSource(),
};
