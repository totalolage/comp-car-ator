import { aaaautoSource } from "./aaaauto/aaaauto.ts";
import { autoesaSource } from "./autoesa/autoesa.ts";
import { autoscout24Source } from "./autoscout24/autoscout24.ts";
import { cnbSource } from "./cnb/cnb.ts";
import { sautoSource } from "./sauto/sauto.ts";
import type { Source, SourceId } from "./source.ts";
import { tipcarsSource } from "./tipcars/tipcars.ts";

/**
 * Every Source adapter the ingest runner can run, by id. Adding an adapter = one line here
 * (see AGENTS.md "Adding a Source adapter").
 */
export const sources: Record<SourceId, () => Source> = {
  aaaauto: () => aaaautoSource(),
  autoesa: () => autoesaSource(),
  cnb: () => cnbSource(),
  tipcars: () => tipcarsSource(),
  "autoscout24-de": () => autoscout24Source({ country: "DE" }),
  "autoscout24-at": () => autoscout24Source({ country: "AT" }),
  sauto: () => sautoSource(),
};
