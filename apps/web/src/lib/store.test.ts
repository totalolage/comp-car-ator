import { describe, expect, it } from "vitest";
import { openStore, RECENTS_MAX } from "./store.ts";

/** Minimal Storage over a Map; `full` makes setItem throw like an exhausted quota. */
class MemoryStorage implements Storage {
  data = new Map<string, string>();
  full = false;
  get length() {
    return this.data.size;
  }
  clear() {
    this.data.clear();
  }
  getItem(key: string) {
    return this.data.get(key) ?? null;
  }
  key(i: number) {
    return [...this.data.keys()][i] ?? null;
  }
  removeItem(key: string) {
    this.data.delete(key);
  }
  setItem(key: string, value: string) {
    if (this.full) throw new DOMException("quota", "QuotaExceededError");
    this.data.set(key, value);
  }
}

let tick = 0;
const clock = () => new Date(Date.UTC(2026, 9, 25, 12, 0, tick++));

describe("site store", () => {
  it("toggles the compare list and refuses a fifth Variant", () => {
    const store = openStore(new MemoryStorage(), clock);
    for (const id of ["a", "b", "c", "d"]) expect(store.toggleCompare(id)).toBe(true);
    expect(store.toggleCompare("e")).toBe(false);
    expect(store.compare()).toEqual(["a", "b", "c", "d"]);
    expect(store.toggleCompare("b")).toBe(true);
    expect(store.compare()).toEqual(["a", "c", "d"]);
    store.setCompare(["x", "x", "y", "z", "w", "v"]);
    expect(store.compare()).toEqual(["x", "y", "z", "w"]);
  });

  it("persists across pages that open the same storage", () => {
    const storage = new MemoryStorage();
    openStore(storage, clock).toggleCompare("a");
    openStore(storage, clock).addRecent({ id: "skoda/octavia", label: "Škoda Octavia" });
    const later = openStore(storage, clock);
    expect(later.compare()).toEqual(["a"]);
    expect(later.recents().map((r) => r.id)).toEqual(["skoda/octavia"]);
  });

  it("keeps recents newest first, unique and bounded", () => {
    const store = openStore(new MemoryStorage(), clock);
    for (let i = 0; i < RECENTS_MAX + 3; i++) store.addRecent({ id: `m${i}`, label: `M ${i}` });
    store.addRecent({ id: "m5", label: "M 5" });
    const ids = store.recents().map((r) => r.id);
    expect(ids).toHaveLength(RECENTS_MAX);
    expect(ids[0]).toBe("m5");
    expect(ids.filter((id) => id === "m5")).toHaveLength(1);
    expect(ids).not.toContain("m0");
  });

  it("saves and removes searches as canonical query strings", () => {
    const store = openStore(new MemoryStorage(), clock);
    const a = store.saveSearch({
      name: "Kombi diesel",
      query: "?body=wagon&fuel=diesel",
      lastTotal: 3,
    });
    const b = store.saveSearch({ name: "", query: "?make=skoda" });
    expect(a.id).not.toBe(b.id);
    expect(store.savedSearches().map((s) => s.query)).toEqual([
      "?make=skoda",
      "?body=wagon&fuel=diesel",
    ]);
    store.removeSearch(b.id);
    expect(store.savedSearches()).toEqual([a]);
  });

  it("treats corrupt or foreign data as empty and keeps what is well formed", () => {
    const storage = new MemoryStorage();
    storage.setItem("cca:v1", "{not json");
    expect(openStore(storage, clock).compare()).toEqual([]);
    storage.setItem(
      "cca:v1",
      JSON.stringify({
        compare: ["a", 7, "", "a", "b"],
        recents: [{ id: "x" }, null],
        searches: "nope",
      }),
    );
    const store = openStore(storage, clock);
    expect(store.compare()).toEqual(["a", "b"]);
    expect(store.recents()).toEqual([]);
    expect(store.savedSearches()).toEqual([]);
  });

  it("keeps working in memory when storage is full or unavailable", () => {
    const storage = new MemoryStorage();
    storage.full = true;
    const store = openStore(storage, clock);
    expect(() => store.toggleCompare("a")).not.toThrow();
    expect(store.compare()).toEqual(["a"]);
    const none = openStore(null, clock);
    none.toggleCompare("a");
    expect(none.compare()).toEqual(["a"]);
  });

  it("notifies subscribers on change until they unsubscribe", () => {
    const store = openStore(new MemoryStorage(), clock);
    let calls = 0;
    const off = store.subscribe(() => calls++);
    store.toggleCompare("a");
    store.addRecent({ id: "m", label: "M" });
    off();
    store.toggleCompare("b");
    expect(calls).toBe(2);
  });
});
