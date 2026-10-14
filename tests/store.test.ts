import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryStore } from "../src/app/store.js";
import { DEFAULT_CONFIG } from "../src/app/paths.js";

describe("MemoryStore", () => {
  let home: string;
  let store: MemoryStore;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "nsm-store-"));
    process.env.NSM_HOME = home;
    store = new MemoryStore({ config: { ...DEFAULT_CONFIG }, neural: false });
  });

  afterEach(async () => {
    await store.close();
    delete process.env.NSM_HOME;
    rmSync(home, { recursive: true, force: true });
  });

  it("remembers, recalls with dates and ids, and dedupes exact text", async () => {
    const a = await store.remember("I prefer Bun over Node for scripts", { source: "test" });
    const again = await store.remember("I prefer Bun over Node for scripts");
    expect(again.duplicate).toBe(true);
    expect(again.id).toBe(a.id);
    await store.remember("My dance studio opens in March");
    const r = await store.recall("which runtime do I prefer for scripts?");
    expect(r.memories[0]!.id).toBe(a.id);
    expect(r.prompt).toContain("[MEMORIES]");
    expect(r.prompt).toContain(`[id: ${a.id}]`);
    expect(r.prompt).toMatch(/\(\d{4}-\d{2}-\d{2}\)/);
    expect(r.neural).toBe(false);
  });

  it("delivers pinned rules on every recall, even when the query shares no words", async () => {
    await store.remember("Never run npm; always use bun", { pinned: true });
    await store.remember("Caroline researched adoption agencies");
    const r = await store.recall("what did Caroline research?");
    expect(r.pinned.map((p) => p.text)).toEqual(["Never run npm; always use bun"]);
    expect(r.prompt.startsWith("[PINNED RULES]")).toBe(true);
    expect(r.memories.some((m) => m.text.includes("Caroline"))).toBe(true);
    expect(r.memories.some((m) => m.pinned)).toBe(false);
  });

  it("respects k and forgets by id", async () => {
    for (let i = 0; i < 15; i++) await store.remember(`Note number ${i} about the studio lease`);
    const r = await store.recall("studio lease", 5);
    expect(r.memories.length).toBe(5);
    expect(store.forget(r.memories[0]!.id)).toBe(true);
    expect(store.forget(r.memories[0]!.id)).toBe(false);
    expect(store.stats().memories).toBe(14);
  });

  it("lists newest first and filters pinned", async () => {
    await store.remember("first");
    await new Promise((r) => setTimeout(r, 5));
    await store.remember("second rule", { pinned: true });
    const all = store.list();
    expect(all[0]!.text).toBe("second rule");
    expect(store.list({ pinned: true }).map((m) => m.text)).toEqual(["second rule"]);
    expect(store.list({ pinned: false }).map((m) => m.text)).toEqual(["first"]);
  });

  it("persists across reopen in the same home", async () => {
    await store.remember("persisted fact about Maplewood");
    await store.close();
    store = new MemoryStore({ config: { ...DEFAULT_CONFIG }, neural: false });
    const r = await store.recall("Maplewood");
    expect(r.memories.length).toBe(1);
  });
});
