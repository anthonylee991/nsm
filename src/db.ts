import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { initialStrength, type Importance } from "./lifecycle/strength.js";

/**
 * One SQLite file: the memories (text plus lifecycle columns), an FTS5 index over their text (external
 * content, so the text is stored once), optional vectors, and a small key/value table.
 *
 * Several processes can share the file (one MCP server per agent session): WAL mode, a busy timeout, and
 * in-RAM caches that are dropped when another connection commits (`PRAGMA data_version`).
 */
export interface MemoryRecord {
  id: string;
  text: string;
  /** A rule delivered on every recall; never ranked, never decays. */
  pinned: boolean;
  source: string;
  createdAt: number;
  /** When the remembered thing happened (epoch ms). */
  occurredAt: number;
  /** Episode (the product uses the hour it occurred in) and its place in it, for neighbour expansion. */
  episode: number | null;
  ordinal: number | null;
  importance: Importance;
  /** Stored strength as of `strengthAt`; decay is applied on read (src/lifecycle/strength.ts). */
  strength: number;
  strengthAt: number;
  boosts: number;
  lastRecalledAt: number | null;
  /** active = short-term (competes on any cue); archived = long-term (faded, still reachable by a direct cue). */
  state: "active" | "archived";
  archivedAt: number | null;
}

export type LifecyclePatch = Partial<Pick<MemoryRecord, "strength" | "strengthAt" | "boosts" | "lastRecalledAt" | "state" | "archivedAt">>;

const STOP_WORDS = new Set([
  "a", "an", "the", "and", "or", "in", "on", "at", "to", "for", "of", "with", "by", "from",
  "is", "are", "was", "were", "be", "been", "will", "would", "should", "could", "can",
  "do", "does", "did", "have", "has", "had", "my", "me", "i", "you", "your", "it", "its",
  "this", "that", "what", "which", "who", "whom", "whose", "if", "so", "as", "about",
]);

function words(query: string): string[] {
  return query.replace(/[^\w\s]/g, " ").trim().split(/\s+/).map((t) => t.toLowerCase()).filter((t) => t.length > 0);
}

/** Query content words (stop words dropped unless nothing else is left). */
export function searchTokens(query: string): string[] {
  const raw = words(query);
  const meaningful = raw.filter((t) => t.length > 1 && !STOP_WORDS.has(t));
  return meaningful.length > 0 ? meaningful : raw;
}

/** Adjacent word pairs of the query, skipping pairs made only of stop words. */
export function phrasePairs(query: string): [string, string][] {
  const raw = words(query);
  const pairs: [string, string][] = [];
  for (let i = 0; i + 1 < raw.length; i++) {
    if (STOP_WORDS.has(raw[i]!) && STOP_WORDS.has(raw[i + 1]!)) continue;
    pairs.push([raw[i]!, raw[i + 1]!]);
  }
  return pairs;
}

interface Row {
  seq: number; id: string; text: string; pinned: number; source: string; created_at: number; occurred_at: number;
  episode: number | null; ordinal: number | null; importance: string; strength: number; strength_at: number;
  boosts: number; last_recalled_at: number | null; state: string; archived_at: number | null;
}

function fromRow(r: Row): MemoryRecord {
  return {
    id: r.id, text: r.text, pinned: r.pinned === 1, source: r.source, createdAt: r.created_at, occurredAt: r.occurred_at,
    episode: r.episode, ordinal: r.ordinal, importance: r.importance as Importance, strength: r.strength,
    strengthAt: r.strength_at, boosts: r.boosts, lastRecalledAt: r.last_recalled_at,
    state: r.state === "archived" ? "archived" : "active", archivedAt: r.archived_at,
  };
}

const COLUMNS: Record<keyof LifecyclePatch, string> = {
  strength: "strength", strengthAt: "strength_at", boosts: "boosts", lastRecalledAt: "last_recalled_at", state: "state", archivedAt: "archived_at",
};

export class MemoryDB {
  readonly path: string;
  private readonly db: Database;
  /** Every memory in insertion order, with lowercased text for the substring leg. */
  private cache: { rows: MemoryRecord[]; byId: Map<string, MemoryRecord>; lower: Map<string, string> } | null = null;
  private vectorCache: Map<string, Float32Array> | null = null;
  private dataVersion = -1;

