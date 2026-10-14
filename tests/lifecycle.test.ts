import { describe, it, expect } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryStore } from "../src/app/store.js";
import { DEFAULT_CONFIG } from "../src/app/paths.js";
import { decayedStrength, boostOnAccess, forgettingAction, rankScore, DEFAULT_INITIAL_STRENGTH } from "../src/lifecycle/strength.js";
import { absenceFlags, lexicalSimilarity, selectFamily } from "../src/lifecycle/absence.js";

const DAY = 86_400_000;

describe("strength model (ACM)", () => {
  it("decays to about 5% over the 90-day window, slower after reinforcement, never for pinned", () => {
    expect(decayedStrength(0.4, 0, 0)).toBeCloseTo(0.4, 6);
    expect(decayedStrength(0.4, 90 * DAY, 0) / 0.4).toBeCloseTo(Math.exp(-3), 3);
    expect(decayedStrength(0.4, 90 * DAY, 10)).toBeGreaterThan(decayedStrength(0.4, 90 * DAY, 0));
    expect(decayedStrength(0.4, 400 * DAY, 0, "pinned")).toBe(1.0);
    expect(decayedStrength(0.4, NaN, 0)).toBe(0.01);
  });

  it("reinforces with diminishing returns and caps at 1", () => {
    const once = boostOnAccess(0.4, "default", 1);
    expect(once).toBeGreaterThan(0.4);
    expect(boostOnAccess(0.99, "default", 5)).toBe(1.0);
    expect(boostOnAccess(0.1, "pinned")).toBe(1.0);
  });

  it("a strong cue reactivates a faded memory in the rank score", () => {
    expect(rankScore(1.0, 0.01)).toBeCloseTo(rankScore(1.0, 1.0), 6);
    expect(rankScore(0.1, 0.01)).toBeLessThan(rankScore(0.1, 0.8));
  });

  it("forgets only faded AND idle memories, never pinned or already archived", () => {
    const now = Date.now();
    const old = { strength: 0.01, importance: "default" as const, createdAt: now - 200 * DAY, lastRecalledAt: null };
    expect(forgettingAction(old, now)).toBe("demote");
    expect(forgettingAction({ ...old, lastRecalledAt: now - 10 * DAY }, now)).toBe("keep");
    expect(forgettingAction({ ...old, strength: 0.3 }, now)).toBe("keep");
    expect(forgettingAction({ ...old, importance: "pinned" }, now)).toBe("keep");
    expect(forgettingAction({ ...old, state: "archived" }, now)).toBe("keep");
    expect(forgettingAction(old, now, { strengthFloor: 0.02, idleDays: 90, mode: "delete" })).toBe("delete");
  });
});

describe("absence flags (no model)", () => {
  const entry = (i: number, text: string, day: number) => ({ id: `e${i}`, text, occurredAt: day * DAY });

  it("flags a regular routine that stopped, not one that continues", () => {
    const swims = Array.from({ length: 8 }, (_, i) => entry(i, `Swim done, 1200 m in ${30 + (i % 3)} minutes at the community pool`, i * 7));
    const other = [entry(90, "Paid the electricity bill, 84 dollars", 3), entry(91, "Called mum, she is well", 5)];
    const all = [...swims, ...other];
    expect(lexicalSimilarity(swims[0]!, swims[1]!)).toBeGreaterThan(0.3);
    expect(selectFamily(swims[0]!, all, lexicalSimilarity, 0.3)!.length).toBe(7);
    // Last swim at day 49; asked at day 100: 51 days > 3 x 7.
    const stopped = absenceFlags([swims[7]!], all, 100 * DAY, lexicalSimilarity, 0.3);
    expect(stopped.length).toBe(1);
    expect(stopped[0]!.usualIntervalDays).toBe(7);
    expect(stopped[0]!.sinceDays).toBe(51);
    // Asked at day 52: only 3 days since the last swim, nothing to flag.
    expect(absenceFlags([swims[7]!], all, 52 * DAY, lexicalSimilarity, 0.3).length).toBe(0);
  });
});

