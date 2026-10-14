# Neuro-Swarm Mesh (NSM)
### A 100% Non-LLM, Biologically-Inspired Agent Memory Architecture

**Design specification**  
*Version 1.0, October 2026. Anthony Lee.*

---

## 1. Abstract & Motivation

Conventional retrieval architectures for AI agents rely almost exclusively on high-dimensional vector embeddings, cosine distance lookups (Vector RAG), or secondary LLM judge rerankers (Graph RAG). In production applications, local edge environments, and real-time decision loops, these models face critical bottlenecks:

1. **Inference Latency & Cold Starts**: Embedding models add 15–80ms of neural network compute per query. Secondary LLM extractors and rerankers inflate retrieval times into multiple seconds.
2. **Loss of Lexical Precision & Hallucinatory Drift**: Dense embeddings frequently struggle with exact keywords, names, numbers, acronyms, and direct negation.
3. **Cloud Dependency & Cost**: Continual embedding generation and vector database SaaS calls introduce non-trivial operating expenses and privacy leakages.
4. **Passive Zombie Rows**: Traditional vector indices store static chunks that never strengthen with successful reuse or fade when obsolete.

The **Neuro-Swarm Mesh (NSM)** is the opposite bet: **a non-LLM, zero-embedding memory architecture** that runs entirely in process (queries take about 1.5 ms at 200 nodes and 10 to 25 ms at about 1,700 nodes; §4). NSM combines:
* **Durable Storage**: SQLite FTS5 with BM25 ranking, prefix tokenization, and Reciprocal Rank Fusion (RRF).
* **RAM Graph Pointer Mesh**: Bidirectional in-memory adjacency lists hydrated on boot, so the graph walk never touches disk.
* **Neurobiological Spreading Activation**: Energy radiation based on the Collins & Loftus semantic network model, weighted by epistemic source authority.
* **Stigmergic Swarm Pheromones**: Ant Colony Optimization (ACO) reinforcing successful associative paths ($+\Delta \tau$) and exponentially evaporating unused synapses ($\tau(t) = \tau_0 e^{-\lambda \Delta t}$).
* **Lateral Inhibition**: Sensory focus mechanisms that eliminate intra-category redundancy and resolve conflicting knowledge claims via directed supersession (`:SUPERSEDES`).
* **Zero-LLM OpenIE Extraction**: ClausIE v2 rule-based grammatical clause deconstruction, SVO/SVC triple decomposition, and quantifier preservation, about 10 µs per sentence (`tests/benchmark.test.ts`).

---

## 2. High-Level System Architecture

```
                               ┌────────────────────────────────────────────────────────┐
                               │                    USER QUERY / TEXT                   │
                               └───────────────────────────┬────────────────────────────┘
                                                           │
                            ┌──────────────────────────────┴──────────────────────────────┐
                            ▼                                                             ▼
              ┌───────────────────────────┐                                 ┌───────────────────────────┐
              │   Zero-LLM OpenIE Core    │                                 │    Lexical Scout Engine   │
              │  (ClausIE v2 + Hearst)    │                                 │   (SQLite FTS5 + BM25)    │
              └─────────────┬─────────────┘                                 └─────────────┬─────────────┘
                            │                                                             │
                            ▼                                                             ▼
              ┌───────────────────────────┐                                 ┌───────────────────────────┐
              │  Relational Quad Tuples   │                                 │  Reciprocal Rank Fusion   │
              │  (Subj, Rel, Obj, Attr)   │                                 │     (RRF Score: BM25+Sub) │
              └─────────────┬─────────────┘                                 └─────────────┬─────────────┘
                            │                                                             │
                            └──────────────────────────────┬──────────────────────────────┘
                                                           │
                                                           ▼
                                            ┌─────────────────────────────┐
                                            │ Candidate Seed Nodes In RAM │
                                            └──────────────┬──────────────┘
                                                           │
                                                           ▼
                                            ┌─────────────────────────────┐
                                            │ In-Memory Adjacency Graph   │
                                            │ • Spreading Activation      │
                                            │ • Epistemic Authority Scale │
                                            └──────────────┬──────────────┘
                                                           │
                                                           ▼
                                            ┌─────────────────────────────┐
                                            │ Lateral Inhibition Core     │
                                            │ • Directed Supersession     │
                                            │ • Slot Conflict Suppression │
                                            │ • Category Capacity Filter  │
                                            └──────────────┬──────────────┘
                                                           │
                                                           ▼
                                            ┌─────────────────────────────┐
                                            │ Peripheral Attention Engine │
                                            │ (PAE Slotting: <150 Tokens) │
                                            └──────────────┬──────────────┘
                                                           │
                                                           ▼
                                            ┌─────────────────────────────┐
                                            │ Ant Colony Reinforcement    │
                                            │ (Pheromone Update + Decay)  │
                                            └─────────────────────────────┘
```

