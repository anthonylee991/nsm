import { SQLiteStorage, extractContentTerms, type StorageOptions } from "./core/storage/sqlite.js";
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
  FocusState,
  VisibleSet,
} from "./core/types.js";
import { canSee } from "./core/types.js";
import type { NeuralConfig } from "./neural/types.js";

export interface MeshConfig {
  dbPath?: string;
  autoHydrate?: boolean;
  /**
   * Optional local neural components (dense leg and/or cross-encoder rerank). Off by default. With an
   * embedder set, call `embedPending()` after ingest and use `queryAsync()` for recall.
   */
  neural?: NeuralConfig;
  /** Retrieval options for the storage layer (tokenizer, legs, weights). */
  storage?: StorageOptions;
  /**
   * Which nodes `ingestText` links a memory to. `clausie` (default on): the objects of extracted
   * clauses become concept nodes. `terms` (default off): each distinctive content word of the memory
   * becomes a term node, so memories that share rare words are neighbours in the graph.
   */
  graph?: {
    clausie?: boolean;
    terms?: boolean;
    /**
     * Whether concept and term nodes are in the full-text index (default false: they are reached only
     * through the graph, so lexical seeds are always memories).
     */
    searchableConcepts?: boolean;
  };
}

export class NeuroSwarmMesh {
  private storage: SQLiteStorage;
  private graph: AdjacencyGraph;
  private integrations: IntegrationManager;
  private readonly graphConfig: { clausie: boolean; terms: boolean; searchableConcepts: boolean };
  private readonly neural: NeuralConfig;
  /** episodeId -> ordinal -> node id, for episode expansion at query time. */
  private episodes: Map<string, Map<number, string>> = new Map();

  constructor(config: MeshConfig = {}) {
    const dbPath = config.dbPath || ":memory:";
    this.storage = new SQLiteStorage(dbPath, config.storage);
    this.graphConfig = {
      clausie: config.graph?.clausie ?? true,
      terms: config.graph?.terms ?? false,
      searchableConcepts: config.graph?.searchableConcepts ?? false,
    };
    this.neural = config.neural ?? {};
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
    this.episodes.clear();
    for (const n of nodes) this.indexEpisode(n);
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

  private indexEpisode(node: MemoryNode) {
    const episodeId = node.payload?.episodeId;
    const ordinal = node.payload?.ordinal;
    if (episodeId === undefined || episodeId === null || typeof ordinal !== "number") return;
    const key = String(episodeId);
    let byOrdinal = this.episodes.get(key);
    if (!byOrdinal) {
      byOrdinal = new Map();
      this.episodes.set(key, byOrdinal);
    }
    byOrdinal.set(ordinal, node.id);
  }

  /**
   * Ingest structured MemoryNode into durable SQLite and RAM graph
   */
  public ingestNode(node: MemoryNode, contentForFts?: string, searchable: boolean = true) {
    this.storage.upsertNode(node, contentForFts, searchable);
    this.graph.addNode(node);
    this.indexEpisode(node);
    this.autoResolveConflicts(node);
  }

  /**
   * Merge fields into a node's payload in storage and in the in-memory graph (which holds its own node
   * objects), without re-indexing. For lifecycle fields that change on every recall.
   */
  public updatePayload(nodeId: string, patch: Record<string, unknown>, updatedAt: number = Date.now()): boolean {
    const ok = this.storage.updatePayload(nodeId, patch, updatedAt);
    const g = this.graph.getNode(nodeId);
    if (g) {
      g.payload = { ...g.payload, ...patch };
      g.updatedAt = updatedAt;
    }
    return ok;
  }

  public deleteNode(nodeId: string) {
    this.storage.deleteNode(nodeId);
    this.graph.removeNode(nodeId);
    for (const byOrdinal of this.episodes.values()) {
      for (const [ordinal, id] of byOrdinal) {
        if (id === nodeId) byOrdinal.delete(ordinal);
      }
    }
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
      /**
       * Extra payload fields stored with the memory. `episodeId` (string | number) and `ordinal`
       * (number) place it in an episode so query-time episode expansion can find its neighbours.
       */
      payload?: Record<string, any>;
      /** Creation time (epoch ms). Default now; simulations and imports backdate memories. */
      createdAt?: number;
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
        ...(options.payload ?? {}),
        text: cleanText,
        triplets,
      },
      createdAt: options.createdAt ?? Date.now(),
      updatedAt: options.createdAt ?? Date.now(),
    };

    this.ingestNode(node, cleanText);

