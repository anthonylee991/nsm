# Neuro-Swarm Mesh (`nsm`)

> **A 100% Non-LLM, Biologically-Inspired Agent Memory Architecture**  
> *Sub-2ms associative retrieval combining SQLite FTS5 BM25 with in-memory spreading activation, ant colony pheromone evaporation, and OpenIE extraction.*

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Runtime: Bun](https://img.shields.io/badge/Runtime-Bun-black.svg)](https://bun.sh)
[![Tests](https://img.shields.io/badge/Tests-15%20Passing-brightgreen.svg)]()

---

## Overview

Most AI agent memory frameworks rely heavily on dense vector embeddings and secondary LLM judge rerankers. This creates slow retrieval latencies (>50ms), high inference costs, cold starts, and fuzzy keyword degradation.

**Neuro-Swarm Mesh (NSM)** replaces vector RAG with a deterministic, local-first neurobiological memory mesh:
* **Zero LLMs & Zero Embeddings**: 100% deterministic, local-first execution.
* **Sub-2ms Retrieval Latency**: Traverses in-memory RAM pointers via Collins & Loftus spreading activation.
* **SQLite FTS5 + Hybrid RRF**: Combines BM25 full-text ranking with exact substring matching.
* **Ant Colony Stigmergy**: Reinforces frequently traversed associative synapses ($+\Delta \tau$) while evaporating unused edges over time.
* **Epistemic Authority & Directed Supersession**: First-party verified user assertions automatically supersede conflicting public web claims via directed `:SUPERSEDES` edges without needing an LLM judge.
* **ClausIE v2 OpenIE**: Deconstructs unstructured sentences into SVO/SVC triples, preserving complex lists and quantifiers in under 15 microseconds.
* **Peripheral Attention Engineering (PAE)**: Packages retrieved memories into deterministic, token-efficient prompt slots (<150–250 tokens).

---

## Quickstart

### 1. Installation

```bash
# Clone into your workspace
cd C:\Users\anthonynlee\Desktop\dev\mework\nsm

# Run tests
bun test

# Run performance benchmark
bun run benchmark
```

### 2. Ingesting Text and Querying

```typescript
import { NeuroSwarmMesh } from "@skillvault/nsm";

// Initialize mesh (uses in-memory db or SQLite file path)
const mesh = new NeuroSwarmMesh({ dbPath: "mesh.db" });

// 1. Ingest natural language facts using Zero-LLM OpenIE
mesh.ingestText("I work at DeepCore as a lead distributed systems architect");
mesh.ingestText("I live in Seattle and work remotely");

// 2. Ingest structured invariants and calendar events
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

mesh.ingestNode({
  id: "ev-standup",
  nodeType: "event",
  label: "Team Architecture Review",
  source: "calendar",
  authority: 0.90,
  payload: { date: "Monday", time: "11:30 AM", room: "Studio A" },
  createdAt: Date.now(),
  updatedAt: Date.now(),
});

// 3. Query the mesh
const result = mesh.query("Can I schedule a meeting on Monday morning?", {
  ambientContext: {
    "Local Time": "09:30 AM",
    "Current Day": "Monday",
  },
});

console.log("Top Salient Nodes:", result.salientNodes.map(n => n.node.label));
console.log("PAE Prompt Context:\n", result.paePrompt);
console.log("Retrieval Latency:", result.telemetry.totalDurationMs.toFixed(2), "ms");

mesh.close();
```

---

## Core Components

```
nsm/
├── src/
│   ├── core/
│   │   ├── types.ts              # Universal interfaces & Epistemic Authority tiers
│   │   ├── storage/sqlite.ts     # SQLite FTS5 BM25 + Hybrid RRF engine
│   │   └── graph/adjacency.ts    # RAM Pointer Mesh, Spreading Activation, ACO & PAE
│   ├── extractors/
│   │   ├── clausie_v2.ts         # ClausIE v2 OpenIE grammatical clause extractor
│   │   ├── svo_hearst.ts         # Hearst regex taxonomic patterns
│   │   └── index.ts              # Unified extraction helper
│   ├── integrations/
│   │   ├── types.ts              # Provider interfaces & category definitions
│   │   ├── manager.ts            # Connector registry, config store & sync engine
│   │   └── providers/
│   │       ├── markdown_vault.ts # Obsidian/Logseq local markdown vault scanner
│   │       ├── api_memory.ts     # Remote Cognitive Memory REST client (MemVault/Mem0)
│   │       ├── calendar_feed.ts  # iCal / Recurring schedule block routines
│   │       └── social_signal.ts  # Public profile & affiliation signals
│   ├── mesh.ts                   # Master NeuroSwarmMesh engine facade
│   └── index.ts                  # Public package exports
├── tests/
│   ├── storage.test.ts           # FTS5 BM25, substring and RRF tests
│   ├── graph.test.ts             # Spreading activation and pheromone decay tests
│   ├── extractors.test.ts        # OpenIE clause parsing and list preservation tests
│   ├── authority.test.ts         # Epistemic hierarchy and :SUPERSEDES tests
│   ├── mesh.test.ts              # End-to-end integration and PAE slot tests
│   └── benchmark.test.ts         # Sub-millisecond latency benchmark suite
├── NSM-SPEC.md                   # Full theoretical and technical specification
├── package.json
└── tsconfig.json
```

---

## Benchmarks

```
=======================================================
       NEURO-SWARM MESH (NSM) PERFORMANCE BENCHMARK     
=======================================================
[Storage + Graph Nodes] : 200
[Synaptic RAM Edges]    : 300
[Benchmark Iterations]  : 50
[Avg Query Latency]     : 1.532 ms
[Min Query Latency]     : 1.105 ms
[OpenIE ClausIE v2 Avg] : 10.4 microseconds per sentence
=======================================================
```

---

## License

MIT License. Developed by SkillVault Research & Engineering.
