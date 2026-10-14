import { describe, it, expect } from "bun:test";
import { NeuroSwarmMesh } from "../src/mesh.js";
import { extractContentTerms } from "../src/core/storage/sqlite.js";

describe("extractContentTerms", () => {
  it("keeps distinctive words and capitalised names, drops the speaker prefix and stop words", () => {
    const terms = extractContentTerms("Gina: Since I lost my job at Door Dash, things have been tough.");
    expect(terms).toContain("lost");
    expect(terms).toContain("door");
    expect(terms).toContain("door dash");
    expect(terms).not.toContain("gina");
    expect(terms).not.toContain("the");
    expect(terms).not.toContain("at");
  });
});

describe("Term nodes", () => {
  it("are off by default and link memories that share a rare word when on", () => {
    const off = new NeuroSwarmMesh({ dbPath: ":memory:" });
    off.ingestText("Jon: The dance studio opens in March", { customId: "a" });
    expect(off.getGraph().getNode("term-studio")).toBeUndefined();
    // Concept nodes exist but are not lexical seeds by default.
    expect(off.getGraph().getAllNodes().some((n) => n.nodeType === "concept")).toBe(true);
    expect(off.query("studio").seedNodes.every((s) => s.node.nodeType !== "concept")).toBe(true);
    off.close();

    const on = new NeuroSwarmMesh({ dbPath: ":memory:", graph: { terms: true, clausie: false } });
    on.ingestText("Jon: The dance studio opens in March", { customId: "a" });
    on.ingestText("Gina: Found a cheap studio space downtown", { customId: "b" });
    on.ingestText("Gina: My clothing store launched an ad campaign", { customId: "c" });
    const studio = on.getGraph().getNode("term-studio");
    expect(studio?.nodeType).toBe("concept");
    const linked = on.getGraph().getIncomingEdges("term-studio").map((e) => e.targetId).sort();
    expect(linked).toEqual(["a", "b"]);
    // No clause-extractor concept nodes when clausie is off.
    expect(on.getGraph().getAllNodes().some((n) => n.id.startsWith("entity-"))).toBe(false);
    on.close();
  });

  it("let spreading activation reach a memory that shares no word with the query", () => {
    // Concept nodes out of the full-text index: seeds are memories, concepts are reached through edges.
    const mesh = new NeuroSwarmMesh({ dbPath: ":memory:", graph: { terms: true, searchableConcepts: false }, storage: { substringLeg: false } });
    mesh.ingestText("Jon: I signed the lease on the Maplewood studio today", { customId: "hit" });
    mesh.ingestText("Gina: Maplewood is a great neighbourhood for foot traffic", { customId: "bridge" });
    mesh.ingestText("Gina: My clothing store launched an ad campaign", { customId: "other" });
    const res = mesh.query("lease studio", { lateralInhibitionMaxPerCategory: 50 });
    const ids = res.salientNodes.map((n) => n.node.id);
    expect(ids[0]).toBe("hit");
    expect(ids).toContain("bridge");
    expect(ids).not.toContain("other");
    // Concept nodes were not lexical seeds.
    expect(res.seedNodes.every((s) => s.node.nodeType !== "concept")).toBe(true);
    mesh.close();
  });

  it("keep concept nodes out of the substring leg as well when unsearchable", () => {
    const mesh = new NeuroSwarmMesh({ dbPath: ":memory:", graph: { terms: true, searchableConcepts: false } });
    mesh.ingestText("Jon: I signed the lease on the Maplewood studio today", { customId: "hit" });
    const hits = mesh.getStorage().searchSubstrings(["maplewood"], 10).map((h) => h.id);
    expect(hits).toEqual(["hit"]);
    mesh.close();
  });
});

describe("Fan damping", () => {
  it("reduces the energy a hub passes on, and is off by default", () => {
    const build = () => {
      const m = new NeuroSwarmMesh({ dbPath: ":memory:", graph: { terms: true, clausie: false }, storage: { substringLeg: false } });
      m.ingestText("Jon: Lost my job yesterday", { customId: "seed" });
      for (let i = 0; i < 20; i++) m.ingestText(`Gina: Another job story number ${i} about work`, { customId: `job${i}` });
      m.ingestText("Gina: Yesterday was sunny", { customId: "rare" });
      return m;
    };
    const plain = build();
    const damped = build();
    const q = "lost";
    const energy = (m: NeuroSwarmMesh, id: string, fanDamping: boolean) =>
      m.query(q, { lateralInhibitionMaxPerCategory: 100, fanDamping, minEnergyThreshold: 0.0001 }).salientNodes.find((n) => n.node.id === id)?.score ?? 0;
    // "job" fans out to 21 memories, "yesterday" to 2. Undamped, both neighbours get the same energy per edge.
    const plainJob = energy(plain, "job0", false);
    const plainRare = energy(plain, "rare", false);
    expect(plainJob).toBeCloseTo(plainRare, 6);
    // Damped, the memory reached through the rare term keeps more energy than one reached through the hub.
    const dampedJob = energy(damped, "job0", true);
    const dampedRare = energy(damped, "rare", true);
    expect(dampedRare).toBeGreaterThan(dampedJob);
    expect(dampedJob).toBeLessThan(plainJob);
    plain.close();
    damped.close();
  });
});
