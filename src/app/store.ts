import { NeuroSwarmMesh } from "../mesh.js";
import type { MemoryNode, ScoredMemoryNode } from "../core/types.js";
import type { NeuralConfig } from "../neural/types.js";
import { LocalEmbedder, LocalReranker } from "../neural/local.js";
import { dbPath, loadConfig, modelDir, type NsmConfig } from "./paths.js";
import {
  DEFAULT_FORGETTING,
  SPREAD_EPISODE_WEIGHT,
  SPREAD_EPISODE_WINDOW_MINUTES,
  SPREAD_MIN_SIMILARITY,
  SPREAD_NEIGHBOURS_PER_SEED,
  SPREAD_SEEDS,
  boostOnAccess,
  decayedStrength,
  forgettingAction,
  initialStrength,
  rankScore,
  spreadBoost,
  type ForgettingParams,
  type Importance,
} from "../lifecycle/strength.js";
import { absenceFlags, lexicalSimilarity, type AbsenceFlag, type DatedMemory } from "../lifecycle/absence.js";

export interface Memory {
  id: string;
  text: string;
  pinned: boolean;
  source: string;
  createdAt: string; // ISO
  /** When the remembered thing happened (defaults to createdAt). */
  occurredAt: string;
  strength: number;
  state: "active" | "archived";
}

export interface RecallItem extends Memory {
  score: number;
  reasons: string[];
}

export interface RecallResult {
  pinned: Memory[];
  memories: RecallItem[];
  flags: AbsenceFlag[];
  /** Ready to paste into a prompt: pinned rules, anomaly flags, then memories with dates and ids. */
  prompt: string;
  latencyMs: number;
  neural: boolean;
}

export interface StoreOptions {
  dbPath?: string;
  config?: NsmConfig;
  neural?: boolean;
  /** Clock, for simulations. Default Date.now. */
  now?: () => number;
  forgetting?: ForgettingParams;
  /** Reinforce recalled memories (default true). False for read-only evaluation. */
  reinforce?: boolean;
  /** Spread a smaller reinforcement to each recalled memory's associates (default true). */
  spread?: boolean;
  /**
   * Family similarity floors for absence flags: lexical Jaccard (default 0.15, chosen on the dev split
   * of the absence test and confirmed on test) or cosine when the store has vectors (default 0.6).
   */
  absenceSimilarity?: { cosine?: number; lexical?: number };
  /**
   * How absence-flag families are found. "lexical" (default) uses word overlap; "cosine" uses stored
   * vectors when every recalled memory has one. Measured on the absence test: lexical flagged 65% of
   * stopped routines with no false flags on dev; cosine from the small local embedder did worse at
   * every floor.
   */
  absenceFamilies?: "lexical" | "cosine";
}

/**
 * The product surface over NeuroSwarmMesh: one SQLite file under ~/.nsm, optional local models, the
 * ACM lifecycle (strength, reinforcement, forgetting by demotion, absence flags) and three verbs
 * (remember, recall, forget). Used by the CLI and the MCP server.
 */
export class MemoryStore {
  readonly config: NsmConfig;
  readonly neural: boolean;
  private readonly mesh: NeuroSwarmMesh;
  private readonly now: () => number;
  private readonly forgetting: ForgettingParams;
  private readonly reinforce: boolean;
  private readonly spread: boolean;
  private readonly absenceSimilarity: { cosine: number; lexical: number };
  private readonly absenceFamilies: "lexical" | "cosine";

  constructor(options: StoreOptions = {}) {
    this.config = options.config ?? loadConfig();
    this.neural = options.neural ?? this.config.neural;
    this.now = options.now ?? (() => Date.now());
    this.forgetting = options.forgetting ?? DEFAULT_FORGETTING;
    this.reinforce = options.reinforce ?? true;
    this.spread = options.spread ?? true;
    this.absenceSimilarity = { cosine: options.absenceSimilarity?.cosine ?? 0.6, lexical: options.absenceSimilarity?.lexical ?? 0.15 };
    this.absenceFamilies = options.absenceFamilies ?? "lexical";
    const neural: NeuralConfig = {};
    if (this.neural) {
      const dir = modelDir();
      neural.embedder = new LocalEmbedder(this.config.embedModel, { modelDir: dir });
      neural.reranker = new LocalReranker(this.config.rerankModel, { modelDir: dir });
      neural.rerankCandidates = 50;
    }
    this.mesh = new NeuroSwarmMesh({ dbPath: options.dbPath ?? dbPath(), neural });
  }

