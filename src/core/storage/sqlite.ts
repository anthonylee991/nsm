import { Database } from "bun:sqlite";
import {
  type MemoryNode,
  type MemoryEdge,
  type ScoredMemoryNode,
  type ConsultationRecord,
  DEFAULT_SOURCE_AUTHORITY,
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

export class SQLiteStorage {
  private db: Database;

  constructor(dbPath: string = ":memory:") {
    this.db = new Database(dbPath);
    this.initSchema();
  }

  private initSchema() {
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
        prefix='2,3'
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

  public upsertNode(node: MemoryNode, contentForFts?: string) {
    const payloadToSave = { ...node.payload };
    if (node.authority !== undefined) payloadToSave._authority = node.authority;
    if (node.entityCategory !== undefined) payloadToSave._entityCategory = node.entityCategory;
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
    this.db.run(
      `INSERT INTO nodes_fts (id, label, content) VALUES (?, ?, ?)`,
      [node.id, node.label, searchContent]
    );
  }

  public deleteNode(id: string) {
    this.db.run(`DELETE FROM nodes WHERE id = ?`, [id]);
    this.db.run(`DELETE FROM nodes_fts WHERE id = ?`, [id]);
    this.db.run(`DELETE FROM edges WHERE source_id = ? OR target_id = ?`, [id, id]);
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

  public getNodeById(id: string): MemoryNode | undefined {
    const row = this.db.query(`SELECT * FROM nodes WHERE id = ?`).get(id) as any;
    if (!row) return undefined;
    const payload = JSON.parse(row.payload);
    return {
      id: row.id,
      nodeType: row.node_type,
      label: row.label,
      source: row.source,
      payload,
      authority: payload._authority ?? (DEFAULT_SOURCE_AUTHORITY[row.source] ?? 1.0),
      entityCategory: payload._entityCategory,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  public getAllNodes(): MemoryNode[] {
    const rows = this.db.query(`SELECT * FROM nodes`).all() as any[];
    return rows.map((r) => {
      const payload = JSON.parse(r.payload);
      return {
        id: r.id,
        nodeType: r.node_type,
        label: r.label,
        source: r.source,
        payload,
        authority: payload._authority ?? (DEFAULT_SOURCE_AUTHORITY[r.source] ?? 1.0),
        entityCategory: payload._entityCategory,
        createdAt: r.created_at,
        updatedAt: r.updated_at,
      };
    });
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

  public searchBM25(query: string, limit: number = 20): { id: string; bm25Score: number }[] {
    const cleanTokens = extractSearchTokens(query);
    if (cleanTokens.length === 0) return [];

    const ftsQuery = cleanTokens.map((t) => `"${t}"*`).join(" OR ");

    try {
      const rows = this.db
        .query(
          `SELECT id, bm25(nodes_fts, 5.0, 1.0) AS rank
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

  public searchSubstrings(tokens: string[], limit: number = 20): { id: string; count: number }[] {
    if (tokens.length === 0) return [];

    const matches = new Map<string, number>();
    const allNodes = this.getAllNodes();

    for (const node of allNodes) {
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
   * Reciprocal Rank Fusion (RRF) combining BM25 and substring/keyword matches
   */
  public searchHybridRRF(query: string, limit: number = 10, k: number = 60): ScoredMemoryNode[] {
    const tokens = extractSearchTokens(query);
    const bm25Results = this.searchBM25(query, limit * 2);
    const substringResults = this.searchSubstrings(tokens, limit * 2);

    const rrfScores = new Map<string, { score: number; reasons: string[] }>();

    // 1. Score BM25 rank
    bm25Results.forEach((res, rank) => {
      const rrf = 1 / (k + rank + 1);
      const existing = rrfScores.get(res.id) ?? { score: 0, reasons: [] };
      existing.score += rrf;
      existing.reasons.push(`BM25 (rank ${rank + 1})`);
      rrfScores.set(res.id, existing);
    });

    // 2. Score Substring rank
    substringResults.forEach((res, rank) => {
      const rrf = 1 / (k + rank + 1);
      const existing = rrfScores.get(res.id) ?? { score: 0, reasons: [] };
      existing.score += rrf;
      existing.reasons.push(`Keyword match (${res.count} hits)`);
      rrfScores.set(res.id, existing);
    });

    // Resolve node objects
    const scoredNodes: ScoredMemoryNode[] = [];
    for (const [id, meta] of rrfScores.entries()) {
      const node = this.getNodeById(id);
      if (node) {
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