---

## 3. Subsystem Specifications

### 3.1 Durable Storage Layer (SQLite FTS5 & Hybrid RRF)

Durable persistence is maintained in a single-file SQLite database (or `:memory:` during ephemeral execution) using in-process bindings (`bun:sqlite` or `better-sqlite3`):

1. **Entity Table (`nodes`)**: Stores durable node records containing identifier, categorical node type, label, source identifier, serialized JSON payload, epistemic authority weight, and timestamps.
2. **Full-Text Search Index (`nodes_fts`)**: SQLite FTS5 virtual table indexing `label` and searchable content with prefix tokenization (`prefix='2,3'`).
3. **Synaptic Synapse Table (`edges`)**: Relational edge table storing directed connections (`source_id`, `target_id`, `relation`, `weight`, `last_activated`).
4. **Reciprocal Rank Fusion (RRF)**:
   Scout searches combine BM25 rank with substring frequency:
   $$\text{RRF}(d) = \sum_{m \in M} \frac{1}{k + r_m(d)}$$
   where $k = 60$ and $r_m(d)$ is the 1-indexed rank under retrieval method $m$. Final scores are scaled by epistemic source authority:
   $$\text{Score}(d) = \text{RRF}(d) \cdot \left(0.5 + 0.5 \cdot \alpha(d)\right)$$

### 3.2 In-Memory Pointer Mesh (`AdjacencyGraph`)

On initialization, nodes and edges hydrate into RAM as bidirectional adjacency lists:
* `outgoing: Map<string, GraphEdge[]>`
* `incoming: Map<string, GraphEdge[]>`

Graph traversals execute through native memory pointers in **0.005–0.02 milliseconds**, bypassing disk I/O during real-time retrieval loops.

### 3.3 Neurobiological Spreading Activation

Activation energy pulses outward from lexical seed hits across connected synapses according to the Collins & Loftus network model:
$$A_j^{(h)} = \sum_{i \in \mathcal{N}(j)} A_i^{(h-1)} \cdot w_{ij} \cdot (1 - \delta)$$
where:
* $A_i^{(h-1)}$ is the activation energy of node $i$ at hop $h-1$.
* $w_{ij} \in [0.0, 1.0]$ is the synaptic edge weight (pheromone level).
* $\delta = 0.45$ is the decay rate per hop.
* Propagation halts when energy drops below the minimum activation threshold ($\theta = 0.05$).

### 3.4 Epistemic Authority & Directed Supersession

To eliminate knowledge conflicts without calling an LLM arbitrator, NSM establishes explicit epistemic authority tiers:

| Source Identifier | Epistemic Authority ($\alpha$) | Description |
| :--- | :--- | :--- |
| `user_invariant` | 1.00 | Pinned rules, behavioral boundaries, non-negotiables |
| `user_fact` | 1.00 | Direct first-party declarative statements from the user |
| `cloud_mesh` | 0.95 | Verified synchronized second-brain memories (MemVault/Mem0) |
| `calendar` | 0.90 | Structured calendar events and routine schedules |
| `local_notes` | 0.85 | Local markdown documents (Obsidian/Logseq) |
| `ambient_signal` | 0.75 | Localized environment, weather, and timezone baselines |
| `public_scraper` | 0.60 | Inferred or scraped public profile signals |
| `inferred` | 0.50 | Synthetically derived concept associations |

