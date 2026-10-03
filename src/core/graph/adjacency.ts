import type { MemoryNode, MemoryEdge, ScoredMemoryNode } from "../types.js";

export interface GraphEdge {
  targetId: string;
  relation: string;
  weight: number;
  lastActivated: number;
}

export class AdjacencyGraph {
  private nodes: Map<string, MemoryNode> = new Map();
  // Bidirectional adjacency list for ultra-fast synaptic pointer traversal in RAM
  private outgoing: Map<string, GraphEdge[]> = new Map();
  private incoming: Map<string, GraphEdge[]> = new Map();

  /**
   * Hydrate in-memory graph from durable SQLite records (< 1ms)
   */
  public hydrate(nodes: MemoryNode[], edges: MemoryEdge[]) {
    this.nodes.clear();
    this.outgoing.clear();
    this.incoming.clear();

    for (const node of nodes) {
      this.nodes.set(node.id, node);
    }

    for (const edge of edges) {
      this.addEdgeInMemory(edge.sourceId, edge.targetId, edge.relation, edge.weight, edge.lastActivated);
    }
  }

  public getNode(id: string): MemoryNode | undefined {
    return this.nodes.get(id);
  }

  public getAllNodes(): MemoryNode[] {
    return Array.from(this.nodes.values());
  }

  public addNode(node: MemoryNode) {
    this.nodes.set(node.id, node);
  }

  public removeNode(id: string) {
    this.nodes.delete(id);
    this.outgoing.delete(id);
    this.incoming.delete(id);
    for (const edges of this.outgoing.values()) {
      const idx = edges.findIndex((e) => e.targetId === id);
      if (idx !== -1) edges.splice(idx, 1);
    }
    for (const edges of this.incoming.values()) {
      const idx = edges.findIndex((e) => e.targetId === id);
      if (idx !== -1) edges.splice(idx, 1);
    }
  }

  public addEdgeInMemory(
    sourceId: string,
    targetId: string,
    relation: string,
    weight: number = 1.0,
    lastActivated: number = Date.now()
  ) {
    // Outgoing edge
    const outEdges = this.outgoing.get(sourceId) ?? [];
    const existingOut = outEdges.find((e) => e.targetId === targetId && e.relation === relation);
    if (existingOut) {
      existingOut.weight = weight;
      existingOut.lastActivated = lastActivated;
    } else {
      outEdges.push({ targetId, relation, weight, lastActivated });
      this.outgoing.set(sourceId, outEdges);
    }

    // Incoming edge for reverse synaptic traversal
    const inEdges = this.incoming.get(targetId) ?? [];
    const existingIn = inEdges.find((e) => e.targetId === sourceId && e.relation === relation);
    if (existingIn) {
      existingIn.weight = weight;
      existingIn.lastActivated = lastActivated;
    } else {
      inEdges.push({ targetId: sourceId, relation, weight, lastActivated });
      this.incoming.set(targetId, inEdges);
    }
  }

  public removeEdgeInMemory(sourceId: string, targetId: string, relation: string) {
    const outEdges = this.outgoing.get(sourceId);
    if (outEdges) {
      const idx = outEdges.findIndex((e) => e.targetId === targetId && e.relation === relation);
      if (idx !== -1) outEdges.splice(idx, 1);
    }

    const inEdges = this.incoming.get(targetId);
    if (inEdges) {
      const idx = inEdges.findIndex((e) => e.targetId === sourceId && e.relation === relation);
      if (idx !== -1) inEdges.splice(idx, 1);
    }
  }

