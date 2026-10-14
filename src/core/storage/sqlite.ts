import { Database } from "bun:sqlite";
import {
  type MemoryNode,
  type MemoryEdge,
  type ScoredMemoryNode,
  type ConsultationRecord,
  type VisibleSet,
  DEFAULT_SOURCE_AUTHORITY,
  canSee,
} from "../types.js";

const STOP_WORDS = new Set([
  "a", "an", "the", "and", "or", "in", "on", "at", "to", "for", "of", "with", "by", "from",
  "is", "are", "was", "were", "be", "been", "will", "would", "should", "could", "can",
  "do", "does", "did", "have", "has", "had", "my", "me", "i", "you", "your", "it", "its",
  "this", "that", "what", "which", "who", "whom", "whose", "if", "so", "as", "about"
]);

export function extractSearchTokens(query: string): string[] {
  const raw = query
    .replace(/[^\w\s]/g, " ")
    .trim()
    .split(/\s+/)
    .map((t) => t.toLowerCase())
    .filter((t) => t.length > 0);

  const meaningful = raw.filter((t) => t.length > 1 && !STOP_WORDS.has(t));
  return meaningful.length > 0 ? meaningful : raw;
}

/**
 * Distinctive terms of a memory for term-node linking: unique lowercase content words of three or
 * more letters that are not stop words, plus runs of capitalised words ("Door Dash") as one term.
 * The leading "Speaker:" prefix of a conversational turn is not a term.
 */