  // ---- node helpers ----

  private isMemory(n: MemoryNode): boolean {
    return n.nodeType === "fact" || n.nodeType === "invariant";
  }

  private importance(n: MemoryNode): Importance {
    return n.nodeType === "invariant" ? "pinned" : ((n.payload?.importance as Importance) ?? "default");
  }

  /** Current strength: the stored value decayed to now. */
  private strengthOf(n: MemoryNode, now: number): number {
    const p = n.payload ?? {};
    const base = typeof p.strength === "number" ? p.strength : initialStrength(this.importance(n));
    const since = typeof p.strengthAt === "number" ? p.strengthAt : n.createdAt;
    return decayedStrength(base, now - since, p.boostCount ?? 0, this.importance(n));
  }

  private occurredAtOf(n: MemoryNode): number {
    return typeof n.payload?.occurredAt === "number" ? n.payload.occurredAt : n.createdAt;
  }

  private toMemory(n: MemoryNode, now: number = this.now()): Memory {
    return {
      id: n.id,
      text: String(n.payload?.text ?? n.payload?.rule ?? n.label),
      pinned: n.nodeType === "invariant",
      source: n.source,
      createdAt: new Date(n.createdAt).toISOString(),
      occurredAt: new Date(this.occurredAtOf(n)).toISOString(),
      strength: this.strengthOf(n, now),
      state: n.payload?.state === "archived" ? "archived" : "active",
    };
  }

  private memories(): MemoryNode[] {
    return this.mesh.getStorage().getAllNodes().filter((n) => this.isMemory(n));
  }

  // ---- verbs ----

  /** Store one memory. Exact duplicates (same text) return the existing id. */
  async remember(
    text: string,
    options: {
      pinned?: boolean;
      source?: string;
      importance?: Importance;
      occurredAt?: number;
      createdAt?: number;
      /** Store even if the same text exists (benchmarks ingest repeated turns as separate memories). */
      allowDuplicate?: boolean;
      /** Caller-chosen id (benchmarks map turns to memories). */
      id?: string;
    } = {},
  ): Promise<{ id: string; duplicate: boolean }> {
    const clean = text.trim();
    if (!clean) throw new Error("empty memory");
    if (!options.allowDuplicate) {
      const existing = this.memories().find((n) => String(n.payload?.text ?? "") === clean);
      if (existing) return { id: existing.id, duplicate: true };
    }

    const pinned = options.pinned === true;
    const importance: Importance = pinned ? "pinned" : (options.importance ?? "default");
    const createdAt = options.createdAt ?? this.now();
    const { nodeId } = this.mesh.ingestText(clean, {
      source: options.source ?? (pinned ? "user_invariant" : "user_fact"),
      nodeType: pinned ? "invariant" : "fact",
      authority: 1.0,
      createdAt,
      customId: options.id,
      payload: {
        ...(pinned ? { rule: clean } : {}),
        importance,
        strength: initialStrength(importance),
        strengthAt: createdAt,
        boostCount: 0,
        state: "active",
        occurredAt: options.occurredAt ?? createdAt,
      },
    });
    if (this.neural) await this.mesh.embedPending();
    return { id: nodeId, duplicate: false };
  }

