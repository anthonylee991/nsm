import { Retriever } from "../retrieval.js";
import type { MemoryRecord } from "../db.js";
import type { NeuralConfig } from "../neural/types.js";
import { LocalEmbedder, LocalReranker } from "../neural/local.js";
import { dbPath, loadConfig, modelDir, type NsmConfig } from "./paths.js";
import { projectKey, projectName } from "./project.js";
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
  rankScore,
  spreadBoost,
  type ForgettingParams,
  type Importance,
} from "../lifecycle/strength.js";
import { ABSENCE_SEEDS, absenceFlags, cachedLexicalSimilarity, wordSet, type AbsenceFlag, type DatedMemory, type Similarity } from "../lifecycle/absence.js";

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
  /** The project's folder name, or "global". */
  project: string;
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
  /** The project recall was scoped to (folder name), or null when none was known. */
  project: string | null;
}

/** Where the caller is working: decides the project of new memories and which pinned rules apply. */
export interface Where {
  /** The agent's working folder (absolute path). Default: the store's `folder`. */
  folder?: string;
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
   * Run the forgetting sweep from `recall` once a day (default false; the CLI and MCP server turn it on), so
   * faded short-term memories move to long-term without anyone running `nsm sweep`.
   */
  autoSweep?: boolean;
  /**
   * Family similarity floors for absence flags: lexical Jaccard (default 0.15, chosen on the dev split
   * of the absence test and confirmed on test) or cosine when the store has vectors (default 0.6).
   */
  absenceSimilarity?: { cosine?: number; lexical?: number };
  /**
   * How absence-flag families are found. "lexical" (default) uses word overlap; "cosine" uses stored
   * vectors when every recalled memory has one (measured worse at every floor; off by default).
   */
  absenceFamilies?: "lexical" | "cosine";
  /** Working folder used when a call does not give one (the CLI and MCP server pass their own cwd). */
  folder?: string;
  /**
   * With the reranker: memories it scores below this logit are left out of recall, so an unrelated memory
   * is not returned just because there are few. Null turns it off. Default: DEFAULT_RERANK_FLOOR.
   */
  rerankFloor?: number | null;
  /** Bring your own models instead of the configured local ones (sets `neural` on). */
  models?: NeuralConfig;
}

/** Relevance multiplier for memories that belong to a different project than the caller's. */
export const OTHER_PROJECT_WEIGHT = 0.5;
/**
 * Cross-encoder logit below which recall leaves a memory out. The strictest floor that dropped no evidence on
 * LoCoMo dev (655 questions); on test it dropped 1 evidence turn of 1,039 (NSM-SPEC §4.6). Unrelated memories in
 * a mixed store score about -11 to -12.
 */
export const DEFAULT_RERANK_FLOOR: number | null = -11;

const DAY = 86_400_000;
const HOUR = 3_600_000;

/**
 * The product: one SQLite file under ~/.nsm, optional local models, and the memory lifecycle.
 *
 *   short-term  `active` memories: full text, every leg, strength decaying over ~90 days, refreshed when recalled
 *   long-term   `archived` memories: faded and unrecalled for 90 days; kept whole (measured: deleting or
 *               summarising them costs accuracy), out of `activeOnly` recall and lists, still reached by a
 *               direct cue, and moved back to short-term when recalled
 *   pinned      rules delivered on every recall, never decaying
 *
 * Verbs: remember, recall, forget, list, sweep. Used by the CLI and the MCP server.
 */
export class MemoryStore {
  readonly config: NsmConfig;
  readonly neural: boolean;
  private readonly retriever: Retriever;
  private readonly now: () => number;
  private readonly forgetting: ForgettingParams;
  private readonly reinforce: boolean;
  private readonly spread: boolean;
  private readonly autoSweep: boolean;
  private readonly absenceSimilarity: { cosine: number; lexical: number };
  private readonly absenceFamilies: "lexical" | "cosine";
  /** Word sets for absence-flag families, by memory id (text never changes, so they never go stale). */
  private readonly wordSets = new Map<string, Set<string>>();
  /** word -> ids of memories containing it, for the same families (stale ids are filtered on use). */
  private readonly postings = new Map<string, Set<string>>();
  private readonly indexed = new Set<string>();
  private readonly folder: string | undefined;
  private readonly rerankFloor: number | null;

