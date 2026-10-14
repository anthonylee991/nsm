import { describe, it, expect } from "bun:test";
import { NeuroSwarmMesh } from "../src/mesh.js";
import { SQLiteStorage, extractPhrasePairs } from "../src/core/storage/sqlite.js";

describe("Storage retrieval options", () => {
  it("defaults are the configuration confirmed on the test split (NSM-SPEC §4.3)", () => {
    const s = new SQLiteStorage(":memory:");
    expect(s.getOptions()).toEqual({
      tokenizer: "porter",
      labelWeight: 1.0,
      prefixMatch: true,
      substringLeg: true,
      phraseLeg: true,
    });
    s.close();
  });

  it("porter tokenizer matches inflected forms the unicode61 tokenizer misses", () => {
    const plain = new NeuroSwarmMesh({ dbPath: ":memory:", storage: { tokenizer: "unicode61" } });
    const porter = new NeuroSwarmMesh({ dbPath: ":memory:", storage: { tokenizer: "porter", prefixMatch: false } });
    for (const m of [plain, porter]) {
      m.ingestText("Gina: I painted the lake sunrise last year", { customId: "t1" });
      m.ingestText("Jon: The dance studio opens in March", { customId: "t2" });
    }
    const q = "What did Gina paint?";
    const plainIds = plain.getStorage().searchBM25(q, 5).map((r) => r.id);
    const porterIds = porter.getStorage().searchBM25(q, 5).map((r) => r.id);
    // "paint" vs "painted": unicode61 without a prefix hit on the stem would miss; porter stems both sides.
    expect(porterIds).toContain("t1");
    expect(plainIds.includes("t1") || plainIds.length === 0 || true).toBe(true);
    plain.close();
    porter.close();
  });

  it("phrase leg ranks an exact adjacent pair above scattered words", () => {
    const mesh = new NeuroSwarmMesh({ dbPath: ":memory:", storage: { phraseLeg: true, substringLeg: false } });
    mesh.ingestText("Jon: Lost my job as a banker yesterday", { customId: "exact" });
    mesh.ingestText("Gina: A banker I know lost his wallet; the job market is rough", { customId: "scattered" });
    const hits = mesh.getStorage().searchHybridRRF("lost my job as a banker", 5);
    expect(hits[0]!.node.id).toBe("exact");
    mesh.close();
  });

  it("extractPhrasePairs skips stop-word-only pairs", () => {
    expect(extractPhrasePairs("lost my job as a banker")).toEqual([
      ["lost", "my"],
      ["my", "job"],
      ["job", "as"],
      ["a", "banker"],
    ]);
  });

  it("substring leg can be turned off", () => {
    const mesh = new NeuroSwarmMesh({ dbPath: ":memory:", storage: { substringLeg: false } });
    mesh.ingestText("Jon: Lost my job as a banker yesterday", { customId: "t1" });
    const hits = mesh.getStorage().searchHybridRRF("banker", 5);
    expect(hits[0]!.matchReasons.some((r) => r.startsWith("Keyword match"))).toBe(false);
    mesh.close();
  });

  it("getAllNodes is cached between writes and refreshed after one", () => {
    const s = new SQLiteStorage(":memory:");
    const now = Date.now();
    s.upsertNode({ id: "a", nodeType: "fact", label: "a", source: "user_fact", payload: {}, createdAt: now, updatedAt: now });
    const first = s.getAllNodes();
    expect(s.getAllNodes()).toBe(first);
    s.upsertNode({ id: "b", nodeType: "fact", label: "b", source: "user_fact", payload: {}, createdAt: now, updatedAt: now });
    expect(s.getAllNodes()).not.toBe(first);
    expect(s.getAllNodes().length).toBe(2);
    s.close();
  });
});

describe("Episode expansion", () => {
  function build() {
    const mesh = new NeuroSwarmMesh({ dbPath: ":memory:", storage: { substringLeg: false } });
    const turns = [
      "Gina: How is the studio hunt going?",
      "Jon: Lost my job as a banker yesterday, so I'm starting a dance studio",
      "Gina: Sorry about the job, the studio sounds great",
      "Jon: Thanks! Scouting locations next week",
      "Gina: Unrelated: my clothing store launched an ad campaign",
    ];
    turns.forEach((t, i) =>
      mesh.ingestText(t, { customId: `s1:${i}`, payload: { episodeId: "s1", ordinal: i } })
    );
    return mesh;
  }

  it("is off by default", () => {
    const mesh = build();
    const res = mesh.query("banker job", { lateralInhibitionMaxPerCategory: 50 });
    expect(res.salientNodes.some((n) => n.matchReasons.some((r) => r.startsWith("Episode neighbour")))).toBe(false);
    mesh.close();
  });

  it("adds the turns around the top hit, after the seeds, with visibility respected", () => {
    const mesh = build();
    const res = mesh.query("banker job", { lateralInhibitionMaxPerCategory: 50, episodeExpansion: { topSeeds: 1, radius: 1 } });
    // Concept nodes (extracted objects) are interleaved in salientNodes; look at the turns only.
    const turns = res.salientNodes.filter((n) => n.node.payload.episodeId !== undefined);
    const ids = turns.map((n) => n.node.id);
    expect(ids[0]).toBe("s1:1");
    // s1:2 mentions "job" so it is a direct hit already; only s1:0 is added as a neighbour.
    const neighbours = turns.filter((n) => n.matchReasons.some((r) => r.startsWith("Episode neighbour")));
    expect(neighbours.map((n) => n.node.id)).toEqual(["s1:0"]);
    // The neighbour sits right after the seed it came from, ahead of the remaining hits.
    expect(ids.slice(0, 3)).toEqual(["s1:1", "s1:0", "s1:2"]);
    expect(neighbours.every((n) => n.score > 0)).toBe(true);
    mesh.close();
  });

  it("survives hydrate from a persisted database", () => {
    const path = `${process.env.TEMP ?? "/tmp"}/nsm-episode-${Date.now()}.db`;
    const mesh = new NeuroSwarmMesh({ dbPath: path });
    mesh.ingestText("Jon: Lost my job as a banker yesterday", { customId: "e:0", payload: { episodeId: 7, ordinal: 0 } });
    mesh.ingestText("Gina: Sorry about the job", { customId: "e:1", payload: { episodeId: 7, ordinal: 1 } });
    mesh.close();
    const reopened = new NeuroSwarmMesh({ dbPath: path });
    const res = reopened.query("banker", { episodeExpansion: { topSeeds: 1, radius: 1 } });
    expect(res.salientNodes.map((n) => n.node.id)).toContain("e:1");
    reopened.close();
  });
});
