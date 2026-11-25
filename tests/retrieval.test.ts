import { describe, it, expect } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Retriever } from "../src/retrieval.js";
import { MemoryDB, phrasePairs, searchTokens } from "../src/db.js";
import type { Embedder, Reranker } from "../src/neural/types.js";

const ids = async (r: Retriever, q: string, opts = {}) => (await r.search(q, opts)).hits.map((h) => h.memory.id);

describe("lexical legs", () => {
  it("stems both sides (porter): 'paint' finds 'painted'", async () => {
    const r = new Retriever();
    r.add("Gina: I painted the lake sunrise last year", { id: "t1" });
    r.add("Jon: The dance studio opens in March", { id: "t2" });
    expect(r.db.searchBM25("What did Gina paint?", 5, false)).toContain("t1");
    r.close();
  });

  it("phrase leg ranks an exact adjacent pair above scattered words", async () => {
    const r = new Retriever({ legs: { substring: false } });
    r.add("Jon: Lost my job as a banker yesterday", { id: "exact" });
    r.add("Gina: A banker I know lost his wallet; the job market is rough", { id: "scattered" });
    expect((await ids(r, "lost my job as a banker"))[0]).toBe("exact");
    r.close();
  });

  it("phrase pairs skip stop-word-only pairs; tokens drop stop words", () => {
    expect(phrasePairs("lost my job as a banker")).toEqual([["lost", "my"], ["my", "job"], ["job", "as"], ["a", "banker"]]);
    expect(searchTokens("What is my job?")).toEqual(["job"]);
  });

  it("substring leg finds a word inside another and can be turned off", async () => {
    const on = new Retriever();
    on.add("Jon: My dancestudio app is live", { id: "t1" });
    expect(await ids(on, "studio")).toEqual(["t1"]);
    const off = new Retriever({ legs: { substring: false } });
    off.add("Jon: My dancestudio app is live", { id: "t1" });
    expect(await ids(off, "studio")).toEqual([]);
    on.close();
    off.close();
  });

  it("never ranks pinned rules", async () => {
    const r = new Retriever();
    r.add("Always deploy with bun", { id: "rule", pinned: true });
    r.add("We deploy to Railway", { id: "fact" });
    expect(await ids(r, "deploy")).toEqual(["fact"]);
    r.close();
  });

  it("returns at most `limit` hits", async () => {
    const r = new Retriever();
    for (let i = 0; i < 30; i++) r.add(`Note ${i} about the studio lease`, { id: `n${i}` });
    expect((await ids(r, "studio lease", { limit: 7 })).length).toBe(7);
    r.close();
  });
});

describe("episode neighbours", () => {
  const build = () => {
    const r = new Retriever();
    r.add("Gina: Hey Jon, how are you?", { id: "s1:0", episode: 1, ordinal: 0 });
    r.add("Jon: Lost my job as a banker yesterday", { id: "s1:1", episode: 1, ordinal: 1 });
    r.add("Gina: Sorry about the job, that is rough", { id: "s1:2", episode: 1, ordinal: 2 });
    r.add("Gina: My clothing store campaign launched", { id: "s2:0", episode: 2, ordinal: 0 });
    return r;
  };

  it("are off without a dense leg", async () => {
    const r = build();
    const res = await r.search("banker job");
    expect(res.hits.some((h) => h.reasons.some((x) => x.startsWith("Episode neighbour")))).toBe(false);
    r.close();
  });

  it("add the turns around the top hit right after it", async () => {
    const r = build();
    const res = await r.search("banker job", { episodes: { topSeeds: 1, radius: 1 } });
    const order = res.hits.map((h) => h.memory.id);
    // s1:2 mentions "job" so it is a direct hit; only s1:0 is added, right after its seed.
    expect(order.slice(0, 3)).toEqual(["s1:1", "s1:0", "s1:2"]);
    expect(res.hits[1]!.reasons[0]).toStartWith("Episode neighbour of s1:1");
    r.close();
  });
});

