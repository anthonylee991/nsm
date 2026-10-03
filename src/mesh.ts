import { SQLiteStorage } from "./core/storage/sqlite.js";
import { AdjacencyGraph } from "./core/graph/adjacency.js";
import { ClausIEv2Extractor } from "./extractors/clausie_v2.js";
import { IntegrationManager } from "./integrations/manager.js";
import type {
  MemoryNode,
  MemoryEdge,
  ScoredMemoryNode,
  MemoryQueryOptions,
  RetrievalResult,
  RetrievalTelemetry,
  NodeType,
  EntityCategory,
} from "./core/types.js";

export interface MeshConfig {
  dbPath?: string;
  autoHydrate?: boolean;
}

export class NeuroSwarmMesh {
  private storage: SQLiteStorage;
  private graph: AdjacencyGraph;
  private integrations: IntegrationManager;

  constructor(config: MeshConfig = {}) {
    const dbPath = config.dbPath || ":memory:";
    this.storage = new SQLiteStorage(dbPath);
    this.graph = new AdjacencyGraph();
    this.integrations = new IntegrationManager(this, dbPath);

    if (config.autoHydrate !== false) {
      this.hydrate();
    }
  }

  /**
   * Hydrates in-memory graph from SQLite records (< 1ms)
   */
  public hydrate() {
    const nodes = this.storage.getAllNodes();
    const edges = this.storage.getAllEdges();
    this.graph.hydrate(nodes, edges);
  }

  public getStorage(): SQLiteStorage {
    return this.storage;
  }

  public getGraph(): AdjacencyGraph {
    return this.graph;
  }

  public getIntegrations(): IntegrationManager {
    return this.integrations;
  }

  /**
   * Ingest structured MemoryNode into durable SQLite and RAM graph
   */
  public ingestNode(node: MemoryNode, contentForFts?: string) {
    this.storage.upsertNode(node, contentForFts);
    this.graph.addNode(node);
    this.autoResolveConflicts(node);
  }

  public deleteNode(nodeId: string) {
    this.storage.deleteNode(nodeId);
    this.graph.removeNode(nodeId);
  }

  /**
   * Ingest synaptic MemoryEdge into durable SQLite and RAM graph
   */
  public ingestEdge(edge: MemoryEdge) {
    this.storage.upsertEdge(edge);
    this.graph.addEdgeInMemory(
      edge.sourceId,
      edge.targetId,
      edge.relation,
      edge.weight,
      edge.lastActivated
    );
  }

  public deleteEdge(sourceId: string, targetId: string, relation: string) {
    this.storage.deleteEdge(sourceId, targetId, relation);
    this.graph.removeEdgeInMemory(sourceId, targetId, relation);
  }

  /**
   * Ingest natural language text into the mesh using Zero-LLM OpenIE.
   * Deconstructs text into ClausIE v2 triplets and generates nodes & edges automatically.
   */
  public ingestText(
    text: string,
    options: {
      source?: string;
      authority?: number;
      nodeType?: NodeType;
      category?: EntityCategory;
      customId?: string;
    } = {}
  ): { nodeId: string; extractedTriplets: any[] } {
    const cleanText = text.trim();
    const source = options.source || "user_fact";
    const authority = options.authority ?? 1.0;
    const nodeType = options.nodeType || "fact";
    const entityCategory = options.category || "general";

    const triplets = ClausIEv2Extractor.extract(cleanText);
    const nodeId = options.customId || `fact-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`;

    const node: MemoryNode = {
      id: nodeId,
      nodeType,
      label: cleanText.length > 80 ? cleanText.substring(0, 77) + "..." : cleanText,
      source,
      authority,
      entityCategory,
      payload: {
        text: cleanText,
        triplets,
      },
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };

    this.ingestNode(node, cleanText);

    // Wire up relational entities extracted from triplets
    for (let i = 0; i < triplets.length; i++) {
      const trip = triplets[i];
      if (trip.object && trip.object.length > 1) {
        const objSlug = trip.object.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
        const objNodeId = `entity-${objSlug}`;

        // Ensure object entity node exists
        if (!this.storage.getNodeById(objNodeId)) {
          this.ingestNode({
            id: objNodeId,
            nodeType: "concept",
            label: trip.object,
            source: "inferred",
            authority: authority * 0.8,
            entityCategory: trip.entityCategory || "concept",
            payload: { name: trip.object },
            createdAt: Date.now(),
            updatedAt: Date.now(),
          });
        }

        // Link fact node to object entity
        this.ingestEdge({
          sourceId: nodeId,
          targetId: objNodeId,
          relation: trip.relation || "relates_to",
          weight: 0.9,
          lastActivated: Date.now(),
        });
      }
    }

    return { nodeId, extractedTriplets: triplets };
  }