  /**
   * Archived (demoted) memories are still candidates: their strength is at the floor, so they lose to
   * active memories on weak cues, but a direct question reactivates them (cued reactivation in the rank
   * score), and being recalled makes them active again. `activeOnly` hides them instead.
   */
  async recall(query: string, k?: number, options: { activeOnly?: boolean; flags?: boolean } = {}): Promise<RecallResult> {
    const start = performance.now();
    const now = this.now();
    const limit = k ?? this.config.k;
    const queryOptions = {
      // Rank over a wider pool, then let strength and state decide the final order.
      lateralInhibitionMaxPerCategory: Math.max(limit * 3, 20),
      // Every pinned rule is delivered on every recall, whether or not the query mentions it.
      guaranteedFilter: (n: MemoryNode) => n.nodeType === "invariant",
    };
    const result = this.neural
      ? await this.mesh.queryAsync(query, queryOptions)
      : this.mesh.query(query, queryOptions);

    const pinned: Memory[] = [];
    const candidates: Array<{ node: MemoryNode; relevance: number; reasons: string[] }> = [];
    const seen = new Set<string>();
    const scores = (result.salientNodes as ScoredMemoryNode[]).filter((s) => this.isMemory(s.node) && s.node.nodeType !== "invariant");
    // Relevance in 0..1: cross-encoder logits through a sigmoid, otherwise share of the top score.
    const reranked = scores.some((s) => s.matchReasons.some((r) => r.startsWith("Rerank")));
    const top = Math.max(...scores.map((s) => s.score), 1e-9);
    const relevanceOf = (s: ScoredMemoryNode) => (reranked ? 1 / (1 + Math.exp(-s.score)) : Math.max(0, s.score) / top);

    for (const s of result.salientNodes as ScoredMemoryNode[]) {
      if (!this.isMemory(s.node) || seen.has(s.node.id)) continue;
      seen.add(s.node.id);
      if (s.node.nodeType === "invariant") {
        pinned.push(this.toMemory(s.node, now));
        continue;
      }
      if (options.activeOnly && s.node.payload?.state === "archived") continue;
      candidates.push({ node: s.node, relevance: relevanceOf(s), reasons: s.matchReasons });
    }

    const ranked = candidates
      .map((c) => ({ ...c, score: rankScore(c.relevance, this.strengthOf(c.node, now)) }))
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);

    const memories: RecallItem[] = ranked.map((c) => ({ ...this.toMemory(c.node, now), score: c.score, reasons: c.reasons }));

    if (this.reinforce) this.reinforceRecall(ranked.map((c) => c.node), now);

    const flags = options.flags === false ? [] : this.absenceFlagsFor(ranked.map((c) => c.node), now);