  constructor(path: string = ":memory:") {
    this.path = path;
    this.db = new Database(path, { create: true });
    this.db.run("PRAGMA busy_timeout = 5000");
    if (path !== ":memory:") this.db.run("PRAGMA journal_mode = WAL");
    this.db.run("PRAGMA foreign_keys = ON");
    this.backupV2();
    this.db.run(`
      CREATE TABLE IF NOT EXISTS memories (
        seq INTEGER PRIMARY KEY,
        id TEXT NOT NULL UNIQUE,
        text TEXT NOT NULL,
        pinned INTEGER NOT NULL DEFAULT 0,
        source TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        occurred_at INTEGER NOT NULL,
        episode INTEGER,
        ordinal INTEGER,
        importance TEXT NOT NULL DEFAULT 'default',
        strength REAL NOT NULL,
        strength_at INTEGER NOT NULL,
        boosts INTEGER NOT NULL DEFAULT 0,
        last_recalled_at INTEGER,
        state TEXT NOT NULL DEFAULT 'active',
        archived_at INTEGER
      );
      CREATE INDEX IF NOT EXISTS memories_episode ON memories(episode, ordinal);
      CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(
        text, content='memories', content_rowid='seq', prefix='2,3', tokenize='porter unicode61'
      );
      CREATE TRIGGER IF NOT EXISTS memories_ai AFTER INSERT ON memories BEGIN
        INSERT INTO memories_fts(rowid, text) VALUES (new.seq, new.text);
      END;
      CREATE TRIGGER IF NOT EXISTS memories_ad AFTER DELETE ON memories BEGIN
        INSERT INTO memories_fts(memories_fts, rowid, text) VALUES ('delete', old.seq, old.text);
      END;
      CREATE TABLE IF NOT EXISTS vectors (
        id TEXT PRIMARY KEY REFERENCES memories(id) ON DELETE CASCADE,
        model TEXT NOT NULL,
        dims INTEGER NOT NULL,
        vec BLOB NOT NULL
      );
      CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    `);
    this.migrateFromV2();
  }

  /** Before the 2.x tables are migrated away, snapshot the file as it was (once). */
  private backupV2(): void {
    if (this.path === ":memory:" || !this.db.query("SELECT 1 FROM sqlite_master WHERE name = 'nodes'").get()) return;
    const backup = `${this.path}.v2-backup`;
    if (!existsSync(backup)) this.db.run(`VACUUM INTO '${backup.replace(/'/g, "''")}'`);
  }