  /**
   * Directed Epistemic Supersession:
   * When an authoritative node (>= 0.90) makes an attribute assertion (e.g. residence/location),
   * dynamically inject :SUPERSEDES edges targeting conflicting lower-authority unverified claims.
   */
  public autoResolveConflicts(newNode: MemoryNode) {
    if ((newNode.authority ?? 1.0) < 0.90) return;

    const allNodes = this.storage.getAllNodes();
    const isPersonalLocation =
      (newNode.entityCategory === "person" || newNode.source === "user_fact" || newNode.nodeType === "invariant") &&
      /live|reside|residence|location/i.test(newNode.label + " " + JSON.stringify(newNode.payload));

    if (isPersonalLocation) {
      for (const existing of allNodes) {
        if (existing.id === newNode.id) continue;
        const existAuth = existing.authority ?? 1.0;
        if (existAuth < 0.90 && (existing.source.includes("social") || existing.source.includes("scraper") || existing.source.includes("feed"))) {
          if (existing.payload.publicLocationClaim || /located in/i.test(existing.label)) {
            this.ingestEdge({
              sourceId: newNode.id,
              targetId: existing.id,
              relation: ":SUPERSEDES",
              weight: 1.0,
              lastActivated: Date.now(),
            });
          }
        }
      }
    }
  }

  /**
   * The Master Retrieval Pipeline:
   * 1. Lexical Scout Search: SQLite FTS5 BM25 + Substring Reciprocal Rank Fusion (RRF)
   * 2. Invariant & Guaranteed Node Hook
   * 3. Spreading Activation: RAM pointer traversal with Collins & Loftus decay
   * 4. Lateral Inhibition: Category capacity filtering & directed supersession
   * 5. Peripheral Attention Engineering (PAE) Context Slotting (<150-250 tokens)
   * 6. Ant Colony Optimization (ACO) Pheromone Reinforcement
   */
  public query(queryText: string, options: MemoryQueryOptions = {}): RetrievalResult {
    const tStart = performance.now();
    const lexicalLimit = options.lexicalLimit ?? 16;
    const maxHops = options.maxHops ?? 2;
    const hopDecay = options.hopDecay ?? 0.45;
    const minEnergyThreshold = options.minEnergyThreshold ?? 0.05;
    const lateralMax = options.lateralInhibitionMaxPerCategory ?? 3;

    // 1. Lexical Scout Search
    const tSearchStart = performance.now();
    let seedHits = this.storage.searchHybridRRF(queryText, lexicalLimit);
    const searchDurationMs = performance.now() - tSearchStart;

    // 2. Invariant & Domain Guaranteed Hook
    const allStoredNodes = this.storage.getAllNodes();
    const guaranteedNodes: MemoryNode[] = [];

    // Always guarantee pinned invariants matching query keywords or explicit filter
    if (options.guaranteedFilter) {
      const filtered = allStoredNodes.filter((n) => options.guaranteedFilter!(n, queryText));
      guaranteedNodes.push(...filtered);
    } else {
      // Default heuristic: if query touches invariant domain words (e.g. sleep, boundary, weekend), guarantee match
      const lowerQ = queryText.toLowerCase();
      const invariantMatches = allStoredNodes.filter((n) => {
        if (n.nodeType !== "invariant") return false;
        const text = (n.label + " " + JSON.stringify(n.payload)).toLowerCase();
        return text.split(/\s+/).some((w) => w.length > 3 && lowerQ.includes(w));
      });
      guaranteedNodes.push(...invariantMatches);
    }

    for (const gNode of guaranteedNodes) {
      if (!seedHits.some((s) => s.node.id === gNode.id)) {
        seedHits.unshift({
          node: gNode,
          score: 1.0,
          matchReasons: ["Guaranteed Domain Invariant"],
        });
      }
    }

    // 3. Spreading Activation across in-memory graph
    const tActivationStart = performance.now();
    const activatedNodes = this.graph.spreadingActivation(
      seedHits,
      maxHops,
      hopDecay,
      minEnergyThreshold
    );
    const activationDurationMs = performance.now() - tActivationStart;

    // 4. Lateral Inhibition
    const tInhibitionStart = performance.now();
    const salientNodes = this.graph.lateralInhibition(activatedNodes, lateralMax);
    const inhibitionDurationMs = performance.now() - tInhibitionStart;

    // 5. PAE Context Slotting
    const paePrompt = this.graph.formatPAESlots(salientNodes, options.ambientContext);

    // 6. Ant Colony Optimization (ACO) Reinforcement
    if (salientNodes.length >= 2) {
      this.graph.reinforceEdge(salientNodes[0].node.id, salientNodes[1].node.id, 0.15);
    }

    const totalDurationMs = performance.now() - tStart;

    const telemetry: RetrievalTelemetry = {
      seedCount: seedHits.length,
      activatedCount: activatedNodes.length,
      salientCount: salientNodes.length,
      searchDurationMs,
      activationDurationMs,
      inhibitionDurationMs,
      totalDurationMs,
    };

    return {
      salientNodes,
      seedNodes: seedHits,
      paePrompt,
      telemetry,
    };
  }

  /**
   * Reinforce synaptic connection between two nodes
   */
  public reinforce(sourceId: string, targetId: string, delta: number = 0.1) {
    this.graph.reinforceEdge(sourceId, targetId, delta);
  }

  /**
   * Evaporate unused synaptic edge pheromones over time
   */
  public evaporate(halfLifeDays: number = 14) {
    this.graph.evaporatePheromones(halfLifeDays);
  }

  /**
   * Get telemetry and mesh stats
   */
  public getStats() {
    const nodes = this.storage.getAllNodes();
    const edges = this.storage.getAllEdges();
    return {
      totalNodes: nodes.length,
      totalEdges: edges.length,
      ramNodes: this.graph.getAllNodes().length,
      categories: this.integrations.getAllCategories(),
    };
  }

  public close() {
    this.storage.close();
    this.integrations.close();
  }
}
