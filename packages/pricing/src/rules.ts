/**
 * Every rate, fee and threshold the landed price uses, next to where it comes from. Each
 * breakdown line's code is a key here, so `PRICING_RULES[line.code]` is that line's rule
 * reference. Research notes: import-and-china.md §4–§5 and at-import-notes.md (2026-10-24/25).
 */
import type { IsoDate } from "@cca/vocabulary";
import type { LandedLineCode } from "./pricing.ts";

export interface PricingSource {
  /** Law, price list or method, short enough for a tooltip. */
  cite: string;
  url: string;
}

export interface PricingRule {
  sources: readonly PricingSource[];
  /** Day the sources were last checked. */
  asOf: IsoDate;
  /** A price list or market estimate, not law. */
  indicative?: boolean;
}

/** A rule plus the values it sets (rates, fees, thresholds). */
type RuleEntry = PricingRule & { readonly [value: string]: unknown };

const ZDPH = "https://www.zakonyprolidi.cz/cs/2004-235";
const VAT_DIRECTIVE =
  "https://eur-lex.europa.eu/legal-content/EN/TXT/HTML/?uri=CELEX%3A02006L0112-20250320";
const YOUR_EUROPE_VAT =
  "https://europa.eu/youreurope/citizens/vehicles/cars/vat-buying-selling-cars/index_en.htm";
const ZAKON_56_2001 = "https://www.zakonyprolidi.cz/cs/2001-56";

