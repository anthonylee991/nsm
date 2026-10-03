import { describe, expect, it } from "bun:test";
import { SQLiteStorage } from "../src/core/storage/sqlite.js";
import type { MemoryNode, MemoryEdge } from "../src/core/types.js";

describe("SQLiteStorage & Hybrid RRF Search", () => {
  it("indexes nodes into FTS5 and retrieves via BM25 and Hybrid RRF", () => {
    const storage = new SQLiteStorage(":memory:");

    const sampleNodes: MemoryNode[] = [
      {
        id: "event-1",
        nodeType: "event",
        label: "Quarterly Strategy Review",
        source: "calendar",
        payload: { date: "Saturday", time: "14:00", room: "Conference A" },
        createdAt: Date.now(),
        updatedAt: Date.now(),
      },
      {
        id: "note-1",
        nodeType: "note",
        label: "Weekend Trip Ideas: Coastal Trail",
        source: "local_notes",
        payload: { content: "Pack hiking boots and water for the coastal weekend." },
        createdAt: Date.now(),
        updatedAt: Date.now(),
      },
      {
        id: "profile-1",
        nodeType: "profile",
        label: "Career Objectives",
        source: "cloud_mesh",
        payload: { goal: "Deliver high performance infrastructure systems." },
        createdAt: Date.now(),
        updatedAt: Date.now(),
      },
      {
        id: "inv-1",
        nodeType: "invariant",
        label: "No Weekend Client Work",
        source: "user_invariant",
        payload: { rule: "Saturdays and Sundays strictly reserved for personal focus." },
        createdAt: Date.now(),
        updatedAt: Date.now(),
      },
    ];

    for (const node of sampleNodes) {
      storage.upsertNode(node);
    }

    // 1. BM25 Search
    const bm25Hits = storage.searchBM25("coastal");
    expect(bm25Hits.length).toBeGreaterThan(0);
    expect(bm25Hits[0].id).toBe("note-1");

    // 2. Hybrid RRF Search
    const rrfHits = storage.searchHybridRRF("coastal weekend Saturday");
    expect(rrfHits.length).toBeGreaterThan(0);

    const hitIds = rrfHits.map((h) => h.node.id);
    expect(hitIds).toContain("note-1");
    expect(hitIds).toContain("event-1");

    storage.close();
  });

  it("handles edge persistence and retrieval", () => {
    const storage = new SQLiteStorage(":memory:");

    const nodeA: MemoryNode = {
      id: "node-a",
      nodeType: "concept",
      label: "Alpha",
      source: "user_fact",
      payload: {},
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    const nodeB: MemoryNode = {
      id: "node-b",
      nodeType: "concept",
      label: "Beta",
      source: "user_fact",
      payload: {},
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };

    storage.upsertNode(nodeA);
    storage.upsertNode(nodeB);

    const edge: MemoryEdge = {
      sourceId: "node-a",
      targetId: "node-b",
      relation: "links_to",
      weight: 0.85,
      lastActivated: Date.now(),
    };

    storage.upsertEdge(edge);

    const allEdges = storage.getAllEdges();
    expect(allEdges.length).toBe(1);
    expect(allEdges[0].sourceId).toBe("node-a");
    expect(allEdges[0].targetId).toBe("node-b");
    expect(allEdges[0].weight).toBe(0.85);

    storage.close();
  });
});
