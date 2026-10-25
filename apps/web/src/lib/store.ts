/**
 * What the site remembers in the browser (no accounts): the compare list, recently viewed
 * models and saved searches. Everything goes through one versioned localStorage key, so a
 * malformed or foreign value, a full quota or storage disabled by the browser degrades to
 * "nothing remembered" instead of an error. The URL stays the source of truth for a shared
 * view; the store only carries state across pages and visits.
 */
import type { ModelId, VariantId } from "@cca/vocabulary";
import { COMPARE_MAX } from "./url-state.ts";

export const RECENTS_MAX = 8;
export const SAVED_MAX = 50;

/** A model page the person opened, newest first. */
export interface Recent {
  id: ModelId;
  /** Display name at the time of the visit, e.g. "Škoda Octavia". */
  label: string;
  at: string;
}

/**
 * A saved catalog search. `query` is the canonical string from `writeCatalogState`, so a
 * saved search can be reopened, compared and, later, checked for new matches.
 * TODO(alerts): alerts are deferred; they will diff `lastTotal` against a fresh query.
 */
export interface SavedSearch {
  id: string;
  name: string;
  query: string;
  createdAt: string;
  /** Matching Variant count when saved or last opened. */
  lastTotal?: number;
}

export interface SiteStore {
  compare(): VariantId[];
  /** Adds the Variant, or removes it when present. Returns false when the list is full. */
  toggleCompare(id: VariantId): boolean;
  setCompare(ids: VariantId[]): void;
  recents(): Recent[];
  addRecent(recent: Omit<Recent, "at">): void;
  savedSearches(): SavedSearch[];
  saveSearch(search: Omit<SavedSearch, "id" | "createdAt">): SavedSearch;
  removeSearch(id: string): void;
  /** Called after any change, from this page or (via the storage event) another tab. */
  subscribe(listener: () => void): () => void;
}

const KEY = "cca:v1";

interface Data {
  compare: VariantId[];
  recents: Recent[];
  searches: SavedSearch[];
}

/**
 * Opens the store over `storage` (window.localStorage in the browser, any Storage in tests).
 * `now` stamps recents and saved searches.
 */
export function openStore(
  storage: Storage | null = browserStorage(),
  now: () => Date = () => new Date(),
): SiteStore {
  const listeners = new Set<() => void>();
  let memory: Data = empty();
  // Set to null once a write fails, so later reads see the in-memory state instead.
  let backing = storage;

  function load(): Data {
    if (!backing) return memory;
    try {
      return sanitize(JSON.parse(storage.getItem(KEY) ?? "null"));
    } catch {
      return empty();
    }
  }

  function update(change: (data: Data) => void): void {
    const data = load();
    change(data);
    memory = data;
    try {
      backing?.setItem(KEY, JSON.stringify(data));
    } catch {
      // Quota exceeded or storage blocked: keep going in memory for this page.
      backing = null;
    }
    for (const listener of listeners) listener();
  }

  return {
    compare: () => load().compare,
    toggleCompare(id) {
      let ok = true;
      update((data) => {
        if (data.compare.includes(id)) data.compare = data.compare.filter((c) => c !== id);
        else if (data.compare.length >= COMPARE_MAX) ok = false;
        else data.compare.push(id);
      });
      return ok;
    },
    setCompare(ids) {
      update((data) => {
        data.compare = [...new Set(ids)].slice(0, COMPARE_MAX);
      });
    },
    recents: () => load().recents,
    addRecent(recent) {
      update((data) => {
        const rest = data.recents.filter((r) => r.id !== recent.id);
        data.recents = [{ ...recent, at: now().toISOString() }, ...rest].slice(0, RECENTS_MAX);
      });
    },
    savedSearches: () => load().searches,
    saveSearch(search) {
      const createdAt = now().toISOString();
      const saved: SavedSearch = {
        ...search,
        id: `${Date.parse(createdAt).toString(36)}`,
        createdAt,
      };
      update((data) => {
        while (data.searches.some((s) => s.id === saved.id)) saved.id += "x";
        data.searches = [saved, ...data.searches].slice(0, SAVED_MAX);
      });
      return saved;
    },
    removeSearch(id) {
      update((data) => {
        data.searches = data.searches.filter((s) => s.id !== id);
      });
    },
    subscribe(listener) {
      listeners.add(listener);
      const onStorage = (e: StorageEvent) => {
        if (e.key === KEY || e.key === null) listener();
      };
      globalThis.addEventListener?.("storage", onStorage);
      return () => {
        listeners.delete(listener);
        globalThis.removeEventListener?.("storage", onStorage);
      };
    },
  };
}

function browserStorage(): Storage | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    // Some browsers throw on access when storage is disabled.
    return null;
  }
}

function empty(): Data {
  return { compare: [], recents: [], searches: [] };
}

/** Keeps only well-formed entries from whatever was stored. */
function sanitize(raw: unknown): Data {
  const data = empty();
  if (!raw || typeof raw !== "object") return data;
  const r = raw as Record<string, unknown>;
  const str = (v: unknown): v is string => typeof v === "string" && v !== "";
  if (Array.isArray(r.compare))
    data.compare = [...new Set(r.compare.filter(str))].slice(0, COMPARE_MAX);
  if (Array.isArray(r.recents)) {
    data.recents = r.recents
      .filter((x): x is Recent => !!x && str(x.id) && str(x.label) && str(x.at))
      .slice(0, RECENTS_MAX);
  }
  if (Array.isArray(r.searches)) {
    data.searches = r.searches
      .filter(
        (x): x is SavedSearch =>
          !!x &&
          str(x.id) &&
          typeof x.name === "string" &&
          typeof x.query === "string" &&
          str(x.createdAt),
      )
      .slice(0, SAVED_MAX);
  }
  return data;
}