  /**
   * Neurobiological Spreading Activation (Collins & Loftus Network Model)
   * Radiates energy outward from initial seed nodes across in-memory synapses.
   *
   * A_j = Sum_i ( A_i * w_ij * (1 - delta) )
   */
  public spreadingActivation(
    seedNodes: ScoredMemoryNode[],
    maxHops: number = 2,
    decayPerHop: number = 0.45,
    minEnergyThreshold: number = 0.05
  ): ScoredMemoryNode[] {
    const energyMap = new Map<string, { energy: number; reasons: string[] }>();

    // 1. Initialize seed energy
    for (const seed of seedNodes) {
      energyMap.set(seed.node.id, {
        energy: seed.score,
        reasons: [...seed.matchReasons, "Seed Node"],
      });
    }

    let frontier = new Map<string, number>();
    for (const seed of seedNodes) {
      frontier.set(seed.node.id, seed.score);
    }

    // 2. Pulse energy across hops
    for (let hop = 1; hop <= maxHops; hop++) {
      const nextFrontier = new Map<string, number>();

      for (const [currId, currEnergy] of frontier.entries()) {
        if (currEnergy < minEnergyThreshold) continue;

        // Traverse both outgoing and incoming connected synapses
        const neighbors = [
          ...(this.outgoing.get(currId) ?? []),
          ...(this.incoming.get(currId) ?? []),
        ];

        for (const edge of neighbors) {
          const propagatedEnergy = currEnergy * edge.weight * (1 - decayPerHop);
          if (propagatedEnergy < minEnergyThreshold) continue;

          const targetId = edge.targetId === currId ? edge.targetId : edge.targetId;
          const actualTargetId = edge.targetId;
          const targetEntry = energyMap.get(actualTargetId) ?? { energy: 0, reasons: [] };
          const newEnergy = targetEntry.energy + propagatedEnergy;
          targetEntry.energy = newEnergy;
          targetEntry.reasons.push(
            `Hop ${hop} via '${edge.relation}' (energy: +${propagatedEnergy.toFixed(3)})`
          );
          energyMap.set(actualTargetId, targetEntry);

          const prevFrontierEnergy = nextFrontier.get(actualTargetId) ?? 0;
          if (propagatedEnergy > prevFrontierEnergy) {
            nextFrontier.set(actualTargetId, propagatedEnergy);
          }
        }
      }

      frontier = nextFrontier;
      if (frontier.size === 0) break;
    }

    // 3. Compile and sort activated nodes with Epistemic Authority Weighting
    const results: ScoredMemoryNode[] = [];
    for (const [id, meta] of energyMap.entries()) {
      const node = this.nodes.get(id);
      if (node) {
        const authority = node.authority ?? 1.0;
        const finalScore = meta.energy * (0.5 + 0.5 * authority);
        results.push({
          node,
          score: finalScore,
          matchReasons: [...meta.reasons, `Authority: ${(authority * 100).toFixed(0)}%`],
        });
      }
    }

    return results.sort((a, b) => b.score - a.score);
  }

  /**
   * Lateral Inhibition (Sensory Focus & Epistemic Conflict Resolution)
   * 1. Suppresses nodes superseded via :SUPERSEDES edges
   * 2. Inhibits lower-authority nodes in conflicting attribute slots (e.g. personal residence vs scraper claim)
   * 3. Limits intra-category redundancy to sharpen contrast
   */
  public lateralInhibition(nodes: ScoredMemoryNode[], maxPerCategory: number = 2): ScoredMemoryNode[] {
    // 1. Check for incoming supersedes edges
    const supersededNodeIds = new Set<string>();
    for (const item of nodes) {
      const inEdges = this.incoming.get(item.node.id) ?? [];
      for (const edge of inEdges) {
        if (edge.relation.toUpperCase().includes("SUPERSEDE")) {
          // If the superseding node exists with higher or equal authority, mark as superseded
          const supersedingNode = this.nodes.get(edge.targetId);
          if (supersedingNode) {
            const myAuth = item.node.authority ?? 1.0;
            const theirAuth = supersedingNode.authority ?? 1.0;
            if (theirAuth >= myAuth) {
              supersededNodeIds.add(item.node.id);
              break;
            }
          }
        }
      }
    }

    // 2. Filter out superseded nodes & check slot conflicts
    const remainingNodes = nodes.filter((n) => !supersededNodeIds.has(n.node.id));

    // Check if there is an explicit high-authority verified fact for location/residence
    const hasHighAuthLocation = remainingNodes.some(
      (n) => (n.node.authority ?? 1.0) >= 0.95 &&
             (n.node.entityCategory === "person" || n.node.source === "user_fact" || n.node.nodeType === "invariant") &&
             /live|reside|residence|location/i.test(n.node.label)
    );

    const categoryCounts = new Map<string, number>();
    const filtered: ScoredMemoryNode[] = [];

    for (const item of remainingNodes) {
      const node = item.node;
      const auth = node.authority ?? 1.0;

      // If there is an authoritative personal location, suppress lower-tier scraper nodes with location claims
      if (hasHighAuthLocation && auth < 0.90 && (node.source.includes("social") || node.source.includes("scraper") || node.source.includes("feed"))) {
        if (node.payload.publicLocationClaim || /located in/i.test(node.label)) {
          continue; // Inhibit conflicting unverified claim
        }
      }

      const cat = node.nodeType;
      const count = categoryCounts.get(cat) ?? 0;

      // Pinned invariants are exempt from lateral inhibition
      if (node.nodeType === "invariant" || count < maxPerCategory) {
        filtered.push(item);
        categoryCounts.set(cat, count + 1);
      }
    }

    return filtered;
  }