describe("MemoryStore lifecycle", () => {
  function open(clock: { t: number }) {
    const home = mkdtempSync(join(tmpdir(), "nsm-life-"));
    process.env.NSM_HOME = home;
    const store = new MemoryStore({ config: { ...DEFAULT_CONFIG }, neural: false, now: () => clock.t });
    return { home, store };
  }

  it("fresh memories rank by relevance alone; recall reinforces; sweep demotes faded idle ones and keeps them searchable", async () => {
    const clock = { t: Date.UTC(2026, 0, 1) };
    const { home, store } = open(clock);
    try {
      await store.remember("The dance studio lease was signed on Maplewood Ave");
      await store.remember("Gina launched an ad campaign for her clothing store");
      await store.remember("Jon lost his job as a banker");
      const before = store.list().map((m) => m.strength);
      expect(before.every((s) => Math.abs(s - DEFAULT_INITIAL_STRENGTH) < 1e-9)).toBe(true);

      const r1 = await store.recall("studio lease", 1);
      expect(r1.memories[0]!.text).toContain("Maplewood");
      const lease = store.list().find((m) => m.text.includes("Maplewood"))!;
      expect(lease.strength).toBeGreaterThan(DEFAULT_INITIAL_STRENGTH);

      // 100 days later with no recalls: the never-recalled memories have faded (0.4 -> 0.014) and are idle;
      // the recalled one is still above the floor (0.52 with a longer window -> 0.036).
      clock.t += 100 * DAY;
      const res = store.sweep();
      expect(res.demoted).toBe(2);
      expect(res.deleted).toBe(0);
      expect(store.stats().archived).toBe(2);
      // Demoted memories are hidden from activeOnly recall, but a direct question reactivates them.
      const hidden = await store.recall("Gina clothing store campaign", 5, { activeOnly: true });
      expect(hidden.memories.some((m) => m.text.includes("Gina"))).toBe(false);
      const back = await store.recall("Gina clothing store campaign", 5);
      expect(back.memories.some((m) => m.text.includes("Gina"))).toBe(true);
      expect(store.list().some((m) => m.text.includes("Gina"))).toBe(true); // active again
      expect(store.stats().archived).toBe(1);
      // The reinforced one survived because it was recalled.
      expect(store.list().some((m) => m.text.includes("Maplewood"))).toBe(true);
    } finally {
      await store.close();
      delete process.env.NSM_HOME;
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("raises an absence flag for a routine that went quiet, in the prompt", async () => {
    const clock = { t: Date.UTC(2026, 0, 1) };
    const { home, store } = open(clock);
    try {
      for (let i = 0; i < 8; i++) {
        await store.remember(`Swim done, ${1200 + i * 10} m in ${30 + (i % 4)} minutes at the community pool`, {
          occurredAt: clock.t + i * 7 * DAY,
          createdAt: clock.t + i * 7 * DAY,
        });
      }
      await store.remember("Paid the electricity bill, 84 dollars", { occurredAt: clock.t + 3 * DAY });
      clock.t += 100 * DAY; // last swim 51 days ago
      const r = await store.recall("plan my swims for next week", 5);
      expect(r.flags.length).toBe(1);
      expect(r.flags[0]!.metric).toBe("absence");
      expect(r.prompt).toContain("[ANOMALY FLAGS]");
      expect(r.prompt.indexOf("[ANOMALY FLAGS]")).toBeLessThan(r.prompt.indexOf("[MEMORIES]"));
    } finally {
      await store.close();
      delete process.env.NSM_HOME;
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("delete mode removes instead of demoting", async () => {
    const clock = { t: Date.UTC(2026, 0, 1) };
    const home = mkdtempSync(join(tmpdir(), "nsm-del-"));
    process.env.NSM_HOME = home;
    const store = new MemoryStore({
      config: { ...DEFAULT_CONFIG }, neural: false, now: () => clock.t,
      forgetting: { strengthFloor: 0.02, idleDays: 90, mode: "delete" },
    });
    try {
      await store.remember("something forgettable");
      clock.t += 200 * DAY;
      expect(store.sweep()).toEqual({ demoted: 0, deleted: 1, kept: 0 });
      expect(store.list({ includeArchived: true }).length).toBe(0);
    } finally {
      await store.close();
      delete process.env.NSM_HOME;
      rmSync(home, { recursive: true, force: true });
    }
  });
});
