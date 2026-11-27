import { MemoryDB, searchTokens, type MemoryRecord } from "./db.js";
import { initialStrength, type Importance } from "./lifecycle/strength.js";
import type { NeuralConfig } from "./neural/types.js";

/**
 * The retrieval pipeline, as measured on LoCoMo (NSM-SPEC §4):
 *
 *   1. legs     BM25 (Porter, prefix), phrase pairs, substring counts; plus a dense leg with an embedder
 *   2. fusion   reciprocal rank fusion (k = 60), the dense leg at weight 2
 *   3. episodes with a dense leg: the memories saved next to the top 10 hits join the pool
 *   4. rerank   with a reranker: a cross-encoder orders the top 100
 *
 * Pinned rules are not ranked here; the store delivers them on every recall.
 */
export interface RetrieverConfig {
  dbPath?: string;
  /** Optional local models. With an embedder, call `embedPending()` after adding memories. */
  neural?: NeuralConfig;
  /** Lexical legs, for ablations. All on by default (each was measured to help). */
  legs?: { substring?: boolean; phrase?: boolean; prefix?: boolean };
}

export interface AddOptions {
  /** Caller-chosen id (benchmarks map turns to memories). */
  id?: string;
  pinned?: boolean;
  source?: string;
  importance?: Importance;
  createdAt?: number;
  occurredAt?: number;
  episode?: number;
  ordinal?: number;
  /** Project key (src/app/project.ts), or null / absent for everywhere. */
  project?: string | null;
}

export interface SearchOptions {
  /** Fused candidates kept (default 50; 100 with a dense leg). */
  seeds?: number;
  /** Memories returned before episode expansion and rerank (default: `seeds`). */
  limit?: number;
  /**
   * Add the memories within `radius` ordinals of the first `topSeeds` hits, right after them. Default on
   * with a dense leg ({ topSeeds: 10, radius: 1 }), where the reranker judges them; measured to hurt
   * without one.
   */
  episodes?: { topSeeds?: number; radius?: number } | false;
}

export interface Hit {
  memory: MemoryRecord;
  /** Fused rank score, or the cross-encoder logit when `reranked`. */
  score: number;
  reasons: string[];
}

export interface SearchResult {
  hits: Hit[];
  reranked: boolean;
  latencyMs: number;
}

const RRF_K = 60;

export class Retriever {
  readonly db: MemoryDB;
  private readonly neural: NeuralConfig;
  private readonly legs: { substring: boolean; phrase: boolean; prefix: boolean };

  constructor(config: RetrieverConfig = {}) {
    this.db = new MemoryDB(config.dbPath ?? ":memory:");
    this.neural = config.neural ?? {};
    this.legs = { substring: config.legs?.substring ?? true, phrase: config.legs?.phrase ?? true, prefix: config.legs?.prefix ?? true };
  }

  /** Store one memory as given (no dedupe: that is the store's job). */
  add(text: string, options: AddOptions = {}): MemoryRecord {
    const clean = text.trim();
    if (!clean) throw new Error("empty memory");
    const createdAt = options.createdAt ?? Date.now();
    const importance: Importance = options.pinned ? "pinned" : (options.importance ?? "default");
    const memory: MemoryRecord = {
      id: options.id ?? `fact-${createdAt}-${Math.random().toString(36).slice(2, 7)}`,
      text: clean,
      pinned: options.pinned === true,
      source: options.source ?? "user_fact",
      createdAt,
      occurredAt: options.occurredAt ?? createdAt,
      episode: options.episode ?? null,
      ordinal: options.ordinal ?? null,
      importance,
      strength: initialStrength(importance),
      strengthAt: createdAt,
      boosts: 0,
      lastRecalledAt: null,
      state: "active",
      archivedAt: null,
      project: options.project ?? null,
    };
    this.db.insert(memory);
    return memory;
  }

  /** Embed every unpinned memory that has no vector yet (needs `neural.embedder`). Returns the count. */
  async embedPending(batchSize: number = 32): Promise<number> {
    const embedder = this.neural.embedder;
    if (!embedder) return 0;
    const pending = this.db.unembedded();
    for (let i = 0; i < pending.length; i += batchSize) {
      const batch = pending.slice(i, i + batchSize);
      const vecs = await embedder.embed(batch.map((m) => m.text), "document");
      this.db.transaction(() => batch.forEach((m, j) => this.db.upsertVector(m.id, embedder.name, vecs[j]!)));
    }
    return pending.length;
  }