  /**
   * Ant Colony Optimization: Reinforce edge pheromone (+ Delta tau)
   */
  public reinforceEdge(sourceId: string, targetId: string, delta: number = 0.1) {
    const outEdges = this.outgoing.get(sourceId) ?? [];
    const edge = outEdges.find((e) => e.targetId === targetId);
    if (edge) {
      edge.weight = Math.min(1.0, edge.weight + delta);
      edge.lastActivated = Date.now();
    }

    const inEdges = this.incoming.get(targetId) ?? [];
    const inEdge = inEdges.find((e) => e.targetId === sourceId);
    if (inEdge) {
      inEdge.weight = Math.min(1.0, inEdge.weight + delta);
      inEdge.lastActivated = Date.now();
    }
  }

  /**
   * Ant Colony Optimization: Evaporate unused pheromones exponentially
   * tau(t) = tau(0) * e^(-lambda * delta_t)
   */
  public evaporatePheromones(halfLifeDays: number = 14, now: number = Date.now()) {
    const halfLifeMs = halfLifeDays * 24 * 60 * 60 * 1000;
    const decayConst = Math.LN2 / halfLifeMs;

    for (const edges of this.outgoing.values()) {
      for (const edge of edges) {
        const elapsed = now - edge.lastActivated;
        if (elapsed > 0) {
          edge.weight = Math.max(0.01, edge.weight * Math.exp(-decayConst * elapsed));
        }
      }
    }

    for (const edges of this.incoming.values()) {
      for (const edge of edges) {
        const elapsed = now - edge.lastActivated;
        if (elapsed > 0) {
          edge.weight = Math.max(0.01, edge.weight * Math.exp(-decayConst * elapsed));
        }
      }
    }
  }

  /**
   * Peripheral Attention Engineering (PAE) Slot Formatter
   * Slots selected salient context into compact, deterministic sections (<150-250 tokens)
   */
  public formatPAESlots(
    salientNodes: ScoredMemoryNode[],
    ambientMap: Record<string, string> = {}
  ): string {
    const sections: string[] = [];

    // 1. Ambient External Baseline
    const ambientKeys = Object.keys(ambientMap);
    if (ambientKeys.length > 0) {
      const ambLines = ambientKeys.map((k) => `${k}: ${ambientMap[k]}`);
      sections.push(`[AMBIENT CONTEXT]\n${ambLines.join("\n")}`);
    }

    // 2. Personal Invariants & Boundaries (Highest priority)
    const invariants = salientNodes.filter((n) => n.node.nodeType === "invariant");
    if (invariants.length > 0) {
      const invLines = invariants.map((n) => `• [INVARIANT] ${n.node.label}: ${n.node.payload.rule || n.node.payload.summary || n.node.payload.text || ""}`.trim());
      sections.push(`[PINNED INVARIANTS]\n${invLines.join("\n")}`);
    }

    // 3. Calendar & Time Commitments
    const events = salientNodes.filter((n) => n.node.nodeType === "event");
    if (events.length > 0) {
      const evLines = events.map((n) => {
        const p = n.node.payload;
        return `• ${n.node.label} (${p.date || ""} ${p.time || ""}${p.conflict ? " [COLLISION]" : ""})`.trim();
      });
      sections.push(`[SCHEDULE & HORIZON]\n${evLines.join("\n")}`);
    }

    // 4. Core Profile & Fact Baselines
    const profiles = salientNodes.filter((n) => n.node.nodeType === "profile" || n.node.nodeType === "fact");
    if (profiles.length > 0) {
      const profLines = profiles.map((n) => `• ${n.node.label}: ${n.node.payload.summary || n.node.payload.text || JSON.stringify(n.node.payload)}`);
      sections.push(`[USER PROFILE & FACTS]\n${profLines.join("\n")}`);
    }

    // 5. Activated Contextual Notes
    const notes = salientNodes.filter((n) => n.node.nodeType === "note" || n.node.nodeType === "concept");
    if (notes.length > 0) {
      const noteLines = notes.map((n) => `• ${n.node.label}: ${n.node.payload.content || n.node.payload.snippet || ""}`.trim());
      sections.push(`[ACTIVATED MEMORY]\n${noteLines.join("\n")}`);
    }

    return sections.join("\n\n");
  }
}