export const PRICING_RULES = {
  /** CZ Listing: the asking price; a VAT payer's net amounts get Czech VAT. */
  price: {
    sources: [{ cite: "zákon 235/2004 Sb. (ZDPH) §47: 21% VAT", url: ZDPH }],
    asOf: "2026-10-24",
  },
  /**
   * Imported car at the ČNB rate. New means of transport: net of the Market's VAT (exempt
   * intra-EU supply); a private seller's agreed price as is. Used: what the buyer pays,
   * foreign VAT included because a private buyer cannot reclaim it.
   */
  goods: {
    sources: [
      { cite: "ZDPH §19(1)(a), §2(1)(c)(2)", url: ZDPH },
      { cite: "Directive 2006/112/EC Art. 138(2)(a), Arts. 313(2), 315", url: VAT_DIRECTIVE },
      { cite: "Your Europe: VAT when buying a car in another EU country", url: YOUR_EUROPE_VAT },
    ],
    asOf: "2026-10-24",
  },
  /** Normalized like the price; in the CZ VAT base of a new means of transport. */
  sellerExtras: {
    sources: [
      { cite: "Your Europe: the VAT base includes seller-charged extras", url: YOUR_EUROPE_VAT },
    ],
    asOf: "2026-10-24",
  },
  /** Czech VAT the buyer self-assesses on a new means of transport from another EU state. */
  vatCz: {
    rate: 0.21,
    sources: [{ cite: "ZDPH §2(1)(c)(2), §19c, §47", url: ZDPH }],
    asOf: "2026-10-24",
  },
  /** Default when the user sets none: car transporter round trip or export plates plus the trip. */
  transport: {
    czk: 12_000,
    indicative: true,
    sources: [
      {
        cite: "DovozAuta price list: 13–16 CZK/km round trip",
        url: "https://dovozauta.com/cenik/",
      },
      {
        cite: "ADAC: Ausfuhrkennzeichen ≈ €100–200",
        url: "https://www.adac.de/rund-ums-fahrzeug/auto-kaufen-verkaufen/import-export/ausfuhrkennzeichen-zollkennzeichen/",
      },
    ],
    asOf: "2026-10-24",
  },
  /**
   * Evidenční kontrola always. The technical inspection plus emissions (none for a BEV) are
   * added unless a valid foreign certificate covers the Czech interval, or the car is too
   * young for any periodic inspection to be due (first at 3 years in DE/AT, 4 in CZ).
   */
  inspection: {
    identityCheckCzk: 790,
    technicalCzk: 2_490,
    emissionsCzk: 950,
    noneDueMonths: 36,
    indicative: true,
    sources: [
      { cite: "zákon 56/2001 Sb. §5a, §40", url: ZAKON_56_2001 },
      {
        cite: "DE: StVZO Anlage VIII 2.1 (first HU at 36 months)",
        url: "https://www.gesetze-im-internet.de/stvzo_2012/anlage_viii.html",
      },
      {
        cite: "AT: KFG 1967 §57a(3) (first at 3 years)",
        url: "https://ris.bka.gv.at/Dokumente/Bundesnormen/NOR40277032/NOR40277032.html",
      },
      {
        cite: "Directive 2014/45/EU Art. 8(3): valid foreign certificate recognized",
        url: "https://eur-lex.europa.eu/legal-content/EN/ALL/?uri=celex%3A32014L0045",
      },
      { cite: "STK Unikom price list from 2026-07-01: 790", url: "https://stk.unikom.cz/cenik" },
      {
        cite: "Praha: no emissions measurement for electric cars",
        url: "https://portalprazana.cz/pro-verejnost/sluzby/technicka-prohlidka-emise",
      },
      {
        cite: "STK Raspenava 2026: 2,490 + emissions 950",
        url: "https://www.stkraspenava.cz/assets/files/Cenik_osobni_2026.pdf",
      },
    ],
    asOf: "2026-10-24",
  },
  /** Registration in person (640 CZK online), certificate and plates included. */
  registration: {
    czk: 800,
    sources: [
      {
        cite: "zákon 634/2004 Sb., sazebník pol. 26",
        url: "https://www.zakonyprolidi.cz/cs/2004-634",
      },
    ],
    asOf: "2026-10-24",
  },
  /** One-off emission fee at first CZ registration of a car below Euro 3. BEVs pay none. */
  ecoFee: {
    czkByEuroClass: [10_000, 5_000, 3_000] as readonly number[],
    sources: [
      { cite: "zákon 542/2020 Sb. §§113–119", url: "https://www.zakonyprolidi.cz/cs/2020-542" },
      {
        cite: "portal.gov.cz: platba emisního poplatku",
        url: "https://portal.gov.cz/sluzby-vs/platba-emisniho-poplatku-ekologicka-dan-S20943",
      },
    ],
    asOf: "2026-10-24",
  },

  /** Rates are ČNB fixings normalized to one unit (kurz ÷ množství) by the ČNB Source. */
  fx: {
    sources: [
      {
        cite: "ČNB daily fixing (kurz ÷ množství)",
        url: "https://www.cnb.cz/cs/financni-trhy/devizovy-trh/kurzy-devizoveho-trhu/kurzy-devizoveho-trhu/denni_kurz.txt",
      },
    ],
    asOf: "2026-10-24",
  },
  /** New means of transport: ≤ 6 months since first entry into service OR ≤ 6,000 km. */
  newMeansOfTransport: {
    months: 6,
    km: 6_000,
    sources: [
      { cite: "ZDPH §19(1)(a), §19(2)", url: ZDPH },
      { cite: "Directive 2006/112/EC Art. 2(2)(b)", url: VAT_DIRECTIVE },
      {
        cite: "AT: UStG 1994 Binnenmarktregelung Arts. 1, 2, 6, 7",
        url: "https://www.ris.bka.gv.at/GeltendeFassung.wxe?Abfrage=Bundesnormen&Gesetzesnummer=10004929",
      },
    ],
    asOf: "2026-10-25",
  },
  /** Standard VAT of the Listing's Market: what a dealer's gross price includes. */
  marketVat: {
    rates: { CZ: 0.21, DE: 0.19, AT: 0.2 },
    sources: [
      { cite: "CZ: ZDPH §47", url: ZDPH },
      { cite: "DE: UStG §12", url: "https://www.gesetze-im-internet.de/ustg_1980/__12.html" },
      {
        cite: "AT: UStG 1994 §10",
        url: "https://www.ris.bka.gv.at/NormDokument.wxe?Abfrage=Bundesnormen&Gesetzesnummer=10004873&Paragraf=10",
      },
    ],
    asOf: "2026-10-25",
  },
  /**
   * Austrian NoVA: in a dealer's consumer price, exempt on delivery to another EU state, and
   * refunded to whoever exports a car registered in Austria for at most 48 months. Without
   * CO₂ data it cannot be removed, so those cases are flagged `approximate`.
   */
  atNova: {
    refundMaxMonths: 48,
    sources: [
      {
        cite: "NoVAG 1991 §3(2)(1): deliveries to the rest of the EU exempt",
        url: "https://www.ris.bka.gv.at/NormDokument.wxe?Abfrage=Bundesnormen&Gesetzesnummer=10004698&Paragraf=3",
      },
      {
        cite: "NoVAG 1991 §12a: refund on export, ≤ 48 months from 2026-07-01",
        url: "https://www.ris.bka.gv.at/NormDokument.wxe?Abfrage=Bundesnormen&Gesetzesnummer=10004698&Paragraf=12a",
      },
      {
        cite: "PrAG §9: consumer prices include all taxes",
        url: "https://ris.bka.gv.at/eli/bgbl/1992/146/P9/NOR40278459",
      },
    ],
    asOf: "2026-10-25",
  },
} as const satisfies Record<LandedLineCode, RuleEntry> & Record<string, RuleEntry>;

export type PricingRuleId = keyof typeof PRICING_RULES;