    // Term nodes: one per distinctive content word, shared across memories.
    if (this.graphConfig.terms) {
      for (const term of extractContentTerms(cleanText)) {
        const termNodeId = `term-${term.replace(/[^a-z0-9]+/g, "-")}`;
        if (!this.graph.getNode(termNodeId)) {
          this.ingestNode({
            id: termNodeId,
            nodeType: "concept",
            label: term,
            source: "inferred",
            authority: 0.5,
            entityCategory: "concept",
            payload: { term },
            createdAt: Date.now(),
            updatedAt: Date.now(),
          }, undefined, this.graphConfig.searchableConcepts);
        }
        this.ingestEdge({ sourceId: nodeId, targetId: termNodeId, relation: "mentions", weight: 1.0, lastActivated: Date.now() });
      }
    }

    // Wire up relational entities extracted from triplets
    for (let i = 0; i < (this.graphConfig.clausie ? triplets.length : 0); i++) {
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
          }, undefined, this.graphConfig.searchableConcepts);
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

    const isPersonalLocation =
      (newNode.entityCategory === "person" || newNode.source === "user_fact" || newNode.nodeType === "invariant") &&
      /live|reside|residence|location/i.test(newNode.label + " " + JSON.stringify(newNode.payload));

    if (isPersonalLocation) {
      const allNodes = this.storage.getAllNodes();
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
   * Episode expansion: for the first `topSeeds` results that belong to an episode, add the
   * memories within `radius` ordinals of them (the turns around a hit), after those seeds and
   * ahead of the rest. Neighbours are ordered by seed rank, then ordinal.
   */
  private expandEpisodes(
    salient: ScoredMemoryNode[],
    topSeeds: number,
    radius: number,
    asker?: VisibleSet
  ): ScoredMemoryNode[] {
    const present = new Set(salient.map((s) => s.node.id));
    const seeds: { item: ScoredMemoryNode; index: number }[] = [];
    for (let i = 0; i < salient.length && seeds.length < topSeeds; i++) {
      const p = salient[i]!.node.payload;
      if (p?.episodeId !== undefined && p?.episodeId !== null && typeof p?.ordinal === "number") {
        seeds.push({ item: salient[i]!, index: i });
      }
    }
    if (seeds.length === 0) return salient;

    const additions: ScoredMemoryNode[] = [];
    for (const { item } of seeds) {
      const byOrdinal = this.episodes.get(String(item.node.payload.episodeId));
      if (!byOrdinal) continue;
      const ordinal = item.node.payload.ordinal as number;
      for (let d = -radius; d <= radius; d++) {
        if (d === 0) continue;
        const neighbourId = byOrdinal.get(ordinal + d);
        if (!neighbourId || present.has(neighbourId)) continue;
        const node = this.graph.getNode(neighbourId) ?? this.storage.getNodeById(neighbourId);
        if (!node) continue;
        if (asker && !canSee(asker, node.gate, node.scope || node.payload?.scope)) continue;
        present.add(neighbourId);
        additions.push({
          node,
          score: item.score * 0.5,
          matchReasons: [`Episode neighbour of ${item.node.id} (${d > 0 ? "+" : ""}${d})`],
        });
      }
    }
    if (additions.length === 0) return salient;

    const insertAt = seeds[seeds.length - 1]!.index + 1;
    return [...salient.slice(0, insertAt), ...additions, ...salient.slice(insertAt)];
  }

  /**
   * Embed every memory node that has no vector yet (requires `neural.embedder`). Returns the count.
   * Call after a batch of ingests; the dense leg only sees embedded memories.
   */
  public async embedPending(batchSize: number = 32): Promise<number> {
    const embedder = this.neural.embedder;
    if (!embedder) return 0;
    const ids = this.storage.getUnembeddedIds();
    for (let i = 0; i < ids.length; i += batchSize) {
      const batch = ids.slice(i, i + batchSize);
      const texts = batch.map((id) => {
        const n = this.storage.getNodeById(id);
        return n ? String(n.payload?.text ?? n.label) : "";
      });
      const vecs = await embedder.embed(texts, "document");
      batch.forEach((id, j) => this.storage.upsertVector(id, embedder.name, vecs[j]!));
    }
    return ids.length;
  }

  /**
   * `query()` plus the optional neural components: a dense leg fused with the lexical seeds, and a
   * cross-encoder rerank of the top memories. Both run in-process. Latency includes model time.
   */
  public async queryAsync(queryText: string, options: MemoryQueryOptions = {}): Promise<RetrievalResult> {
    const tStart = performance.now();
    const extraLegs: { name: string; ids: string[]; weight?: number }[] = [];
    if (this.neural.embedder) {
      const [qv] = await this.neural.embedder.embed([queryText], "query");
      const limit = this.neural.denseLimit ?? options.lexicalLimit ?? 16;
      const hits = this.storage.searchDense(qv!, limit, options.asker);
      // Dense weight 2 and a 100-candidate rerank: the configuration confirmed on test (NSM-SPEC §4.4).
      extraLegs.push({ name: "Dense", ids: hits.map((h) => h.id), weight: this.neural.denseWeight ?? 2 });
    }
    const result = this.runQuery(queryText, options, extraLegs);

    if (this.neural.reranker) {
      const candidates = this.neural.rerankCandidates ?? 100;
      const isMemory = (n: ScoredMemoryNode) => typeof n.node.payload?.text === "string" || n.node.nodeType !== "concept";
      const memories = result.salientNodes.filter(isMemory).slice(0, candidates);
      const rest = result.salientNodes.filter((n) => !memories.includes(n));
      if (memories.length > 1) {
        const scores = await this.neural.reranker.score(
          queryText,
          memories.map((m) => String(m.node.payload?.text ?? m.node.label))
        );
        const reranked = memories
          .map((m, i) => ({
            ...m,
            score: scores[i]!,
            matchReasons: [...m.matchReasons, `Rerank ${scores[i]!.toFixed(2)}`],
          }))
          .sort((a, b) => b.score - a.score);
        result.salientNodes = [...reranked, ...rest];
        result.paePrompt = this.graph.formatPAESlots(result.salientNodes, options.ambientContext);
      }
    }
    result.telemetry.totalDurationMs = performance.now() - tStart;
    return result;
  }

  /**
   * The Master Retrieval Pipeline:
   * 1. Lexical Scout Search: SQLite FTS5 BM25 + Substring Reciprocal Rank Fusion (RRF)
   * 2. Invariant & Guaranteed Node Hook
   * 3. Spreading Activation: RAM pointer traversal with Collins & Loftus decay
   * 4. Lateral Inhibition: Category capacity filtering & directed supersession
   * 5. Episode expansion (optional): the memories around the top hits
   * 6. Peripheral Attention Engineering (PAE) Context Slotting (<150-250 tokens)
   * 7. Ant Colony Optimization (ACO) Pheromone Reinforcement
   */
  public query(queryText: string, options: MemoryQueryOptions = {}): RetrievalResult {
    return this.runQuery(queryText, options, []);
  }

  private runQuery(
    queryText: string,
    options: MemoryQueryOptions,
    extraLegs: { name: string; ids: string[] }[]
  ): RetrievalResult {
    const tStart = performance.now();
    // Defaults = the configurations confirmed on the LoCoMo test split (NSM-SPEC §4.4). Without a dense
    // leg: 50 seeds, up to 10 memories per node type. With one: 100 fused seeds, up to 100 memories
    // kept for the reranker, the neighbours of the top 10 hits added to its pool.
    const neural = Boolean(this.neural.embedder);
    const lexicalLimit = options.lexicalLimit ?? (neural ? 100 : 50);
    const maxHops = options.maxHops ?? 2;
    const hopDecay = options.hopDecay ?? 0.45;
    const minEnergyThreshold = options.minEnergyThreshold ?? 0.05;
    const lateralMax = options.lateralInhibitionMaxPerCategory ?? (neural ? 100 : 10);
    const episodeExpansion = options.episodeExpansion ?? (neural && this.episodes.size > 0 ? { topSeeds: 10, radius: 1 } : undefined);
    const asker = options.asker;

    // Focus hysteresis state management
    let updatedFocus: FocusState = options.focus ? { ...options.focus } : {};
    const lowerQ = queryText.toLowerCase();

    // Check for explicit scope/entity mentions
    const allStoredNodes = this.storage.getAllNodes();
    let detectedScope: string | null = null;
    for (const n of allStoredNodes) {
      const scope = n.scope || n.payload.scope;
      if (scope && canSee(asker, n.gate, scope)) {
        if (lowerQ.includes(scope.toLowerCase()) || lowerQ.includes(n.label.toLowerCase())) {
          detectedScope = scope;
          break;
        }
      }
    }

    if (detectedScope) {
      // Direct focus lock
      updatedFocus = {
        [`entity:${detectedScope}`]: {
          state: "locked",
          last: 1.0,
          scopeId: detectedScope,
        },
      };
    } else {
      // Check pronoun/follow-up continuation or access revocation
      const focusKeys = Object.keys(updatedFocus);
      if (focusKeys.length > 0) {
        const primaryKey = focusKeys[0]!;
        const currentScope = updatedFocus[primaryKey]?.scopeId;
        if (currentScope && asker && !canSee(asker, undefined, currentScope)) {
          // Access revoked mid-session: immediately purge focus
          updatedFocus = {};
        } else {
          // Retain focus within attractor basin for ambiguous queries
          const isAmbiguous = /their|its|they|who|what|where|how|and|is|about|from|when/i.test(queryText);
          if (isAmbiguous) {
            updatedFocus[primaryKey] = {
              ...updatedFocus[primaryKey]!,
              last: Math.max(0.40, (updatedFocus[primaryKey]!.last || 1.0) * 0.90),
            };
          } else {
            delete updatedFocus[primaryKey];
          }
        }
      }
    }

    // 1. Lexical Scout Search with Invariant I1: Visibility filter inside retrieval
    const tSearchStart = performance.now();
    let seedHits = this.storage.searchHybridRRF(queryText, lexicalLimit, 60, asker, extraLegs);
    const searchDurationMs = performance.now() - tSearchStart;

    // Normalize RRF scores so top lexical matches scale to 1.0
    if (seedHits.length > 0) {
      const maxSeedScore = Math.max(...seedHits.map((s) => s.score), 0.0001);
      seedHits = seedHits.map((s) => ({
        ...s,
        score: s.score / maxSeedScore,
      }));
    }

    // If focus is locked and query is ambiguous, inject focused scope seeds as ambient background support
    const activeFocusKeys = Object.keys(updatedFocus);
    if (activeFocusKeys.length > 0) {
      const focusedScope = updatedFocus[activeFocusKeys[0]!]?.scopeId;
      if (focusedScope) {
        const focusedNodes = allStoredNodes.filter(
          (n) => (n.scope === focusedScope || n.payload.scope === focusedScope) && canSee(asker, n.gate, focusedScope)
        );
        for (const fNode of focusedNodes.slice(0, 3)) {
          if (!seedHits.some((s) => s.node.id === fNode.id)) {
            seedHits.push({
              node: fNode,
              score: 0.35 * (updatedFocus[activeFocusKeys[0]!]?.last || 1.0),
              matchReasons: [`Focus Attractor Basin (${focusedScope})`],
            });
          }
        }
      }
    }

    // 2. Invariant & Domain Guaranteed Hook
    const guaranteedNodes: MemoryNode[] = [];

    // Always guarantee pinned invariants matching query keywords or explicit filter
    if (options.guaranteedFilter) {
      const filtered = allStoredNodes.filter((n) => canSee(asker, n.gate, n.scope || n.payload.scope) && options.guaranteedFilter!(n, queryText));
      guaranteedNodes.push(...filtered);
    } else {
      const invariantMatches = allStoredNodes.filter((n) => {
        if (n.nodeType !== "invariant") return false;
        if (!canSee(asker, n.gate, n.scope || n.payload.scope)) return false;
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
      minEnergyThreshold,
      asker,
      { fanDamping: options.fanDamping }
    );
    const activationDurationMs = performance.now() - tActivationStart;

    // 4. Lateral Inhibition
    const tInhibitionStart = performance.now();
    let salientNodes = this.graph.lateralInhibition(activatedNodes, lateralMax, asker);
    const inhibitionDurationMs = performance.now() - tInhibitionStart;

    // 5. Episode expansion (default on with a dense leg, where the reranker judges the neighbours;
    //    measured to hurt without one, so off there unless asked for)
    if (episodeExpansion) {
      salientNodes = this.expandEpisodes(
        salientNodes,
        episodeExpansion.topSeeds ?? 3,
        episodeExpansion.radius ?? 1,
        asker
      );
    }

    // 6. PAE Context Slotting
    const paePrompt = this.graph.formatPAESlots(salientNodes, options.ambientContext);

    // 7. Ant Colony Optimization (ACO) Reinforcement
    if (salientNodes.length >= 2) {
      this.graph.reinforceEdge(salientNodes[0]!.node.id, salientNodes[1]!.node.id, 0.15);
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
      focus: updatedFocus,
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

  /** close() plus releasing any loaded neural models. */
  public async closeAsync() {
    this.close();
    await this.neural.embedder?.dispose?.();
    await this.neural.reranker?.dispose?.();
  }
}