    return {
      pinned,
      memories,
      flags,
      prompt: formatPrompt(pinned, memories, flags),
      latencyMs: performance.now() - start,
      neural: this.neural,
    };
  }

  /** Reinforce what was recalled, and spread a smaller reinforcement to each seed's associates. */
  private reinforceRecall(recalled: MemoryNode[], now: number): void {
    const storage = this.mesh.getStorage();
    const recalledIds = new Set(recalled.map((n) => n.id));
    for (const n of recalled) {
      const strength = this.strengthOf(n, now);
      this.mesh.updatePayload(n.id, {
        strength: boostOnAccess(strength, this.importance(n), 1),
        strengthAt: now,
        boostCount: (n.payload?.boostCount ?? 0) + 1,
        lastRecalledAt: now,
        state: "active", // a recalled memory is reactivated, archived or not
      }, now);
    }
    if (!this.spread) return;
    const boosts = new Map<string, number>();
    const all = this.memories().filter((n) => n.nodeType === "fact" && !recalledIds.has(n.id));
    const vectors = storage.getAllVectors();
    for (const seed of recalled.slice(0, SPREAD_SEEDS)) {
      const seedVec = vectors.get(seed.id);
      if (seedVec) {
        const sims = all
          .map((n) => ({ n, v: vectors.get(n.id) }))
          .filter((x) => x.v && x.v.length === seedVec.length)
          .map((x) => {
            let s = 0;
            for (let i = 0; i < seedVec.length; i++) s += seedVec[i]! * x.v![i]!;
            return { n: x.n, s };
          })
          .filter((x) => x.s >= SPREAD_MIN_SIMILARITY)
          .sort((a, b) => b.s - a.s)
          .slice(0, SPREAD_NEIGHBOURS_PER_SEED);
        for (const x of sims) boosts.set(x.n.id, Math.max(boosts.get(x.n.id) ?? 0, spreadBoost(1)));
      }
      const seedTime = this.occurredAtOf(seed);
      for (const n of all) {
        if (Math.abs(this.occurredAtOf(n) - seedTime) <= SPREAD_EPISODE_WINDOW_MINUTES * 60_000) {
          boosts.set(n.id, Math.max(boosts.get(n.id) ?? 0, spreadBoost(SPREAD_EPISODE_WEIGHT)));
        }
      }
    }
    for (const [id, boost] of boosts) {
      const n = all.find((m) => m.id === id);
      if (!n) continue;
      const strength = this.strengthOf(n, now);
      this.mesh.updatePayload(id, { strength: Math.min(1, strength + boost), strengthAt: now }, now);
    }
  }

  private absenceFlagsFor(recalled: MemoryNode[], now: number): AbsenceFlag[] {
    if (recalled.length === 0) return [];
    const toDated = (n: MemoryNode): DatedMemory & { node: MemoryNode } => ({
      id: n.id,
      text: String(n.payload?.text ?? n.label),
      occurredAt: this.occurredAtOf(n),
      node: n,
    });
    const all = this.memories().filter((n) => n.nodeType === "fact").map(toDated);
    const vectors = this.mesh.getStorage().getAllVectors();
    const cosine = (a: DatedMemory, b: DatedMemory): number => {
      const va = vectors.get(a.id);
      const vb = vectors.get(b.id);
      if (!va || !vb || va.length !== vb.length) return lexicalSimilarity(a, b);
      let s = 0;
      for (let i = 0; i < va.length; i++) s += va[i]! * vb[i]!;
      return s;
    };
    const useVectors = this.absenceFamilies === "cosine" && vectors.size > 0 && recalled.every((n) => vectors.has(n.id));
    return absenceFlags(
      recalled.map(toDated), all, now,
      useVectors ? cosine : lexicalSimilarity,
      useVectors ? this.absenceSimilarity.cosine : this.absenceSimilarity.lexical,
    );
  }

  forget(id: string): boolean {
    const node = this.mesh.getStorage().getNodeById(id);
    if (!node || !this.isMemory(node)) return false;
    this.mesh.deleteNode(id);
    return true;
  }

  list(options: { pinned?: boolean; limit?: number; includeArchived?: boolean } = {}): Memory[] {
    const now = this.now();
    const all = this.memories()
      .filter((n) => options.pinned === undefined || (n.nodeType === "invariant") === options.pinned)
      .filter((n) => options.includeArchived || n.payload?.state !== "archived")
      .sort((a, b) => b.createdAt - a.createdAt)
      .map((n) => this.toMemory(n, now));
    return options.limit ? all.slice(0, options.limit) : all;
  }

  /**
   * The daily sweep: decay is computed lazily on read, so the sweep only applies the forgetting policy.
   * Faded, idle memories are demoted to `archived` (kept, searchable with includeArchived) or deleted,
   * per `forgetting.mode`. Returns what it did.
   */
  sweep(): { demoted: number; deleted: number; kept: number } {
    const now = this.now();
    const storage = this.mesh.getStorage();
    let demoted = 0, deleted = 0, kept = 0;
    for (const n of this.memories()) {
      const action = forgettingAction(
        {
          strength: this.strengthOf(n, now),
          importance: this.importance(n),
          lastRecalledAt: n.payload?.lastRecalledAt ?? null,
          createdAt: n.createdAt,
          state: n.payload?.state,
        },
        now,
        this.forgetting,
      );
      if (action === "demote") {
        this.mesh.updatePayload(n.id, { state: "archived", archivedAt: now }, now);
        demoted++;
      } else if (action === "delete") {
        this.mesh.deleteNode(n.id);
        deleted++;
      } else kept++;
    }
    return { demoted, deleted, kept };
  }

  stats(): { memories: number; archived: number; pinned: number; vectors: number; neural: boolean; db: string } {
    const nodes = this.memories();
    return {
      memories: nodes.filter((n) => n.nodeType === "fact" && n.payload?.state !== "archived").length,
      archived: nodes.filter((n) => n.payload?.state === "archived").length,
      pinned: nodes.filter((n) => n.nodeType === "invariant").length,
      vectors: this.mesh.getStorage().getAllVectors().size,
      neural: this.neural,
      db: dbPath(),
    };
  }

  /** Embed every memory that has no vector yet (after `nsm models install`, or after a bulk import). */
  async embedAll(): Promise<number> {
    return this.mesh.embedPending();
  }

  async close(): Promise<void> {
    await this.mesh.closeAsync();
  }
}

export function formatPrompt(pinned: Memory[], memories: RecallItem[], flags: AbsenceFlag[] = []): string {
  const sections: string[] = [];
  if (pinned.length) {
    sections.push("[PINNED RULES]\n" + pinned.map((p) => `• ${p.text}`).join("\n"));
  }
  if (flags.length) {
    sections.push("[ANOMALY FLAGS]\n" + flags.map((f) => `• ${f.description}. Last: (${f.occurredAt.slice(0, 10)}) ${f.text}`).join("\n"));
  }
  if (memories.length) {
    sections.push(
      "[MEMORIES]\n" + memories.map((m) => `• (${m.occurredAt.slice(0, 10)}) ${m.text}  [id: ${m.id}]`).join("\n")
    );
  }
  if (sections.length === 0) return "(no memories match)";
  return sections.join("\n\n");
}