  /**
   * NSM 2.x kept memories as JSON payloads in a `nodes` table beside concept nodes, graph edges, an audit
   * log and integration configs. Copy the memories (and their vectors) across, drop the rest, and leave a
   * snapshot of the old file next to it.
   */
  private migrateFromV2(): void {
    const has = (name: string) => Boolean(this.db.query("SELECT 1 FROM sqlite_master WHERE name = ?").get(name));
    if (!has("nodes")) return;
    this.db.run("BEGIN IMMEDIATE");
    try {
      if (has("nodes")) {
        const rows = this.db.query("SELECT * FROM nodes WHERE node_type IN ('fact', 'invariant') ORDER BY rowid").all() as any[];
        const insert = this.db.query(`INSERT OR IGNORE INTO memories
          (id, text, pinned, source, created_at, occurred_at, episode, ordinal, importance, strength, strength_at, boosts, last_recalled_at, state, archived_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
        for (const r of rows) {
          let p: Record<string, any> = {};
          try { p = JSON.parse(r.payload); } catch {}
          const pinned = r.node_type === "invariant";
          const importance: Importance = pinned ? "pinned" : p.importance === "high" ? "high" : "default";
          const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);
          insert.run(
            r.id, String(p.text ?? p.rule ?? r.label), pinned ? 1 : 0, r.source, r.created_at,
            num(p.occurredAt) ?? r.created_at, num(p.episodeId), num(p.ordinal), importance,
            num(p.strength) ?? initialStrength(importance), num(p.strengthAt) ?? r.created_at, num(p.boostCount) ?? 0,
            num(p.lastRecalledAt), p.state === "archived" ? "archived" : "active", num(p.archivedAt),
          );
        }
        if (has("node_vectors")) {
          this.db.run("INSERT OR IGNORE INTO vectors SELECT id, model, dims, vec FROM node_vectors WHERE id IN (SELECT id FROM memories)");
        }
        for (const t of ["edges", "nodes_fts", "nodes", "node_vectors", "query_audit_logs", "integration_configs"]) {
          this.db.run(`DROP TABLE IF EXISTS ${t}`);
        }
      }
      this.db.run("COMMIT");
    } catch (e) {
      this.db.run("ROLLBACK");
      throw e;
    }
    this.db.run("VACUUM");
  }

  // ---- cache ----

  /** Drops the caches when another connection has committed since we last looked. */
  private fresh(): void {
    const v = (this.db.query("PRAGMA data_version").get() as { data_version: number }).data_version;
    if (v !== this.dataVersion) {
      this.dataVersion = v;
      this.cache = null;
      this.vectorCache = null;
    }
  }

  private loaded() {
    this.fresh();
    if (!this.cache) {
      const rows = (this.db.query("SELECT * FROM memories ORDER BY seq").all() as Row[]).map(fromRow);
      this.cache = {
        rows,
        byId: new Map(rows.map((r) => [r.id, r])),
        lower: new Map(rows.map((r) => [r.id, r.text.toLowerCase()])),
      };
    }
    return this.cache;
  }

  // ---- memories ----

  /** Every memory, oldest first. Shared cache: callers must not mutate it. */
  all(): readonly MemoryRecord[] {
    return this.loaded().rows;
  }

  get(id: string): MemoryRecord | undefined {
    return this.loaded().byId.get(id);
  }

  /** Id -> memory, checked for freshness once (for resolving many ids in one pass). */
  index(): ReadonlyMap<string, MemoryRecord> {
    return this.loaded().byId;
  }

  findByText(text: string): MemoryRecord | undefined {
    const row = this.db.query("SELECT id FROM memories WHERE text = ? LIMIT 1").get(text) as { id: string } | null;
    return row ? this.get(row.id) : undefined;
  }

  /** How many memories an episode holds (the next ordinal in it). */
  episodeSize(episode: number): number {
    return (this.db.query("SELECT COUNT(*) AS n FROM memories WHERE episode = ?").get(episode) as { n: number }).n;
  }

  /** Unpinned memories of `episode` with ordinals in [from, to]. */
  episodeRange(episode: number, from: number, to: number): MemoryRecord[] {
    const ids = this.db.query("SELECT id FROM memories WHERE episode = ? AND ordinal BETWEEN ? AND ? AND pinned = 0 ORDER BY ordinal, seq")
      .all(episode, from, to) as { id: string }[];
    return ids.map((r) => this.get(r.id)).filter((m): m is MemoryRecord => Boolean(m));
  }

  insert(m: MemoryRecord): void {
    this.db.query(`INSERT INTO memories
      (id, text, pinned, source, created_at, occurred_at, episode, ordinal, importance, strength, strength_at, boosts, last_recalled_at, state, archived_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      m.id, m.text, m.pinned ? 1 : 0, m.source, m.createdAt, m.occurredAt, m.episode, m.ordinal, m.importance,
      m.strength, m.strengthAt, m.boosts, m.lastRecalledAt, m.state, m.archivedAt,
    );
    if (this.cache) {
      this.fresh();
      if (this.cache) {
        const copy = { ...m };
        this.cache.rows.push(copy);
        this.cache.byId.set(m.id, copy);
        this.cache.lower.set(m.id, m.text.toLowerCase());
      }
    }
  }

  /** Lifecycle fields change on every recall; the cached record is updated in place. */
  update(id: string, patch: LifecyclePatch): void {
    const keys = Object.keys(patch) as (keyof LifecyclePatch)[];
    if (keys.length === 0) return;
    this.db.query(`UPDATE memories SET ${keys.map((k) => `${COLUMNS[k]} = ?`).join(", ")} WHERE id = ?`)
      .run(...keys.map((k) => patch[k] as any), id);
    this.fresh();
    const cached = this.cache?.byId.get(id);
    if (cached) Object.assign(cached, patch);
  }

  delete(id: string): boolean {
    const changes = this.db.query("DELETE FROM memories WHERE id = ?").run(id).changes;
    this.cache = null;
    this.vectorCache?.delete(id);
    return changes > 0;
  }

  transaction<T>(fn: () => T): T {
    return this.db.transaction(fn)();
  }

  // ---- vectors ----

  upsertVector(id: string, model: string, vec: Float32Array): void {
    this.db.query(`INSERT INTO vectors (id, model, dims, vec) VALUES (?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET model = excluded.model, dims = excluded.dims, vec = excluded.vec`)
      .run(id, model, vec.length, Buffer.from(vec.buffer, vec.byteOffset, vec.byteLength));
    this.fresh();
    this.vectorCache?.set(id, vec);
  }

  vectors(): Map<string, Float32Array> {
    this.fresh();
    if (!this.vectorCache) {
      const m = new Map<string, Float32Array>();
      for (const r of this.db.query("SELECT id, dims, vec FROM vectors").all() as { id: string; dims: number; vec: Uint8Array }[]) {
        const buf = Buffer.from(r.vec);
        m.set(r.id, new Float32Array(buf.buffer, buf.byteOffset, r.dims));
      }
      this.vectorCache = m;
    }
    return this.vectorCache;
  }

  /** Unpinned memories with no vector yet. */
  unembedded(): MemoryRecord[] {
    const ids = this.db.query("SELECT m.id FROM memories m LEFT JOIN vectors v ON v.id = m.id WHERE v.id IS NULL AND m.pinned = 0 ORDER BY m.seq")
      .all() as { id: string }[];
    return ids.map((r) => this.get(r.id)).filter((m): m is MemoryRecord => Boolean(m));
  }

  // ---- retrieval legs (pinned rules are never ranked) ----

  private fts(match: string, limit: number): string[] {
    try {
      const rows = this.db.query(`SELECT m.id FROM memories_fts f JOIN memories m ON m.seq = f.rowid
        WHERE memories_fts MATCH ? AND m.pinned = 0 ORDER BY f.rank LIMIT ?`).all(match, limit) as { id: string }[];
      return rows.map((r) => r.id);
    } catch {
      return [];
    }
  }

  /** Porter-stemmed BM25 over the query's content words, OR'd (prefix-matched by default). */
  searchBM25(query: string, limit: number, prefix: boolean = true): string[] {
    const tokens = searchTokens(query);
    if (tokens.length === 0) return [];
    return this.fts(tokens.map((t) => `"${t}"${prefix ? "*" : ""}`).join(" OR "), limit);
  }

  /** Adjacent query word pairs as FTS phrases. */
  searchPhrases(query: string, limit: number): string[] {
    const pairs = phrasePairs(query);
    if (pairs.length === 0) return [];
    return this.fts(pairs.map(([a, b]) => `"${a} ${b}"`).join(" OR "), limit);
  }

  /** Memories containing query tokens as substrings, by how many they contain (ties: oldest first). */
  searchSubstrings(tokens: string[], limit: number): { id: string; count: number }[] {
    if (tokens.length === 0) return [];
    const { rows, lower } = this.loaded();
    const hits: { id: string; count: number }[] = [];
    for (const m of rows) {
      if (m.pinned) continue;
      const text = lower.get(m.id)!;
      let count = 0;
      for (const t of tokens) if (text.includes(t)) count++;
      if (count > 0) hits.push({ id: m.id, count });
    }
    return hits.sort((a, b) => b.count - a.count).slice(0, limit);
  }

  /** Brute-force cosine over unit vectors; hits must share some direction with the query. */
  searchDense(queryVec: Float32Array, limit: number): string[] {
    const hits: { id: string; s: number }[] = [];
    for (const [id, vec] of this.vectors()) {
      if (vec.length !== queryVec.length) continue;
      let s = 0;
      for (let i = 0; i < vec.length; i++) s += vec[i]! * queryVec[i]!;
      if (s > 0) hits.push({ id, s });
    }
    return hits.sort((a, b) => b.s - a.s).slice(0, limit).map((h) => h.id);
  }

  // ---- meta ----

  getMeta(key: string): string | undefined {
    return (this.db.query("SELECT value FROM meta WHERE key = ?").get(key) as { value: string } | null)?.value;
  }

  setMeta(key: string, value: string): void {
    this.db.query("INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(key, value);
  }

  close(): void {
    this.db.close();
  }
}
