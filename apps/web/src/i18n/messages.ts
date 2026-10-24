/**
 * UI strings, cs (default) and en. Keys are flat; enum labels are keyed `<facet>.<value>`.
 * TODO(wave1-stream13): full i18n (plurals, number/date formats, language switch state).
 */
export const LANGS = ["cs", "en"] as const;
export type Lang = (typeof LANGS)[number];

const cs = {
  "site.title": "comp-car-ator",
  "site.tagline": "Srovnání aut: katalog, nové ceny a inzeráty z ČR, Německa a Rakouska",
  "lang.switch": "English",
  "catalog.heading": "Katalog",
  "catalog.results": "Výsledků",
  "catalog.empty": "Žádná varianta neodpovídá filtrům.",
  "catalog.clear": "Zrušit filtry",
  "col.model": "Model",
  "col.generation": "Generace",
  "col.years": "Roky",
  "col.body": "Karoserie",
  "col.fuel": "Palivo",
  "col.power": "Výkon",
  "col.transmission": "Převodovka",
  "col.newPrice": "Nová",
  "col.usedPrice": "Ojetá (medián)",
  "col.listings": "Inzeráty",
  "col.title": "Inzerát",
  "col.year": "Rok",
  "col.odometer": "Najeto",
  "col.price": "Cena",
  "col.landed": "Cena v ČR",
  "col.market": "Země",
  "col.source": "Zdroj",
  "col.days": "Dní v nabídce",
  "facet.make": "Značka",
  "facet.body": "Karoserie",
  "facet.fuel": "Palivo",
  "facet.transmission": "Převodovka",
  "facet.market": "Země inzerátu",
  "model.listings": "Inzeráty",
  "model.back": "Zpět na katalog",
  "fuel.petrol": "benzín",
  "fuel.diesel": "nafta",
  "fuel.lpg": "LPG",
  "fuel.cng": "CNG",
  "fuel.hev": "hybrid",
  "fuel.phev": "plug-in hybrid",
  "fuel.bev": "elektro",
  "fuel.reev": "elektro s range extenderem",
  "fuel.hydrogen": "vodík",
  "fuel.other": "jiné",
  "body.hatchback": "hatchback",
  "body.sedan": "sedan",
  "body.wagon": "kombi",
  "body.suv": "SUV",
  "body.mpv": "MPV",
  "body.coupe": "kupé",
  "body.convertible": "kabriolet",
  "body.pickup": "pick-up",
  "body.van": "dodávka",
  "body.other": "jiné",
  "transmission.manual": "manuální",
  "transmission.automatic": "automatická",
  "market.CZ": "Česko",
  "market.DE": "Německo",
  "market.AT": "Rakousko",
} as const;

export type MessageKey = keyof typeof cs;

const en: Record<MessageKey, string> = {
  "site.title": "comp-car-ator",
  "site.tagline":
    "Car comparison: catalog, new prices and listings from Czechia, Germany and Austria",
  "lang.switch": "Česky",
  "catalog.heading": "Catalog",
  "catalog.results": "Results",
  "catalog.empty": "No variant matches the filters.",
  "catalog.clear": "Clear filters",
  "col.model": "Model",
  "col.generation": "Generation",
  "col.years": "Years",
  "col.body": "Body",
  "col.fuel": "Fuel",
  "col.power": "Power",
  "col.transmission": "Transmission",
  "col.newPrice": "New",
  "col.usedPrice": "Used (median)",
  "col.listings": "Listings",
  "col.title": "Listing",
  "col.year": "Year",
  "col.odometer": "Odometer",
  "col.price": "Price",
  "col.landed": "Landed in CZ",
  "col.market": "Country",
  "col.source": "Source",
  "col.days": "Days listed",
  "facet.make": "Make",
  "facet.body": "Body",
  "facet.fuel": "Fuel",
  "facet.transmission": "Transmission",
  "facet.market": "Listing country",
  "model.listings": "Listings",
  "model.back": "Back to catalog",
  "fuel.petrol": "petrol",
  "fuel.diesel": "diesel",
  "fuel.lpg": "LPG",
  "fuel.cng": "CNG",
  "fuel.hev": "hybrid",
  "fuel.phev": "plug-in hybrid",
  "fuel.bev": "electric",
  "fuel.reev": "range-extended EV",
  "fuel.hydrogen": "hydrogen",
  "fuel.other": "other",
  "body.hatchback": "hatchback",
  "body.sedan": "sedan",
  "body.wagon": "estate",
  "body.suv": "SUV",
  "body.mpv": "MPV",
  "body.coupe": "coupé",
  "body.convertible": "convertible",
  "body.pickup": "pickup",
  "body.van": "van",
  "body.other": "other",
  "transmission.manual": "manual",
  "transmission.automatic": "automatic",
  "market.CZ": "Czechia",
  "market.DE": "Germany",
  "market.AT": "Austria",
};

const MESSAGES: Record<Lang, Record<MessageKey, string>> = { cs, en };

export type Messages = Record<MessageKey, string>;

export function messages(lang: Lang): Messages {
  return MESSAGES[lang];
}

/** Label for an enum value, falling back to the raw value (e.g. make ids). */
export function label(m: Messages, facet: string, value: string): string {
  return (m as Record<string, string>)[`${facet}.${value}`] ?? value;
}

export function localePath(lang: Lang, path: string): string {
  return lang === "cs" ? path : `/en${path}`;
}

export function numberLocale(lang: Lang): string {
  return lang === "cs" ? "cs-CZ" : "en-GB";
}
