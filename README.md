# Neuro-Swarm Mesh (`nsm`)

> A local-first agent memory: one SQLite file, BM25 + phrase + substring retrieval, and optional small
> on-device models (a 384-d embedder and a cross-encoder) that run in-process with no network and no key.
> Measured on the LoCoMo benchmark through MemVault's harness: **83.4%** at 50 memories with the local
> models (688 ms), **81.8%** with no model at all (6 ms).

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Runtime: Bun](https://img.shields.io/badge/Runtime-Bun-black.svg)](https://bun.sh)

---

## What it is

NSM is the local branch of the ACM / AKM memory lineage. ACM (MemVault's production memory) needs
Postgres, pgvector, a hosted embedding API and a hosted reranker. NSM asks how close a memory can get
with nothing to install and nothing to pay per query, so it can live inside any agent harness on any
machine.

Two configurations, both measured:

* **No model.** SQLite FTS5 (Porter-stemmed BM25), a phrase leg over adjacent query words and a
  substring leg, fused by reciprocal rank fusion. 6 ms per query at a few thousand memories.
* **Local models.** The same, plus a dense leg from `bge-small-en-v1.5` (384-d) fused into the seeds,
  and a cross-encoder rerank (`ms-marco-MiniLM-L-6-v2`) over the top 50. Both run through ONNX on the
  CPU via `@huggingface/transformers`, an optional dependency; the models download once (~250 MB).
  About 25 ms per memory to ingest, 690 ms per query.

Around retrieval: pinned invariants that are always delivered, lateral inhibition per node type,
visibility filtering inside every retrieval leg, episode-aware ingest, and PAE-slotted output
(`[PINNED INVARIANTS]`, `[SCHEDULE & HORIZON]`, `[USER PROFILE & FACTS]`, `[ACTIVATED MEMORY]`).

The concept graph (clause-extractor objects or term nodes, spreading activation with ACT-R fan damping,
pheromone reinforcement and evaporation) is still in the code behind options. Three designs of it were
measured and none improved retrieval over the lexical seeds, so it is not in the default path.

## Quickstart

```bash
bun install
bun test
```

```typescript
import { NeuroSwarmMesh } from "@skillvault/nsm";

const mesh = new NeuroSwarmMesh({ dbPath: "mesh.db" }); // defaults = the measured no-model configuration

mesh.ingestText("I work at DeepCore as a lead distributed systems architect");
mesh.ingestText("I live in Seattle and work remotely");
mesh.ingestNode({
  id: "inv-focus", nodeType: "invariant", label: "Morning Focus Block", source: "user_invariant",
  authority: 1.0, payload: { rule: "No meetings before 11:00 AM" }, createdAt: Date.now(), updatedAt: Date.now(),
});

const result = mesh.query("Can I schedule a meeting on Monday morning?");
console.log(result.paePrompt);
mesh.close();
```

With the local models (`bun add @huggingface/transformers`):

```typescript
import { NeuroSwarmMesh, LocalEmbedder, LocalReranker } from "@skillvault/nsm";

const mesh = new NeuroSwarmMesh({
  dbPath: "mesh.db",
  neural: { embedder: new LocalEmbedder("Xenova/bge-small-en-v1.5"), reranker: new LocalReranker() },
});
mesh.ingestText("...");            // as before
await mesh.embedPending();          // embeds every memory that has no vector yet
const result = await mesh.queryAsync("...");  // dense leg + rerank
await mesh.closeAsync();
```

Models are cached in `$NSM_MODEL_DIR` or `~/.nsm/models`.

## Layout

```
nsm/
├── src/
│   ├── core/
│   │   ├── types.ts              # node/edge types, authority table, visibility (canSee), query options
│   │   ├── storage/sqlite.ts     # SQLite + FTS5 (porter), BM25 / phrase / substring / dense legs, RRF
│   │   └── graph/adjacency.ts    # in-memory graph: spreading activation, fan damping, inhibition, PAE slots
│   ├── extractors/               # rule-based clause / triple extraction (used by the optional concept graph)
│   ├── neural/
│   │   ├── types.ts              # Embedder / Reranker interfaces (inject your own)
│   │   └── local.ts              # LocalEmbedder / LocalReranker over @huggingface/transformers
│   ├── integrations/             # markdown vault, calendar feed, remote memory API, social signal providers
│   ├── mesh.ts                   # NeuroSwarmMesh: ingestText / ingestNode / query / queryAsync / embedPending
│   └── index.ts
├── tests/                        # 33 unit tests; the neural tests use fake models, no download
└── NSM-SPEC.md                   # design, parameters, and what was measured
```

## Measured

Every number here comes from MemVault's benchmark harness (`skillvault/apps/server/bench`), which runs
NSM on the public LoCoMo dataset with a fixed answer model (DeepSeek V4.1 Flash), a separate judge
(Qwen3.8 Flash) and prompts copied verbatim from Mem0's published harness: the same protocol as every
other system in `bench/RESULTS.md`. Configurations were chosen on the dev split (655 questions) and
confirmed once on the held-out test split (885 questions). Paired comparisons are exact McNemar tests.
Nothing below is typed in.

**Held-out test split, accuracy by number of memories shown to the answer model:**

| Configuration | @5 | @10 | @20 | @50 | Recall p50 |
| :--- | :---: | :---: | :---: | :---: | :---: |
| NSM as first audited (2026-10-13) | 60.5 | 68.1 | 75.0 | 80.3 | 27 ms |
| **No model** (defaults) | 62.3 | 69.4 | 75.5 | 81.8 | 6 ms |
| **Local models** (bge-small + cross-encoder) | **74.8** | **78.8** | **81.5** | **83.4** | 688 ms |
| Plain hosted embedding search (same harness) | 52.0 | 60.6 | 68.5 | 77.1 | 308 ms |
| Mem0 cloud (776 of the questions) | | 75.3 | 81.1 | 85.6 | 468 ms |
| MemVault production (hosted embeddings + reranker + graph) | | 87.3 | | 91.9 | 785 ms |

**Supported by these results**

* With the local models, NSM beats the audited version at every cutoff (p ≤ 1e-3), beats plain embedding
  search by 6–23 points, equals Mem0 cloud's top-50 on the questions both answered (84.1% vs 85.6%,
  p = 0.30) and equals MemVault's pre-October recall at ten memories (78.8% vs 79.0%, p = 0.94). It does
  this with no network, no key and no per-query cost.
* The cross-encoder is the largest single lever: +13 points at 5 memories on dev (p = 2e-14), the same
  size of effect MemVault measured for its hosted reranker.
* Without any model, NSM still beats plain hosted embedding search at every cutoff (p ≤ 2e-3) at 6 ms.

**Not supported by these results**

* Parity with current MemVault: 5.8 points behind its production default at equal tokens and 8.5 behind
  its high-context mode (p ≤ 2e-6). Multi-hop (71.5% vs 87.2%) and open-domain questions carry the gap.
* The no-model improvements on their own: about one point over the audited version, same direction as on
  dev, not significant on test.
* Any contribution from the concept graph (three designs measured, none helped).
* "Fast and accurate" in one configuration: the 6 ms mode is 81.8% / 62.3% (50 / 5 memories), the
  83.4% / 74.8% mode takes 688 ms. The reranker is the price of top-5 accuracy.

The full campaign (24 arms, every change paired against the baseline, including the rejected ones) is in
`skillvault/apps/server/bench/RESULTS.md`.

## Running the benchmark

From `skillvault/apps/server` (the harness needs API keys for the answer model and judge; NSM itself
makes no calls):

```bash
bun bench/run-locomo.ts --system nsm2 --split test --run <tag>                      # no model
bun bench/run-locomo.ts --system nsm2+embedbge+rerank100+seeds100 --split test --run <tag>   # local models
bun bench/report-locomo.ts --run <tag>
```

## License

MIT © 2026 Anthony Lee.