#### Directed Supersession (`:SUPERSEDES`)
When a node with authority $\alpha \ge 0.90$ asserts an attribute (e.g. residence or location), NSM scans existing nodes for lower-authority claims ($\alpha < 0.90$) and automatically injects a directed `:SUPERSEDES` edge:
$$(\text{Node}_{\text{verified}}) \xrightarrow{:SUPERSEDES} (\text{Node}_{\text{unverified}})$$
During lateral inhibition, any node with an incoming `:SUPERSEDES` edge from an equal-or-higher authority entity is immediately suppressed.

### 3.5 Ant Colony Optimization (ACO) & Evaporation

Synaptic pathways behave like ant colony foraging trails:
1. **Reinforcement**: When a pair of nodes are jointly retrieved and active, their mutual edge weight increases:
   $$w_{ij} \leftarrow \min(1.0, w_{ij} + \Delta \tau) \quad (\Delta \tau = 0.15)$$
2. **Exponential Evaporation**: Inactive synapses decay exponentially according to their half-life ($t_{1/2} = 14\text{ days}$):
   $$\tau(t) = \tau(0) \cdot e^{-\lambda \Delta t}, \quad \lambda = \frac{\ln 2}{t_{1/2}}$$

Over time, frequently exercised cognitive connections become associative superhighways, while transient noise naturally fades.

### 3.6 Zero-LLM Information Extraction (ClausIE v2)

Unstructured text is parsed without neural models using rule-based Open Information Extraction:
* **Verb-Gated Conjunction Segmentation**: Conjunctions (`and`, `but`) are split into separate proposition clauses only if followed by an active verb phrase or subject-verb clause. Noun lists (`"peanuts, shellfish, and tree nuts"`) and numeric lists (`"aged 28, 14, and 6"`) are preserved intact.
* **SVO/SVC Decomposition**: Parses clauses into Subject, Verb Phrase, Direct Object, and Adverbial prepositions (`in`, `at`, `for`, `with`, `as`).
* **Quantifier & Attribute Extraction**: Extracts numbers, ages, quantities, and entity categories (`person`, `organization`, `place`, `rule`).
* Execution latency: **10–25 microseconds per sentence**.

### 3.7 Peripheral Attention Engineering (PAE)

The final retrieved context is slotted into a deterministic format. Its size follows the lateral inhibition cap: with the 2026-10-14 default of up to 10 memories per node type it is about 900–1,100 tokens on conversational memories (measured on LoCoMo turns: 3,500–4,400 characters); the earlier cap of 3 gave 150–250 tokens and 55.9% on the test split, which is why it was raised:
```
[AMBIENT CONTEXT]
Location: Metro Area
Weather: 72°F Sunny

[PINNED INVARIANTS]
• [INVARIANT] Morning Deep Work: No meetings before 11 AM

[SCHEDULE & HORIZON]
• Engineering Sync (Monday 11:30 AM)

[USER PROFILE & FACTS]
• I live in City B: residence

[ACTIVATED MEMORY]
• Strategy Roadmap: Q4 deliverables and milestone tracking
```

---

## 4. What has been measured

Every figure below comes from code in this repo or from MemVault's benchmark harness
(`skillvault/apps/server/bench`), run on a developer workstation (Bun 1.4, Windows). Nothing is typed in.

**Unit microbenchmark** (`tests/benchmark.test.ts`, 200 nodes, 300 edges, 50 iterations):

| Metric | Measured |
| :--- | :--- |
| Mean query latency | 1.5 ms |
| Min / max query latency | 1.2 ms / 4.9 ms |
| Clause extraction | 9 µs per sentence |
| Test suite | 15 tests, under 200 ms |

**One LoCoMo conversation through the harness** (system `nsm`, conv-30, no model calls): 369 turns
ingested in 1.2 s into 1,735 nodes (1,366 of them concept nodes) and 1,786 edges; 10 to 25 ms per
query at that size. Latency grows with the store because `query` scans every node for scope detection
and substring matching, and `ingestText` scans every node for conflict resolution on each insert.

**LoCoMo, held-out test split** (885 questions, same answer model, judges and prompts as every system
in `bench/RESULTS.md`; run `nsm-test`):