export function extractContentTerms(text: string): string[] {
  const body = text.replace(/^[A-Z][\w' -]{0,30}:\s+/, "");
  const terms = new Set<string>();
  for (const tok of body.replace(/[^\w\s'-]/g, " ").split(/\s+/)) {
    const t = tok.toLowerCase().replace(/^['-]+|['-]+$/g, "");
    if (t.length >= 3 && !STOP_WORDS.has(t) && !/^\d+$/.test(t)) terms.add(t);
  }
  for (const m of body.matchAll(/\b([A-Z][a-z]+(?:\s+[A-Z][a-z]+)+)\b/g)) {
    terms.add(m[1]!.toLowerCase());
  }
  return [...terms];
}

/** Adjacent word pairs of the query, skipping pairs made only of stop words. */
export function extractPhrasePairs(query: string): [string, string][] {
  const raw = query
    .replace(/[^\w\s]/g, " ")
    .trim()
    .split(/\s+/)
    .map((t) => t.toLowerCase())
    .filter((t) => t.length > 0);
  const pairs: [string, string][] = [];
  for (let i = 0; i + 1 < raw.length; i++) {
    const a = raw[i]!;
    const b = raw[i + 1]!;
    if (STOP_WORDS.has(a) && STOP_WORDS.has(b)) continue;
    pairs.push([a, b]);
  }
  return pairs;
}

export interface StorageOptions {
  /**
   * FTS5 tokenizer. "porter" (default) stems both the index and the query (running / runs -> run);
   * "unicode61" matches surface forms only. Fixed when the table is created: a database file built with
   * one tokenizer keeps it.
   */
  tokenizer?: "unicode61" | "porter";
  /**
   * bm25() weight of the label column relative to the content column. Default 1 (what was measured:
   * an earlier call passed its weights positionally to the unindexed id column, so the label was never
   * actually weighted).
   */
  labelWeight?: number;
  /** Prefix-match every query token (`"tok"*`). Default true. */
  prefixMatch?: boolean;
  /** Fuse a substring-count leg computed over every node in JavaScript (O(N) per query). Default true. */
  substringLeg?: boolean;
  /** Fuse a phrase leg: adjacent query word pairs as FTS phrases. Default true. */
  phraseLeg?: boolean;
}

export class SQLiteStorage {
  private db: Database;
  private readonly options: Required<StorageOptions>;
  private nodeCache: MemoryNode[] | null = null;
  /** Ids kept out of the full-text index (graph-only nodes); the substring leg skips them too. */
  private unsearchable: Set<string> | null = null;

  private unsearchableIds(): Set<string> {
    if (!this.unsearchable) {
      const indexed = new Set((this.db.query(`SELECT id FROM nodes_fts`).all() as { id: string }[]).map((r) => r.id));
      const all = (this.db.query(`SELECT id FROM nodes`).all() as { id: string }[]).map((r) => r.id);
      this.unsearchable = new Set(all.filter((id) => !indexed.has(id)));
    }
    return this.unsearchable;
  }

  constructor(dbPath: string = ":memory:", options: StorageOptions = {}) {
    this.options = {
      // Defaults = the configuration confirmed on the LoCoMo test split on 2026-10-14 (NSM-SPEC §4.3).
      tokenizer: options.tokenizer ?? "porter",
      labelWeight: options.labelWeight ?? 1.0,
      prefixMatch: options.prefixMatch ?? true,
      substringLeg: options.substringLeg ?? true,
      phraseLeg: options.phraseLeg ?? true,
    };
    this.db = new Database(dbPath);
    this.initSchema();
  }

  public getOptions(): Readonly<Required<StorageOptions>> {
    return this.options;
  }

  private initSchema() {
    const tokenize = this.options.tokenizer === "porter" ? ", tokenize='porter unicode61'" : "";
    this.db.run(`
      CREATE TABLE IF NOT EXISTS nodes (
        id TEXT PRIMARY KEY,
        node_type TEXT NOT NULL,
        label TEXT NOT NULL,
        source TEXT NOT NULL,
        payload TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE VIRTUAL TABLE IF NOT EXISTS nodes_fts USING fts5(
        id UNINDEXED,
        label,
        content,
        prefix='2,3'${tokenize}
      );

      CREATE TABLE IF NOT EXISTS edges (
        source_id TEXT NOT NULL,
        target_id TEXT NOT NULL,
        relation TEXT NOT NULL,
        weight REAL DEFAULT 1.0,
        last_activated INTEGER NOT NULL,
        PRIMARY KEY (source_id, target_id, relation),
        FOREIGN KEY (source_id) REFERENCES nodes(id) ON DELETE CASCADE,
        FOREIGN KEY (target_id) REFERENCES nodes(id) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS idx_edges_source ON edges(source_id);
      CREATE INDEX IF NOT EXISTS idx_edges_target ON edges(target_id);

      CREATE TABLE IF NOT EXISTS node_vectors (
        id TEXT PRIMARY KEY,
        model TEXT NOT NULL,
        dims INTEGER NOT NULL,
        vec BLOB NOT NULL
      );

      CREATE TABLE IF NOT EXISTS query_audit_logs (
        id TEXT PRIMARY KEY,
        query TEXT NOT NULL,
        salient_nodes TEXT NOT NULL,
        ambient_summary TEXT,
        recalled_summary TEXT,
        metadata TEXT,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_audit_created_at ON query_audit_logs(created_at DESC);
    `);
  }

  /**
   * @param searchable false keeps the node out of the full-text index (reachable through the graph only).
   */
  public upsertNode(node: MemoryNode, contentForFts?: string, searchable: boolean = true) {
    this.nodeCache = null;
    const payloadToSave = { ...node.payload };
    if (node.authority !== undefined) payloadToSave._authority = node.authority;
    if (node.entityCategory !== undefined) payloadToSave._entityCategory = node.entityCategory;
    if (node.scope !== undefined) payloadToSave._scope = node.scope;
    if (node.gate !== undefined) payloadToSave._gate = node.gate;
    const payloadJson = JSON.stringify(payloadToSave);
    const searchContent = contentForFts ?? `${node.label} ${payloadJson}`;

    // Upsert into main table
    this.db.run(
      `INSERT INTO nodes (id, node_type, label, source, payload, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         node_type = excluded.node_type,
         label = excluded.label,
         source = excluded.source,
         payload = excluded.payload,
         updated_at = excluded.updated_at`,
      [
        node.id,
        node.nodeType,
        node.label,
        node.source,
        payloadJson,
        node.createdAt,
        node.updatedAt,
      ]
    );

    // Update FTS index
    this.db.run(`DELETE FROM nodes_fts WHERE id = ?`, [node.id]);
    if (searchable) {
      this.db.run(
        `INSERT INTO nodes_fts (id, label, content) VALUES (?, ?, ?)`,
        [node.id, node.label, searchContent]
      );
      this.unsearchable?.delete(node.id);
    } else {
      this.unsearchableIds().add(node.id);
    }
  }

  /**
   * Merge fields into a node's payload without touching the full-text index (for lifecycle fields such
   * as strength and last recall, which change on every recall). The cached node object is updated in
   * place so callers holding it see the change.
   */
  public updatePayload(id: string, patch: Record<string, unknown>, updatedAt: number = Date.now()): boolean {
    const node = this.getNodeById(id);
    if (!node) return false;
    const payload = { ...node.payload, ...patch };
    this.db.run(`UPDATE nodes SET payload = ?, updated_at = ? WHERE id = ?`, [JSON.stringify(payload), updatedAt, id]);
    const cached = this.nodeCache?.find((n) => n.id === id);
    if (cached) {
      cached.payload = payload;
      cached.updatedAt = updatedAt;
    }
    return true;
  }

  public deleteNode(id: string) {
    this.nodeCache = null;
    this.vectorCache?.delete(id);
    this.unsearchable?.delete(id);
    this.db.run(`DELETE FROM nodes WHERE id = ?`, [id]);
    this.db.run(`DELETE FROM nodes_fts WHERE id = ?`, [id]);
    this.db.run(`DELETE FROM edges WHERE source_id = ? OR target_id = ?`, [id, id]);
    this.db.run(`DELETE FROM node_vectors WHERE id = ?`, [id]);
  }

  // ---- Dense vectors (optional neural leg) ----

  private vectorCache: Map<string, Float32Array> | null = null;

  public upsertVector(id: string, model: string, vec: Float32Array) {
    this.db.run(
      `INSERT INTO node_vectors (id, model, dims, vec) VALUES (?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET model = excluded.model, dims = excluded.dims, vec = excluded.vec`,
      [id, model, vec.length, Buffer.from(vec.buffer, vec.byteOffset, vec.byteLength)]
    );
    if (this.vectorCache) this.vectorCache.set(id, vec);
  }

  public getAllVectors(): Map<string, Float32Array> {
    if (this.vectorCache) return this.vectorCache;
    const rows = this.db.query(`SELECT id, dims, vec FROM node_vectors`).all() as { id: string; dims: number; vec: Uint8Array }[];
    const m = new Map<string, Float32Array>();
    for (const r of rows) {
      const buf = Buffer.from(r.vec);
      m.set(r.id, new Float32Array(buf.buffer, buf.byteOffset, r.dims));
    }
    this.vectorCache = m;
    return m;
  }

  /** Ids of memory nodes (fact/note/event/profile) that have no vector yet. */
  public getUnembeddedIds(): string[] {
    const rows = this.db
      .query(`SELECT n.id FROM nodes n LEFT JOIN node_vectors v ON v.id = n.id
              WHERE v.id IS NULL AND n.node_type IN ('fact','note','event','profile','custom')`)
      .all() as { id: string }[];
    return rows.map((r) => r.id);
  }

  /**
   * Brute-force cosine over the stored vectors (unit length assumed). Visibility applied inside.
   * Vectors at or below `minSimilarity` (default 0: no shared direction at all) are not hits.
   */
  public searchDense(queryVec: Float32Array, limit: number, asker?: VisibleSet, minSimilarity: number = 0): { id: string; similarity: number }[] {
    const hits: { id: string; similarity: number }[] = [];
    for (const [id, vec] of this.getAllVectors()) {
      if (vec.length !== queryVec.length) continue;
      let s = 0;
      for (let i = 0; i < vec.length; i++) s += vec[i]! * queryVec[i]!;
      if (s <= minSimilarity) continue;
      hits.push({ id, similarity: s });
    }
    hits.sort((a, b) => b.similarity - a.similarity);
    if (!asker) return hits.slice(0, limit);
    const out: { id: string; similarity: number }[] = [];
    for (const h of hits) {
      const node = this.getNodeById(h.id);
      if (node && canSee(asker, node.gate, node.scope || node.payload.scope)) out.push(h);
      if (out.length >= limit) break;
    }
    return out;
  }

  public upsertEdge(edge: MemoryEdge) {
    this.db.run(
      `INSERT INTO edges (source_id, target_id, relation, weight, last_activated)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(source_id, target_id, relation) DO UPDATE SET
         weight = excluded.weight,
         last_activated = excluded.last_activated`,
      [edge.sourceId, edge.targetId, edge.relation, edge.weight, edge.lastActivated]
    );
  }

  public deleteEdge(sourceId: string, targetId: string, relation: string) {
    this.db.run(
      `DELETE FROM edges WHERE source_id = ? AND target_id = ? AND relation = ?`,
      [sourceId, targetId, relation]
    );
  }

  private rowToNode(row: any): MemoryNode {
    const payload = JSON.parse(row.payload);
    return {
      id: row.id,
      nodeType: row.node_type,
      label: row.label,
      source: row.source,
      payload,
      authority: payload._authority ?? (DEFAULT_SOURCE_AUTHORITY[row.source] ?? 1.0),
      entityCategory: payload._entityCategory,
      scope: payload._scope ?? payload.scope,
      gate: payload._gate ?? payload.gate,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  public getNodeById(id: string): MemoryNode | undefined {
    const row = this.db.query(`SELECT * FROM nodes WHERE id = ?`).get(id) as any;
    if (!row) return undefined;
    return this.rowToNode(row);
  }

  /**
   * Every node, parsed once and cached until the next write. Callers must not mutate the array.
   */
  public getAllNodes(): MemoryNode[] {
    if (this.nodeCache) return this.nodeCache;
    const rows = this.db.query(`SELECT * FROM nodes`).all() as any[];
    this.nodeCache = rows.map((r) => this.rowToNode(r));
    return this.nodeCache;
  }

  public getAllEdges(): MemoryEdge[] {
    const rows = this.db.query(`SELECT * FROM edges`).all() as any[];
    return rows.map((r) => ({
      sourceId: r.source_id,
      targetId: r.target_id,
      relation: r.relation,
      weight: r.weight,
      lastActivated: r.last_activated,
    }));
  }

  private runFts(ftsQuery: string, limit: number): { id: string; bm25Score: number }[] {
    try {
      const rows = this.db
        .query(
          `SELECT id, bm25(nodes_fts, 0.0, ${this.options.labelWeight}, 1.0) AS rank
           FROM nodes_fts
           WHERE nodes_fts MATCH ?
           ORDER BY rank ASC
           LIMIT ?`
        )
        .all(ftsQuery, limit) as { id: string; rank: number }[];

      // In SQLite FTS5 bm25(), lower/negative scores mean higher relevance. Convert to positive rank score.
      return rows.map((r) => ({
        id: r.id,
        bm25Score: Math.abs(r.rank),
      }));
    } catch {
      return [];
    }
  }

  public searchBM25(query: string, limit: number = 20): { id: string; bm25Score: number }[] {
    const cleanTokens = extractSearchTokens(query);
    if (cleanTokens.length === 0) return [];
    const star = this.options.prefixMatch ? "*" : "";
    const ftsQuery = cleanTokens.map((t) => `"${t}"${star}`).join(" OR ");
    return this.runFts(ftsQuery, limit);
  }

  /** Phrase leg: each adjacent query word pair as an FTS phrase, ranked by bm25. */
  public searchPhrases(query: string, limit: number = 20): { id: string; bm25Score: number }[] {
    const pairs = extractPhrasePairs(query);
    if (pairs.length === 0) return [];
    const ftsQuery = pairs.map(([a, b]) => `"${a} ${b}"`).join(" OR ");
    return this.runFts(ftsQuery, limit);
  }

  public searchSubstrings(tokens: string[], limit: number = 20): { id: string; count: number }[] {
    if (tokens.length === 0) return [];

    const matches = new Map<string, number>();
    const allNodes = this.getAllNodes();
    const skip = this.unsearchableIds();

    for (const node of allNodes) {
      if (skip.has(node.id)) continue;
      const p = node.payload || {};
      const text = `${node.label} ${p.summary || ""} ${p.fullText || ""} ${p.text || ""}`.toLowerCase();
      let matchCount = 0;
      for (const token of tokens) {
        const t = token.toLowerCase();
        if (text.includes(t)) {
          matchCount += 1;
        }
        if (p.project && p.project.toLowerCase() === t) {
          matchCount += 3;
        }
        if (node.nodeType === "invariant" && text.includes(t)) {
          matchCount += 2;
        }
      }
      if (matchCount > 0) {
        matches.set(node.id, matchCount);
      }
    }

    return Array.from(matches.entries())
      .map(([id, count]) => ({ id, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, limit);
  }

  /**
   * Reciprocal Rank Fusion (RRF) of the BM25 leg with the optional substring and phrase legs.
   * Invariant I1: The visibility filter goes inside every retrieval, never after it.
   */
  public searchHybridRRF(
    query: string,
    limit: number = 10,
    k: number = 60,
    asker?: VisibleSet,
    /** Extra ranked lists to fuse (e.g. a dense leg), best first. */
    extraLegs: { name: string; ids: string[] }[] = []
  ): ScoredMemoryNode[] {
    const tokens = extractSearchTokens(query);
    const bm25Results = this.searchBM25(query, limit * 2);
    const substringResults = this.options.substringLeg ? this.searchSubstrings(tokens, limit * 2) : [];
    const phraseResults = this.options.phraseLeg ? this.searchPhrases(query, limit * 2) : [];

    const rrfScores = new Map<string, { score: number; reasons: string[] }>();

    // 0. Extra legs (dense etc.)
    for (const leg of extraLegs) {
      leg.ids.forEach((id, rank) => {
        const rrf = 1 / (k + rank + 1);
        const existing = rrfScores.get(id) ?? { score: 0, reasons: [] };
        existing.score += rrf;
        existing.reasons.push(`${leg.name} (rank ${rank + 1})`);
        rrfScores.set(id, existing);
      });
    }

    // 1. Score BM25 rank
    bm25Results.forEach((res, rank) => {
      const rrf = 1 / (k + rank + 1);
      const existing = rrfScores.get(res.id) ?? { score: 0, reasons: [] };
      existing.score += rrf;
      existing.reasons.push(`BM25 (rank ${rank + 1})`);
      rrfScores.set(res.id, existing);
    });

    // 2. Score Substring rank with match count weighting
    substringResults.forEach((res, rank) => {
      const matchMultiplier = 1 + res.count * 0.75;
      const rrf = (1 / (k + rank + 1)) * matchMultiplier;
      const existing = rrfScores.get(res.id) ?? { score: 0, reasons: [] };
      existing.score += rrf;
      existing.reasons.push(`Keyword match (${res.count} hits)`);
      rrfScores.set(res.id, existing);
    });

    // 3. Score phrase rank
    phraseResults.forEach((res, rank) => {
      const rrf = 1 / (k + rank + 1);
      const existing = rrfScores.get(res.id) ?? { score: 0, reasons: [] };
      existing.score += rrf;
      existing.reasons.push(`Phrase (rank ${rank + 1})`);
      rrfScores.set(res.id, existing);
    });

    // Resolve node objects
    const scoredNodes: ScoredMemoryNode[] = [];
    for (const [id, meta] of rrfScores.entries()) {
      const node = this.getNodeById(id);
      if (node) {
        // Enforce Invariant I1: In-retrieval access gate filtering
        if (asker && !canSee(asker, node.gate, node.scope || node.payload.scope)) {
          continue;
        }

        const authority = node.authority ?? (DEFAULT_SOURCE_AUTHORITY[node.source] ?? 1.0);
        // Scale score by epistemic authority
        const finalScore = meta.score * (0.5 + 0.5 * authority);
        scoredNodes.push({
          node,
          score: finalScore,
          matchReasons: meta.reasons,
        });
      }
    }

    return scoredNodes.sort((a, b) => b.score - a.score).slice(0, limit);
  }

  public recordAuditLog(record: ConsultationRecord) {
    this.db.run(
      `INSERT INTO query_audit_logs (id, query, salient_nodes, ambient_summary, recalled_summary, metadata, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        record.id,
        record.query,
        JSON.stringify(record.salientNodes),
        record.ambientSummary ?? null,
        record.recalledSummary ?? null,
        record.metadata ? JSON.stringify(record.metadata) : null,
        record.createdAt,
      ]
    );
  }

  public getRecentAuditLogs(limit: number = 50): ConsultationRecord[] {
    const rows = this.db
      .query(`SELECT * FROM query_audit_logs ORDER BY created_at DESC LIMIT ?`)
      .all(limit) as any[];

    return rows.map((r) => ({
      id: r.id,
      query: r.query,
      salientNodes: JSON.parse(r.salient_nodes || "[]"),
      ambientSummary: r.ambient_summary,
      recalledSummary: r.recalled_summary,
      metadata: r.metadata ? JSON.parse(r.metadata) : undefined,
      createdAt: r.created_at,
    }));
  }

  public close() {
    this.db.close();
  }
}
