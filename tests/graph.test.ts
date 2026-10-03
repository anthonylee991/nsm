import { describe, expect, it } from "bun:test";
import { AdjacencyGraph } from "../src/core/graph/adjacency.js";
import type { MemoryNode, MemoryEdge, ScoredMemoryNode } from "../src/core/types.js";

describe("AdjacencyGraph & Neuro-Swarm Dynamics", () => {
  it("propagates energy via Spreading Activation across synaptic hops", () => {
    const graph = new AdjacencyGraph();

    const nodes: MemoryNode[] = [
      {
        id: "concept-beach",
        nodeType: "location",
        label: "Coastal Beach",
        source: "ambient_signal",
        payload: { type: "coast" },
        createdAt: Date.now(),
        updatedAt: Date.now(),
      },
      {
        id: "concept-saturday",
        nodeType: "event",
        label: "Saturday Timeline",
        source: "calendar",
        payload: { day: "Saturday" },
        createdAt: Date.now(),
        updatedAt: Date.now(),
      },
      {
        id: "event-review",
        nodeType: "event",
        label: "Quarterly Strategy Review",
        source: "calendar",
        payload: { time: "2:00 PM", conflict: true },
        createdAt: Date.now(),
        updatedAt: Date.now(),
      },
    ];

    const edges: MemoryEdge[] = [
      {
        sourceId: "concept-saturday",
        targetId: "concept-beach",
        relation: "potential_activity",
        weight: 0.8,
        lastActivated: Date.now(),
      },
      {
        sourceId: "concept-saturday",
        targetId: "event-review",
        relation: "scheduled_conflict",
        weight: 0.95,
        lastActivated: Date.now(),
      },
    ];

    graph.hydrate(nodes, edges);

    const seeds: ScoredMemoryNode[] = [
      {
        node: nodes[0],
        score: 1.0,
        matchReasons: ["BM25 Match: beach"],
      },
    ];

    // Perform Spreading Activation
    const activated = graph.spreadingActivation(seeds, 2, 0.4);

    const activatedIds = activated.map((a) => a.node.id);
    expect(activatedIds).toContain("concept-beach");
    expect(activatedIds).toContain("concept-saturday");
    expect(activatedIds).toContain("event-review");

    // Lateral Inhibition
    const inhibited = graph.lateralInhibition(activated, 1);
    expect(inhibited.length).toBeLessThanOrEqual(activated.length);

    // PAE Slotting
    const paePrompt = graph.formatPAESlots(activated, {
      "Location": "Metro Area",
      "Weather": "72°F Sunny",
    });

    expect(paePrompt).toContain("[AMBIENT CONTEXT]");
    expect(paePrompt).toContain("Metro Area");
    expect(paePrompt).toContain("Quarterly Strategy Review");
  });

  it("reinforces pheromone trails and evaporates over time", () => {
    const graph = new AdjacencyGraph();
    const nodeA: MemoryNode = {
      id: "a",
      nodeType: "profile",
      label: "Node A",
      source: "user_fact",
      payload: {},
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    const nodeB: MemoryNode = {
      id: "b",
      nodeType: "profile",
      label: "Node B",
      source: "user_fact",
      payload: {},
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };

    const edge: MemoryEdge = {
      sourceId: "a",
      targetId: "b",
      relation: "associated",
      weight: 0.5,
      lastActivated: Date.now() - 30 * 24 * 60 * 60 * 1000, // 30 days ago
    };

    graph.hydrate([nodeA, nodeB], [edge]);

    // Reinforce edge
    graph.reinforceEdge("a", "b", 0.2);
    // Evaporate edge over 14-day half-life
    const futureTime = Date.now() + 28 * 24 * 60 * 60 * 1000;
    graph.evaporatePheromones(14, futureTime);

    // Verify decay
    const activated = graph.spreadingActivation([{ node: nodeA, score: 1.0, matchReasons: [] }], 1);
    const nodeBResult = activated.find((a) => a.node.id === "b");
    expect(nodeBResult).toBeDefined();
    // After 28 days (2 half-lives), weight should have decayed by approximately 75%
    expect(nodeBResult!.score).toBeLessThan(0.35);
  });
});