  constructor(options: StoreOptions = {}) {
    this.config = options.config ?? loadConfig();
    this.neural = options.models ? true : (options.neural ?? this.config.neural);
    this.now = options.now ?? (() => Date.now());
    this.forgetting = options.forgetting ?? DEFAULT_FORGETTING;
    this.reinforce = options.reinforce ?? true;
    this.spread = options.spread ?? true;
    this.autoSweep = options.autoSweep ?? false;
    this.absenceSimilarity = { cosine: options.absenceSimilarity?.cosine ?? 0.6, lexical: options.absenceSimilarity?.lexical ?? 0.15 };
    this.absenceFamilies = options.absenceFamilies ?? "lexical";
    this.folder = options.folder;
    this.rerankFloor = options.rerankFloor === undefined ? DEFAULT_RERANK_FLOOR : options.rerankFloor;
    const neural: NeuralConfig = options.models ?? {};
    if (this.neural && !options.models) {
      const dir = modelDir();
      neural.embedder = new LocalEmbedder(this.config.embedModel, { modelDir: dir });
      neural.reranker = new LocalReranker(this.config.rerankModel, { modelDir: dir });
    }
    this.retriever = new Retriever({ dbPath: options.dbPath ?? dbPath(), neural });
  }

  private get db() {
    return this.retriever.db;
  }

  /** Current strength: the stored value decayed to now. */
  private strengthOf(m: MemoryRecord, now: number): number {
    return decayedStrength(m.strength, now - m.strengthAt, m.boosts, m.importance);
  }

  private toMemory(m: MemoryRecord, now: number = this.now()): Memory {
    return {
      id: m.id,
      text: m.text,
      pinned: m.pinned,
      source: m.source,
      createdAt: new Date(m.createdAt).toISOString(),
      occurredAt: new Date(m.occurredAt).toISOString(),
      strength: this.strengthOf(m, now),
      state: m.state,
      project: projectName(m.project),
    };
  }

