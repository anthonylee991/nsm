# Neuro-Swarm Mesh (`nsm`)

> A zero-LLM, zero-embedding agent memory: SQLite FTS5 BM25 storage, an in-memory graph walked by
> spreading activation, pheromone-style edge reinforcement and evaporation, and rule-based OpenIE
> extraction. No API keys, no network, one SQLite file.

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Runtime: Bun](https://img.shields.io/badge/Runtime-Bun-black.svg)](https://bun.sh)

---

## What it is

NSM is the local-first branch of the ACM / AKM memory lineage. ACM (MemVault's production memory)
needs Postgres, pgvector, an embedding API and a reranker API. NSM asks a narrower question: how far
does a memory get with **no model calls at all**, so it can run inside any agent harness on any
machine with nothing to install and nothing to pay for.

* **Storage**: SQLite with an FTS5 index (BM25) over every memory, plus an edge table.
* **Extraction**: a rule-based clause splitter (`ClausIEv2Extractor`) turns a sentence into
  subject / verb / object triples without a model. Objects become concept nodes; the memory links to them.
* **Retrieval**: BM25 and substring hits are fused by reciprocal rank fusion, then activation spreads
  from those seeds across the concept graph (Collins & Loftus style, two hops by default), so a memory
  that shares a concept with a hit can surface even when it shares no words with the query.
* **Lateral inhibition**: nodes superseded by a higher-authority `:SUPERSEDES` edge are dropped;
  each node type is capped so one category cannot flood the result.
* **Reinforcement and evaporation**: co-retrieved edges gain weight (capped at 1.0); unused edges
  decay exponentially (14-day half-life by default). Pinned invariants never decay.
* **PAE output**: results are slotted into `[PINNED INVARIANTS]`, `[SCHEDULE & HORIZON]`,
  `[USER PROFILE & FACTS]`, `[ACTIVATED MEMORY]` for the agent's prompt.
* **Visibility inside retrieval**: an `asker` with scopes filters nodes in the FTS query, the graph
  walk and the output, never only at the end.

## Quickstart

```bash
bun install
bun test
```

```typescript
import { NeuroSwarmMesh } from "@skillvault/nsm";

const mesh = new NeuroSwarmMesh({ dbPath: "mesh.db" }); // or ":memory:"

mesh.ingestText("I work at DeepCore as a lead distributed systems architect");
mesh.ingestText("I live in Seattle and work remotely");

mesh.ingestNode({
  id: "inv-focus",
  nodeType: "invariant",
  label: "Morning Focus Block",
  source: "user_invariant",
  authority: 1.0,
  payload: { rule: "No meetings before 11:00 AM" },
  createdAt: Date.now(),
  updatedAt: Date.now(),
});

const result = mesh.query("Can I schedule a meeting on Monday morning?", {
  ambientContext: { "Local Time": "09:30 AM", "Current Day": "Monday" },
});

console.log(result.paePrompt);
console.log(result.telemetry.totalDurationMs, "ms");
mesh.close();
```

## Layout

```
nsm/
├── src/
│   ├── core/
│   │   ├── types.ts              # node/edge types, authority table, visibility (canSee)
│   │   ├── storage/sqlite.ts     # SQLite + FTS5, BM25 + substring RRF
│   │   └── graph/adjacency.ts    # in-memory graph: spreading activation, inhibition, reinforcement, PAE slots
│   ├── extractors/
│   │   ├── clausie_v2.ts         # rule-based clause / triple extraction
│   │   └── svo_hearst.ts         # Hearst-pattern fallback
│   ├── integrations/             # markdown vault, calendar feed, remote memory API, social signal providers
│   ├── mesh.ts                   # NeuroSwarmMesh facade: ingestText / ingestNode / query / evaporate
│   └── index.ts
├── tests/                        # 15 unit tests (storage, graph, extractors, authority, mesh, microbenchmark)
└── NSM-SPEC.md                   # design and equations
```

## Measured so far

Every number here was produced by code in this repo or in MemVault's benchmark harness, on this
machine. Nothing is typed in.

**Unit microbenchmark** (`tests/benchmark.test.ts`, 200 nodes, 300 edges, 50 iterations, Bun 1.4 on
Windows): mean query 1.5 ms, min 1.2 ms, max 4.9 ms; clause extraction 9 µs per sentence.

**One LoCoMo conversation through the MemVault harness** (`skillvault/apps/server/bench`, system
`nsm`, conv-30, no model calls): 369 turns ingested in 1.2 s into 1,735 nodes (1,366 concept nodes)
and 1,786 edges; retrieval 10 to 25 ms per question at that size. The latency grows with the store
because `query` scans every node for scope detection and substring matching; the sub-2 ms figure
above holds only for small stores.

**Accuracy: not yet measured.** NSM is registered in MemVault's LoCoMo harness
(`bench/systems/nsm.ts`: the same 885 held-out questions, answer model and judges as every other
system in `bench/RESULTS.md`). Until that run is done and recorded there, this README makes no
accuracy claim and no comparison with any other system.

## Running the benchmark

From `skillvault/apps/server` (needs the harness's API keys for the answer model and judge; NSM
itself makes no calls):

```bash
bun bench/run-locomo.ts --system nsm         --split test --run <tag>   # ranked turns, scored at 5/10/20/50
bun bench/run-locomo.ts --system nsm-default --split test --run <tag>   # product defaults (≤3 facts), scored once
bun bench/report-locomo.ts --run <tag>
```

## License

MIT © 2026 Anthony Lee.