  async search(query: string, options: SearchOptions = {}): Promise<SearchResult> {
    const t0 = performance.now();
    const { embedder, reranker } = this.neural;
    const seeds = options.seeds ?? (embedder ? 100 : 50);
    const limit = options.limit ?? seeds;

    // 1-2. Legs fused by RRF. Leg order fixes how ties break: dense, BM25, substring, phrase.
    const fused = new Map<string, { score: number; reasons: string[] }>();
    const add = (id: string, score: number, reason: string) => {
      const e = fused.get(id) ?? { score: 0, reasons: [] };
      e.score += score;
      e.reasons.push(reason);
      fused.set(id, e);
    };
    if (embedder) {
      const [qv] = await embedder.embed([query], "query");
      const weight = this.neural.denseWeight ?? 2;
      this.db.searchDense(qv!, this.neural.denseLimit ?? seeds).forEach((id, r) => add(id, weight / (RRF_K + r + 1), `Dense (rank ${r + 1})`));
    }
    this.db.searchBM25(query, seeds * 2, this.legs.prefix).forEach((id, r) => add(id, 1 / (RRF_K + r + 1), `BM25 (rank ${r + 1})`));
    if (this.legs.substring) {
      this.db.searchSubstrings(searchTokens(query), seeds * 2).forEach((h, r) =>
        add(h.id, (1 + h.count * 0.75) / (RRF_K + r + 1), `Keyword match (${h.count} hits)`));
    }
    if (this.legs.phrase) {
      this.db.searchPhrases(query, seeds * 2).forEach((id, r) => add(id, 1 / (RRF_K + r + 1), `Phrase (rank ${r + 1})`));
    }

    let hits: Hit[] = [];
    const index = this.db.index();
    for (const [id, e] of fused) {
      const memory = index.get(id);
      if (memory) hits.push({ memory, score: e.score, reasons: e.reasons });
    }
    hits = hits.sort((a, b) => b.score - a.score).slice(0, Math.min(seeds, limit));

    // 3. Episode neighbours.
    const episodes = options.episodes ?? (embedder ? { topSeeds: 10, radius: 1 } : false);
    if (episodes) hits = this.expandEpisodes(hits, episodes.topSeeds ?? 10, episodes.radius ?? 1);

    // 4. Cross-encoder rerank of the top candidates.
    let reranked = false;
    if (reranker) {
      const n = this.neural.rerankCandidates ?? 100;
      const head = hits.slice(0, n);
      if (head.length > 1) {
        const scores = await reranker.score(query, head.map((h) => h.memory.text));
        const ordered = head
          .map((h, i) => ({ ...h, score: scores[i]!, reasons: [...h.reasons, `Rerank ${scores[i]!.toFixed(2)}`] }))
          .sort((a, b) => b.score - a.score);
        hits = [...ordered, ...hits.slice(n)];
        reranked = true;
      }
    }

    return { hits, reranked, latencyMs: performance.now() - t0 };
  }

  /** Neighbours of the first `topSeeds` episode hits, inserted after the last of those hits, in seed then ordinal order. */
  private expandEpisodes(hits: Hit[], topSeeds: number, radius: number): Hit[] {
    const seeds: { hit: Hit; index: number }[] = [];
    for (let i = 0; i < hits.length && seeds.length < topSeeds; i++) {
      const m = hits[i]!.memory;
      if (m.episode !== null && m.ordinal !== null) seeds.push({ hit: hits[i]!, index: i });
    }
    if (seeds.length === 0) return hits;
    const present = new Set(hits.map((h) => h.memory.id));
    const additions: Hit[] = [];
    for (const { hit } of seeds) {
      const { episode, ordinal, id } = hit.memory;
      for (const n of this.db.episodeRange(episode!, ordinal! - radius, ordinal! + radius)) {
        if (present.has(n.id)) continue;
        present.add(n.id);
        const d = n.ordinal! - ordinal!;
        additions.push({ memory: n, score: hit.score * 0.5, reasons: [`Episode neighbour of ${id} (${d > 0 ? "+" : ""}${d})`] });
      }
    }
    if (additions.length === 0) return hits;
    const at = seeds[seeds.length - 1]!.index + 1;
    return [...hits.slice(0, at), ...additions, ...hits.slice(at)];
  }

  close(): void {
    this.db.close();
  }

  /** close() plus releasing any loaded models. */
  async closeAsync(): Promise<void> {
    this.close();
    await this.neural.embedder?.dispose?.();
    await this.neural.reranker?.dispose?.();
  }
}