  private projectOf(where: Where = {}): string | null {
    return projectKey(where.folder ?? this.folder);
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
      /**
       * "project" (default when a project is known): belongs to the project of `folder`. "global": applies
       * everywhere. For pinned rules this decides where they are delivered.
       */
      scope?: "project" | "global";
    } & Where = {},
  ): Promise<{ id: string; duplicate: boolean; project: string }> {
    const clean = text.trim();
    if (!clean) throw new Error("empty memory");
    if (!options.allowDuplicate) {
      const existing = this.db.findByText(clean);
      if (existing) return { id: existing.id, duplicate: true, project: projectName(existing.project) };
    }
    const project = options.scope === "global" ? null : this.projectOf(options);
    const pinned = options.pinned === true;
    const createdAt = options.createdAt ?? this.now();
    const occurredAt = options.occurredAt ?? createdAt;
    // Episode = the hour the memory belongs to; ordinal = its place in that hour. Lets recall add the
    // memories saved around a hit to the reranker's pool.
    const episode = Math.floor(occurredAt / HOUR);
    const memory = this.retriever.add(clean, {
      id: options.id,
      pinned,
      source: options.source ?? (pinned ? "user_invariant" : "user_fact"),
      importance: options.importance,
      createdAt,
      occurredAt,
      episode,
      ordinal: this.db.episodeSize(episode),
      project,
    });
    if (this.neural) await this.retriever.embedPending();
    return { id: memory.id, duplicate: false, project: projectName(project) };
  }

  /**
   * Pinned rules (global ones and the current project's), then the k best memories. Candidates come from
   * retrieval; strength then decides among them (a strong cue reactivates a faded memory, so long-term
   * memories still answer direct questions). Memories from other projects stay searchable at half weight;
   * with the reranker, ones it scores below the floor are left out. `activeOnly` leaves long-term
   * (archived) memories out.
   */
  async recall(query: string, k?: number, options: { activeOnly?: boolean; flags?: boolean } & Where = {}): Promise<RecallResult> {
    const start = performance.now();
    if (this.autoSweep) this.sweepIfDue();
    const now = this.now();
    const limit = k ?? this.config.k;
    // Without models, rank a pool of 3k (at least 20); with them, the reranker's pool (library default 100).
    const result = await this.retriever.search(query, { limit: this.neural ? undefined : Math.max(limit * 3, 20) });

    const current = this.projectOf(options);
    const applies = (m: MemoryRecord) => m.project === null || m.project === current;
    const pinned = this.db.all().filter((m) => m.pinned && applies(m)).map((m) => this.toMemory(m, now));
    const top = Math.max(...result.hits.map((h) => h.score), 1e-9);
    // Relevance in 0..1: cross-encoder logits through a sigmoid, otherwise share of the top fused score.
    const relevanceOf = (score: number) => (result.reranked ? 1 / (1 + Math.exp(-score)) : Math.max(0, score) / top);
    const floor = result.reranked ? this.rerankFloor : null;

    const ranked = result.hits
      .filter((h) => !(options.activeOnly && h.memory.state === "archived"))
      .filter((h) => floor === null || h.score >= floor)
      .map((h) => {
        const relevance = relevanceOf(h.score) * (current !== null && !applies(h.memory) ? OTHER_PROJECT_WEIGHT : 1);
        return { ...h, final: rankScore(relevance, this.strengthOf(h.memory, now)) };
      })
      .sort((a, b) => b.final - a.final)
      .slice(0, limit);

    const memories: RecallItem[] = ranked.map((h) => ({ ...this.toMemory(h.memory, now), score: h.final, reasons: h.reasons }));
    const recalled = ranked.map((h) => h.memory);
    if (this.reinforce) this.reinforceRecall(recalled, now);
    const flags = options.flags === false ? [] : this.absenceFlagsFor(recalled, now);

    return {
      pinned,
      memories,
      flags,
      prompt: formatPrompt(pinned, memories, flags),
      latencyMs: performance.now() - start,
      neural: this.neural,
      project: current === null ? null : projectName(current),
    };
  }

  /** Reinforce what was recalled, and spread a smaller reinforcement to each seed's associates. */
  private reinforceRecall(recalled: MemoryRecord[], now: number): void {
    if (recalled.length === 0) return;
    this.db.transaction(() => {
      const recalledIds = new Set(recalled.map((m) => m.id));
      for (const m of recalled) {
        this.db.update(m.id, {
          strength: boostOnAccess(this.strengthOf(m, now), m.importance, 1),
          strengthAt: now,
          boosts: m.boosts + 1,
          lastRecalledAt: now,
          state: "active", // a recalled memory returns to short-term, archived or not
        });
      }
      if (!this.spread) return;
      const others = this.db.all().filter((m) => !m.pinned && !recalledIds.has(m.id));
      const vectors = this.db.vectors();
      const boosts = new Map<string, number>();
      const bump = (id: string, b: number) => boosts.set(id, Math.max(boosts.get(id) ?? 0, b));
      const window = SPREAD_EPISODE_WINDOW_MINUTES * 60_000;
      for (const seed of recalled.slice(0, SPREAD_SEEDS)) {
        const sv = vectors.get(seed.id);
        if (sv) {
          const sims: { id: string; s: number }[] = [];
          for (const m of others) {
            const v = vectors.get(m.id);
            if (!v || v.length !== sv.length) continue;
            let s = 0;
            for (let i = 0; i < sv.length; i++) s += sv[i]! * v[i]!;
            if (s >= SPREAD_MIN_SIMILARITY) sims.push({ id: m.id, s });
          }
          sims.sort((a, b) => b.s - a.s).slice(0, SPREAD_NEIGHBOURS_PER_SEED).forEach((x) => bump(x.id, spreadBoost(1)));
        }
        for (const m of others) {
          if (Math.abs(m.occurredAt - seed.occurredAt) <= window) bump(m.id, spreadBoost(SPREAD_EPISODE_WEIGHT));
        }
      }
      for (const [id, boost] of boosts) {
        const m = this.db.get(id);
        if (m) this.db.update(id, { strength: Math.min(1, this.strengthOf(m, now) + boost), strengthAt: now });
      }
    });
  }

  private absenceFlagsFor(recalled: MemoryRecord[], now: number): AbsenceFlag[] {
    if (recalled.length === 0) return [];
    let all: DatedMemory[] = this.db.all().filter((m) => !m.pinned);
    let similarity: Similarity = cachedLexicalSimilarity(this.wordSets);
    let floor = this.absenceSimilarity.lexical;
    // A family member needs Jaccard >= floor > 0, so at least one word in common with its seed: compare the
    // seeds only with memories that share a word with one of them (same flags, far fewer comparisons).
    if (floor > 0) {
      all = this.sharingAWord(recalled.slice(0, ABSENCE_SEEDS), all);
      similarity = this.postingsJaccard();
    }
    if (this.absenceFamilies === "cosine") {
      const vectors = this.db.vectors();
      if (vectors.size > 0 && recalled.every((m) => vectors.has(m.id))) {
        const lexical = similarity;
        similarity = (a, b) => {
          const va = vectors.get(a.id);
          const vb = vectors.get(b.id);
          if (!va || !vb || va.length !== vb.length) return lexical(a, b);
          let s = 0;
          for (let i = 0; i < va.length; i++) s += va[i]! * vb[i]!;
          return s;
        };
        floor = this.absenceSimilarity.cosine;
      }
    }
    return absenceFlags(recalled, all, now, similarity, floor);
  }

  private wordsOf(m: DatedMemory): Set<string> {
    let w = this.wordSets.get(m.id);
    if (!w) this.wordSets.set(m.id, (w = wordSet(m.text)));
    return w;
  }

  /**
   * Jaccard from the postings: the words a seed shares with each memory are counted once per seed, so each
   * comparison is a lookup. Same value as `lexicalSimilarity` (selectFamily always passes the seed first).
   */
  private postingsJaccard(): Similarity {
    const shared = new Map<string, Map<string, number>>();
    return (seed, other) => {
      let counts = shared.get(seed.id);
      if (!counts) {
        counts = new Map();
        for (const w of this.wordsOf(seed)) for (const id of this.postings.get(w) ?? []) counts.set(id, (counts.get(id) ?? 0) + 1);
        shared.set(seed.id, counts);
      }
      const n = counts.get(other.id) ?? 0;
      return n === 0 ? 0 : n / (this.wordsOf(seed).size + this.wordsOf(other).size - n);
    };
  }

  private sharingAWord(seeds: DatedMemory[], all: DatedMemory[]): DatedMemory[] {
    for (const m of all) {
      if (this.indexed.has(m.id)) continue;
      this.indexed.add(m.id);
      for (const w of this.wordsOf(m)) {
        let ids = this.postings.get(w);
        if (!ids) this.postings.set(w, (ids = new Set()));
        ids.add(m.id);
      }
    }
    const near = new Set<string>();
    for (const seed of seeds) for (const w of this.wordsOf(seed)) for (const id of this.postings.get(w) ?? []) near.add(id);
    return all.filter((m) => near.has(m.id));
  }

  forget(id: string): boolean {
    this.wordSets.delete(id);
    return this.db.delete(id);
  }

  /** Move a memory to the project of `folder`, or make it global (folder null). */
  rescope(id: string, folder: string | null): { ok: boolean; project: string } {
    const m = this.db.get(id);
    if (!m) return { ok: false, project: "" };
    const project = folder === null ? null : projectKey(folder);
    this.db.update(id, { project });
    return { ok: true, project: projectName(project) };
  }

  list(options: { pinned?: boolean; limit?: number; includeArchived?: boolean } = {}): Memory[] {
    const now = this.now();
    const all = this.db.all()
      .filter((m) => options.pinned === undefined || m.pinned === options.pinned)
      .filter((m) => options.includeArchived || m.state !== "archived")
      .map((m, seq) => ({ m, seq }))
      .sort((a, b) => b.m.createdAt - a.m.createdAt || b.seq - a.seq)
      .map(({ m }) => this.toMemory(m, now));
    return options.limit ? all.slice(0, options.limit) : all;
  }

  /**
   * Apply the forgetting policy: faded, idle short-term memories move to long-term (`archived`), or are
   * deleted when `forgetting.mode` is "delete". Decay itself is computed on read.
   */
  sweep(): { demoted: number; deleted: number; kept: number } {
    const now = this.now();
    let demoted = 0, deleted = 0, kept = 0;
    this.db.transaction(() => {
      for (const m of [...this.db.all()]) {
        const action = forgettingAction(
          { strength: this.strengthOf(m, now), importance: m.importance, lastRecalledAt: m.lastRecalledAt, createdAt: m.createdAt, state: m.state },
          now,
          this.forgetting,
        );
        if (action === "demote") {
          this.db.update(m.id, { state: "archived", archivedAt: now });
          demoted++;
        } else if (action === "delete") {
          this.wordSets.delete(m.id);
          this.db.delete(m.id);
          deleted++;
        } else kept++;
      }
      this.db.setMeta("last_sweep_at", String(now));
    });
    return { demoted, deleted, kept };
  }

  /** Sweep if the last sweep was a day or more ago. Returns the sweep's result, or null when not due. */
  sweepIfDue(): { demoted: number; deleted: number; kept: number } | null {
    const last = Number(this.db.getMeta("last_sweep_at") ?? 0);
    return this.now() - last >= DAY ? this.sweep() : null;
  }

  stats(): { memories: number; archived: number; pinned: number; vectors: number; neural: boolean; db: string } {
    const all = this.db.all();
    return {
      memories: all.filter((m) => !m.pinned && m.state !== "archived").length,
      archived: all.filter((m) => m.state === "archived").length,
      pinned: all.filter((m) => m.pinned).length,
      vectors: this.db.vectors().size,
      neural: this.neural,
      db: this.db.path,
    };
  }

  /** Embed every memory that has no vector yet (after `nsm models install`, or after a bulk import). */
  async embedAll(): Promise<number> {
    return this.retriever.embedPending();
  }

  async close(): Promise<void> {
    await this.retriever.closeAsync();
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
      "[MEMORIES]\n" + memories.map((m) => `• (${m.occurredAt.slice(0, 10)}) ${m.text}  [id: ${m.id}]`).join("\n"),
    );
  }
  if (sections.length === 0) return "(no memories match)";
  return sections.join("\n\n");
}