| Configuration | @5 | @10 | @20 | @50 | Recall p50 |
| :--- | :---: | :---: | :---: | :---: | :---: |
| As first audited, 2026-10-13 (unicode61 BM25 + substring, clause graph, concept nodes indexed) | 60.5 | 68.1 | 75.0 | 80.3 | 27 ms |
| No model, 2026-10-14 defaults (porter BM25 + phrase + substring, concept nodes graph-only) | 62.3 | 69.4 | 75.5 | 81.8 | 6 ms |
| Local models (bge-small-en-v1.5 dense leg, 100 fused seeds, ms-marco-MiniLM-L-6-v2 rerank) | 74.8 | 78.8 | 81.5 | 83.4 | 688 ms |

Both 2026-10-14 configurations were chosen on the dev split and confirmed once on test. The local-model
configuration beats the audited one at every cutoff (p ≤ 1e-3), equals Mem0 cloud's top 50 on the 776
questions both answered (p = 0.30) and MemVault's pre-October recall at ten items (p = 0.94), and is
5.8 points behind MemVault's production default at equal tokens and 8.5 behind its high-context mode
(p ≤ 2e-6). The no-model gains over the audited version are about one point and not significant on
test. The campaign (24 arms, each paired against the baseline) is in `bench/RESULTS.md`.

**The graph adds nothing, in three designs.** With spreading activation off (`nsm-lexical`) test accuracy
is unchanged at every cutoff (80.8% vs 80.3% at 50, p = 0.66). Term nodes (one per distinctive word)
with ACT-R fan damping (§3.3) made no difference at 50 seeds on dev (p ≥ 0.3), and with 20 lexical seeds
the memories the graph added ranked below the lexical seeds they replaced (75.3% vs 76.8% at 50, n.s.).
Two reasons are visible in the code: the clause extractor turns whole clauses into concept nodes ("sorry
about the job the studio sounds great"), so few memories share one; and common words connect to
everything, so activation through them carries no information even when damped.

### 4.2 Measured and rejected (dev split, paired against the baseline)

bm25 label weighting (no effect: the weights had been applied to the unindexed id column); removing the
substring leg (−4 points at 5 items, p = 0.04); episode expansion that inserts the neighbours of the
top 3 hits after them (−4 / −5 points at 5 / 10 items, p < 0.001); the bge-base embedder (+0.5, n.s.,
2.5x slower ingest); bge-reranker-base over 20 candidates, quantised (−3 points at 20 items, p = 0.005,
1.2 s per query; over 50 candidates it takes 3–5 s on this CPU).

### 4.3 Defaults (2026-10-14)

`MeshConfig.storage`: `tokenizer: "porter"`, `phraseLeg: true`, `substringLeg: true`, `prefixMatch: true`,
`labelWeight: 1`. `MeshConfig.graph`: `clausie: true` (nodes exist for PAE and supersession),
`searchableConcepts: false`, `terms: false`. `query()`: 50 lexical seeds, up to 10 memories per node type
after lateral inhibition, 2 hops, no fan damping, no episode expansion. With `neural.embedder` set:
100 fused seeds; with `neural.reranker` set: the top 50 memories reranked. All other options remain
available and off.

### 4.1 Known limits of the current implementation

* Directed supersession (§3.4) is implemented only for residence / location claims whose
  lower-authority source name contains `social`, `scraper` or `feed`. Other attribute conflicts are
  not detected.
* Edge weights are capped at 1.0 by `reinforceEdge`; reinforcement can only restore evaporated weight,
  not grow a trail beyond its initial strength.
* Lateral inhibition caps each node type at 3 by default, so a store where every memory is a `fact`
  returns at most 3 memories unless `lateralInhibitionMaxPerCategory` is raised.
* The `ingestText` default authority is 1.0 for every memory, so the authority weighting in §3.1 and
  §3.3 has no effect on text ingested that way.

---

## 5. Summary

NSM tests whether an agent memory with no model calls at all is good enough to be useful. The
mechanism (BM25 and substring fusion, a concept graph walked by spreading activation, inhibition,
reinforcement and evaporation) is implemented and unit-tested; its speed on small stores is measured;
its accuracy against a real benchmark is the open question, and the harness to answer it is wired up.
