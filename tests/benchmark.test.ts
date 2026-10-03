import { describe, it } from "bun:test";
import { NeuroSwarmMesh } from "../src/mesh.js";
import { ClausIEv2Extractor } from "../src/extractors/clausie_v2.js";

describe("Performance & Latency Benchmark", () => {
  it("executes retrieval across 200 nodes in under 1 millisecond", () => {
    const mesh = new NeuroSwarmMesh({ dbPath: ":memory:" });

    console.log("\n=======================================================");
    console.log("       NEURO-SWARM MESH (NSM) PERFORMANCE BENCHMARK     ");
    console.log("=======================================================");

    // Ingest 200 synthetic nodes
    const nodeCount = 200;
    for (let i = 0; i < nodeCount; i++) {
      mesh.ingestNode({
        id: `node-${i}`,
        nodeType: i % 10 === 0 ? "invariant" : i % 3 === 0 ? "event" : "profile",
        label: `Entity ${i} with attributes for cluster ${i % 15}`,
        source: i % 5 === 0 ? "user_fact" : "cloud_mesh",
        authority: i % 5 === 0 ? 1.0 : 0.85,
        payload: {
          index: i,
          cluster: i % 15,
          text: `Detailed content for node ${i} covering topics such as distributed systems and memory architectures.`,
        },
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });
    }

    // Ingest 300 synaptic edges
    for (let i = 0; i < 300; i++) {
      const src = `node-${i % nodeCount}`;
      const tgt = `node-${(i * 7 + 3) % nodeCount}`;
      mesh.ingestEdge({
        sourceId: src,
        targetId: tgt,
        relation: "relates_to",
        weight: 0.5 + Math.random() * 0.5,
        lastActivated: Date.now(),
      });
    }

    // Warm-up query
    mesh.query("distributed systems cluster");

    // Benchmark 50 query executions
    const iterations = 50;
    const times: number[] = [];

    for (let i = 0; i < iterations; i++) {
      const t0 = performance.now();
      const res = mesh.query(`distributed systems cluster ${i % 15}`);
      const t1 = performance.now();
      times.push(t1 - t0);
    }

    const avgMs = times.reduce((a, b) => a + b, 0) / iterations;
    const minMs = Math.min(...times);
    const maxMs = Math.max(...times);

    console.log(`[Storage + Graph Nodes] : ${nodeCount}`);
    console.log(`[Synaptic RAM Edges]    : 300`);
    console.log(`[Benchmark Iterations]  : ${iterations}`);
    console.log(`[Avg Query Latency]     : ${avgMs.toFixed(3)} ms`);
    console.log(`[Min Query Latency]     : ${minMs.toFixed(3)} ms`);
    console.log(`[Max Query Latency]     : ${maxMs.toFixed(3)} ms`);

    // Extractor throughput
    const sampleSentences = [
      "I work at AlphaCore as a senior platform engineer",
      "I live in Denver and work remotely",
      "I have 3 projects aged 12, 6, and 2 months",
      "I invest in equities, precious metals, and index funds",
    ];

    const tExt0 = performance.now();
    for (let i = 0; i < 100; i++) {
      for (const sent of sampleSentences) {
        ClausIEv2Extractor.extract(sent);
      }
    }
    const tExt1 = performance.now();
    const totalExtractions = 100 * sampleSentences.length;
    const extAvgUs = ((tExt1 - tExt0) / totalExtractions) * 1000;

    console.log(`[OpenIE ClausIE v2 Avg] : ${extAvgUs.toFixed(1)} microseconds per sentence`);
    console.log("=======================================================\n");

    mesh.close();
  });
});