/** Deterministic fake: a bag-of-words vector over a tiny vocabulary, unit length. */
const VOCAB = ["dance", "studio", "lease", "clothing", "store", "campaign", "job", "banker", "place"];
const fakeEmbedder: Embedder = {
  name: "fake-bow",
  dims: VOCAB.length,
  async embed(texts) {
    return texts.map((t) => {
      const v = new Float32Array(VOCAB.length);
      const words = t.toLowerCase().split(/\W+/);
      VOCAB.forEach((w, i) => { if (words.includes(w)) v[i] = 1; });
      let n = 0; for (const x of v) n += x * x; n = Math.sqrt(n) || 1;
      return v.map((x) => x / n);
    });
  },
};

/** Fake reranker: relevance = number of query words in the text. */
const fakeReranker: Reranker = {
  name: "fake-overlap",
  async score(query, texts) {
    const q = new Set(query.toLowerCase().split(/\W+/).filter(Boolean));
    return texts.map((t) => t.toLowerCase().split(/\W+/).filter((w) => q.has(w)).length);
  },
};

describe("local models (fakes)", () => {
  it("embed pending memories once, not pinned rules, and keep vectors across reopen", async () => {
    const home = mkdtempSync(join(tmpdir(), "nsm-vec-"));
    const path = join(home, "m.db");
    try {
      const r = new Retriever({ dbPath: path, neural: { embedder: fakeEmbedder } });
      r.add("Jon: Signed the lease on the dance studio", { id: "a" });
      r.add("Gina: My clothing store launched a campaign", { id: "b" });
      r.add("Always use bun", { id: "rule", pinned: true });
      expect(await r.embedPending()).toBe(2);
      expect(await r.embedPending()).toBe(0);
      r.close();
      const again = new Retriever({ dbPath: path, neural: { embedder: fakeEmbedder } });
      expect(again.db.vectors().size).toBe(2);
      expect(await again.embedPending()).toBe(0);
      expect(again.db.delete("a")).toBe(true);
      expect(again.db.vectors().size).toBe(1); // vectors go with their memory
      again.close();
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("the dense leg reaches a memory that shares no word with the query", async () => {
    const r = new Retriever({ legs: { substring: false }, neural: { embedder: fakeEmbedder } });
    r.add("Jon: I want to open a dance place", { id: "dense-only" });
    r.add("Gina: My clothing store launched a campaign", { id: "other" });
    await r.embedPending();
    const res = await r.search("studio for dancing, a place to practise");
    expect(res.hits[0]!.memory.id).toBe("dense-only");
    expect(res.hits[0]!.reasons.some((x) => x.startsWith("Dense"))).toBe(true);
    expect(res.hits.map((h) => h.memory.id)).not.toContain("other");
    r.close();
  });

  it("the reranker reorders the pool and says so", async () => {
    const r = new Retriever({ legs: { substring: false }, neural: { reranker: fakeReranker } });
    r.add("Gina: The job market is rough this year", { id: "weak" });
    r.add("Jon: Lost my job as a banker yesterday", { id: "strong" });
    const res = await r.search("job banker yesterday");
    expect(res.reranked).toBe(true);
    expect(res.hits[0]!.memory.id).toBe("strong");
    expect(res.hits[0]!.reasons.some((x) => x.startsWith("Rerank"))).toBe(true);
    r.close();
  });
});

describe("shared database file", () => {
  it("sees memories another process (connection) added", async () => {
    const home = mkdtempSync(join(tmpdir(), "nsm-share-"));
    const path = join(home, "m.db");
    try {
      const a = new Retriever({ dbPath: path });
      const b = new Retriever({ dbPath: path });
      a.add("Gina: Opened a dance studio", { id: "x" });
      expect(await ids(b, "studio")).toEqual(["x"]); // b's cache loads after a's write
      a.add("Jon: The studio lease is signed", { id: "y" });
      expect((await ids(b, "studio")).sort()).toEqual(["x", "y"]); // b's cache is dropped on a's commit
      expect(b.db.get("y")?.text).toContain("lease");
      a.close();
      b.close();
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe("migration from NSM 2.x", () => {
  it("keeps memories, pins, lifecycle fields and vectors; drops concept nodes, edges and the rest", async () => {
    const { Database } = await import("bun:sqlite");
    const home = mkdtempSync(join(tmpdir(), "nsm-mig-"));
    const path = join(home, "memory.db");
    try {
      const old = new Database(path);
      old.run(`CREATE TABLE nodes (id TEXT PRIMARY KEY, node_type TEXT NOT NULL, label TEXT NOT NULL, source TEXT NOT NULL, payload TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
        CREATE VIRTUAL TABLE nodes_fts USING fts5(id UNINDEXED, label, content);
        CREATE TABLE edges (source_id TEXT, target_id TEXT, relation TEXT, weight REAL, last_activated INTEGER);
        CREATE TABLE node_vectors (id TEXT PRIMARY KEY, model TEXT NOT NULL, dims INTEGER NOT NULL, vec BLOB NOT NULL);
        CREATE TABLE query_audit_logs (id TEXT PRIMARY KEY);
        CREATE TABLE integration_configs (id TEXT PRIMARY KEY);`);
      const ins = old.query("INSERT INTO nodes VALUES (?, ?, ?, ?, ?, ?, ?)");
      ins.run("fact-1", "fact", "We deploy to Railway", "mcp", JSON.stringify({
        text: "We deploy to Railway", triplets: [{ subject: "we" }], importance: "default", strength: 0.55, strengthAt: 2000,
        boostCount: 3, lastRecalledAt: 2000, state: "archived", archivedAt: 1500, occurredAt: 900, episodeId: 7, ordinal: 2,
      }), 1000, 2000);
      ins.run("fact-2", "invariant", "Always use bun", "user_invariant", JSON.stringify({ rule: "Always use bun", text: "Always use bun" }), 1100, 1100);
      ins.run("entity-railway", "concept", "Railway", "inferred", JSON.stringify({ name: "Railway" }), 1000, 1000);
      old.query("INSERT INTO edges VALUES ('fact-1', 'entity-railway', 'deploy', 0.9, 1000)").run();
      old.query("INSERT INTO node_vectors VALUES (?, 'm', 2, ?)").run("fact-1", Buffer.from(new Float32Array([0.6, 0.8]).buffer));
      old.close();

      const db = new MemoryDB(path);
      const all = db.all();
      expect(all.map((m) => m.id)).toEqual(["fact-1", "fact-2"]);
      expect(all[0]).toMatchObject({
        text: "We deploy to Railway", pinned: false, source: "mcp", createdAt: 1000, occurredAt: 900, episode: 7, ordinal: 2,
        strength: 0.55, strengthAt: 2000, boosts: 3, lastRecalledAt: 2000, state: "archived", archivedAt: 1500,
      });
      expect(all[1]).toMatchObject({ text: "Always use bun", pinned: true, importance: "pinned" });
      expect(Array.from(db.vectors().get("fact-1")!)).toEqual([Math.fround(0.6), Math.fround(0.8)]);
      expect(db.searchBM25("railway", 5)).toEqual(["fact-1"]);
      db.close();

      const check = new Database(path);
      const tables = (check.query("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[]).map((t) => t.name);
      for (const gone of ["nodes", "edges", "nodes_fts", "node_vectors", "query_audit_logs", "integration_configs"]) expect(tables).not.toContain(gone);
      check.close();
      const backup = new Database(`${path}.v2-backup`);
      expect((backup.query("SELECT COUNT(*) AS n FROM nodes").get() as { n: number }).n).toBe(3);
      backup.close();

      // Opening again is a no-op.
      const again = new MemoryDB(path);
      expect(again.all().length).toBe(2);
      again.close();
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});
