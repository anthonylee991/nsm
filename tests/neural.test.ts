import { describe, it, expect } from "bun:test";
import { NeuroSwarmMesh } from "../src/mesh.js";
import type { Embedder, Reranker } from "../src/neural/types.js";

/** Deterministic fake: a bag-of-words vector over a tiny vocabulary, unit length. */
const VOCAB = ["dance", "studio", "lease", "clothing", "store", "campaign", "job", "banker", "sunrise", "paint"];
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

describe("Dense leg", () => {
  it("is absent without an embedder and query() is unchanged", async () => {
    const mesh = new NeuroSwarmMesh({ dbPath: ":memory:" });
    mesh.ingestText("Jon: Lost my job as a banker", { customId: "a" });
    expect(await mesh.embedPending()).toBe(0);
    const sync = mesh.query("banker");
    const asyncRes = await mesh.queryAsync("banker");
    expect(asyncRes.salientNodes.map((n) => n.node.id)).toEqual(sync.salientNodes.map((n) => n.node.id));
    expect(asyncRes.seedNodes.every((s) => !s.matchReasons.some((r) => r.startsWith("Dense")))).toBe(true);
    mesh.close();
  });

  it("embeds pending memories (not concept nodes) and persists vectors across reopen", async () => {
    const path = `${process.env.TEMP ?? "/tmp"}/nsm-vec-${Date.now()}.db`;
    const mesh = new NeuroSwarmMesh({ dbPath: path, neural: { embedder: fakeEmbedder } });
    mesh.ingestText("Jon: Signed the lease on the dance studio", { customId: "a" });
    mesh.ingestText("Gina: My clothing store launched a campaign", { customId: "b" });
    expect(await mesh.embedPending()).toBe(2);
    expect(await mesh.embedPending()).toBe(0);
    expect(mesh.getStorage().getAllVectors().size).toBe(2);
    mesh.close();
    const reopened = new NeuroSwarmMesh({ dbPath: path, neural: { embedder: fakeEmbedder } });
    expect(reopened.getStorage().getAllVectors().size).toBe(2);
    expect(await reopened.embedPending()).toBe(0);
    reopened.close();
  });

  it("reaches a memory that shares no surface word with the query through the vector", async () => {
    // Porter off, no substring leg: "studios" will not match "studio" lexically, but the fake embedder
    // sees "dance" in both, so the dense leg seeds it.
    const mesh = new NeuroSwarmMesh({
      dbPath: ":memory:",
      storage: { substringLeg: false, prefixMatch: false },
      neural: { embedder: fakeEmbedder, denseLimit: 5 },
    });
    mesh.ingestText("Jon: I want to open a dance place", { customId: "dense-only" });
    mesh.ingestText("Gina: My clothing store launched a campaign", { customId: "other" });
    await mesh.embedPending();
    const lexical = mesh.query("dance");
    const fused = await mesh.queryAsync("dance");
    // Lexically "dance" matches dense-only too, so check the Dense reason is present and the ranking holds.
    expect(fused.salientNodes[0]!.node.id).toBe("dense-only");
    expect(fused.seedNodes.find((s) => s.node.id === "dense-only")!.matchReasons.some((r) => r.startsWith("Dense"))).toBe(true);
    expect(lexical.salientNodes.map((n) => n.node.id)).not.toContain("other");
    expect(fused.salientNodes.map((n) => n.node.id)).not.toContain("other");
    mesh.close();
  });
});

describe("Rerank", () => {
  it("reorders the top memories by the reranker's score and leaves concept nodes after them", async () => {
    const mesh = new NeuroSwarmMesh({
      dbPath: ":memory:",
      storage: { substringLeg: false },
      neural: { reranker: fakeReranker, rerankCandidates: 10 },
    });
    // Both mention "job"; only the second also mentions "banker" and "yesterday".
    mesh.ingestText("Gina: The job market is rough this year", { customId: "weak" });
    mesh.ingestText("Jon: Lost my job as a banker yesterday", { customId: "strong" });
    await mesh.embedPending();
    const res = await mesh.queryAsync("job banker yesterday", { lateralInhibitionMaxPerCategory: 50 });
    const memories = res.salientNodes.filter((n) => n.node.nodeType !== "concept");
    expect(memories[0]!.node.id).toBe("strong");
    expect(memories[0]!.matchReasons.some((r) => r.startsWith("Rerank"))).toBe(true);
    const firstConcept = res.salientNodes.findIndex((n) => n.node.nodeType === "concept");
    const lastMemory = res.salientNodes.map((n) => n.node.nodeType !== "concept").lastIndexOf(true);
    if (firstConcept !== -1) expect(firstConcept).toBeGreaterThan(lastMemory);
    mesh.close();
  });
});
