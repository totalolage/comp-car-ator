import { cnbSource } from "./cnb/cnb.ts";
import type { Source, SourceId } from "./source.ts";

/**
 * Every Source adapter the ingest runner can run, by id. Adding an adapter = one line here
 * (see AGENTS.md "Adding a Source adapter").
 */
export const sources: Record<SourceId, () => Source> = {
  cnb: () => cnbSource(),
};
