import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { NeuroSwarmMesh } from "../src/mesh.js";
import { rmSync, existsSync } from "node:fs";

describe("NeuroSwarmMesh End-to-End Core", () => {
  let mesh: NeuroSwarmMesh;

  beforeEach(() => {
    mesh = new NeuroSwarmMesh({ dbPath: ":memory:" });
  });

  afterEach(() => {
    mesh.close();
  });

  it("ingests unstructured natural language text and links extracted entities", () => {
    const ingestRes = mesh.ingestText("I work at DeepCorp as an AI systems researcher");
    expect(ingestRes.nodeId).toBeDefined();
    expect(ingestRes.extractedTriplets.length).toBeGreaterThan(0);

    const stats = mesh.getStats();
    expect(stats.totalNodes).toBeGreaterThanOrEqual(1);

    // Retrieve via natural query
    const queryRes = mesh.query("Where do I work?");
    expect(queryRes.salientNodes.length).toBeGreaterThan(0);
    expect(queryRes.paePrompt).toContain("DeepCorp");
    expect(queryRes.telemetry.totalDurationMs).toBeLessThan(100);
  });

  it("slots retrieved context into deterministic PAE sections", () => {
    // 1. Ingest invariant
    mesh.ingestNode({
      id: "inv-focus-time",
      nodeType: "invariant",
      label: "Morning Deep Work",
      source: "user_invariant",
      authority: 1.0,
      payload: { rule: "No meetings before 11 AM" },
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });

    // 2. Ingest scheduled event
    mesh.ingestNode({
      id: "ev-standup",
      nodeType: "event",
      label: "Engineering Sync",
      source: "calendar",
      authority: 0.90,
      payload: { date: "Monday", time: "11:30 AM", conflict: false },
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });

    const res = mesh.query("Can I schedule an 11:30 AM meeting on Monday?", {
      ambientContext: {
        "Local Time": "10:15 AM",
        "Day": "Monday",
      },
    });

    expect(res.paePrompt).toContain("[AMBIENT CONTEXT]");
    expect(res.paePrompt).toContain("10:15 AM");
    expect(res.paePrompt).toContain("[PINNED INVARIANTS]");
    expect(res.paePrompt).toContain("No meetings before 11 AM");
    expect(res.paePrompt).toContain("[SCHEDULE & HORIZON]");
    expect(res.paePrompt).toContain("Engineering Sync");
  });

  it("provides integration categories and provider discovery", () => {
    const categories = mesh.getIntegrations().getAllCategories();
    expect(categories.length).toBeGreaterThanOrEqual(4);

    const memoryCat = categories.find((c) => c.id === "memory");
    expect(memoryCat).toBeDefined();
    expect(memoryCat?.providers.length).toBeGreaterThan(0);
  });
});
