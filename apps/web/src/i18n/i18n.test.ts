import { describe, expect, it } from "vitest";
import { i18n, MISSING } from "./i18n.ts";

/** Intl and the unit formats use no-break spaces; `~` stands for one in expectations. */
const nb = (s: string) => s.replaceAll("~", "\u00a0");

describe("i18n formatting", () => {
  const cs = i18n("cs");
  const en = i18n("en");

  it("formats CZK in each locale's convention", () => {
    expect(cs.czk(259000)).toBe(nb("259~000~Kč"));
    expect(en.czk(259000)).toBe(nb("CZK~259,000"));
    expect(cs.czk(259000.6)).toBe(nb("259~001~Kč"));
  });

  it("formats foreign amounts in their own currency", () => {
    expect(cs.money(12345, "EUR")).toBe(nb("12~345~€"));
    expect(en.money(12345, "EUR")).toBe("€12,345");
  });

  it("formats units and decimals", () => {
    expect(cs.km(88000)).toBe(nb("88~000~km"));
    expect(en.km(88000)).toBe(nb("88,000~km"));
    expect(cs.kw(110)).toBe(nb("110~kW"));
    expect(cs.l100(5.64)).toBe(nb("5,6~l/100~km"));
    expect(en.l100(5.64)).toBe(nb("5.6~l/100~km"));
    expect(cs.number(1234.567, 2)).toBe(nb("1~234,57"));
  });

  it("formats dates in Prague time", () => {
    expect(cs.date("2026-10-24T16:00:00.000Z")).toBe("24. 10. 2026");
    expect(en.date("2026-10-24T16:00:00.000Z")).toBe("24 Oct 2026");
    // 23:30 UTC on the 24th is already the 25th in Prague.
    expect(en.date("2026-10-24T23:30:00.000Z")).toBe("25 Oct 2026");
  });

  it("prints one dash for any missing or invalid value", () => {
    for (const f of [cs.czk, cs.km, cs.kw, cs.l100, (n: undefined) => cs.number(n)]) {
      expect(f(undefined)).toBe(MISSING);
    }
    expect(cs.czk(null)).toBe(MISSING);
    expect(cs.czk(Number.NaN)).toBe(MISSING);
    expect(cs.money(undefined, "EUR")).toBe(MISSING);
    expect(cs.date("not a date")).toBe(MISSING);
    expect(cs.date(undefined)).toBe(MISSING);
  });

  it("picks Czech plural forms", () => {
    expect(cs.count("count.listings", 1)).toBe("1 inzerát");
    expect(cs.count("count.listings", 3)).toBe("3 inzeráty");
    expect(cs.count("count.listings", 5)).toBe("5 inzerátů");
    expect(cs.count("count.listings", 0)).toBe("0 inzerátů");
    expect(cs.count("count.variants", 1200)).toBe(nb("1~200 variant"));
    expect(en.count("count.listings", 1)).toBe("1 listing");
    expect(en.count("count.listings", 3)).toBe("3 listings");
  });

  it("interpolates variables and labels vocabulary values", () => {
    expect(cs.t("footer.data", { date: cs.date("2026-10-24T16:00:00Z") })).toBe(
      "Data k 24. 10. 2026",
    );
    expect(en.t("nav.allOf", { make: "Škoda" })).toBe("All Škoda");
    expect(cs.label("fuel", "diesel")).toBe("nafta");
    expect(en.label("body", "wagon")).toBe("estate");
    expect(en.label("make", "skoda")).toBe("skoda");
  });

  it("prefixes English paths only", () => {
    expect(cs.path("/model/skoda/octavia/")).toBe("/model/skoda/octavia/");
    expect(en.path("/model/skoda/octavia/")).toBe("/en/model/skoda/octavia/");
  });

  it("has the same keys in both catalogs", async () => {
    const { messages } = await import("./messages.ts");
    expect(Object.keys(messages("en")).sort()).toEqual(Object.keys(messages("cs")).sort());
  });
});
