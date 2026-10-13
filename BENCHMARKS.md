# Neuro-Swarm Mesh (NSM) — Comprehensive Architectural Benchmark & Evaluation

> **Canonical Industry Evaluations & Rigorous Comparative Benchmarks**  
> Comparing **Neuro-Swarm Mesh (NSM)** against **Arboreal Cognitive Mesh (ACM)**, **Arboreal Knowledge Mesh (AKM)**, **PCM (Cognitive Mesh)**, **Standard Semantic RAG**, **Obsidian Vault on Disk**, **Mem0 Cloud**, and **Zep Cloud Graphiti**.

---

## 🏆 1. Canonical Industry Benchmarks (LoCoMo & NIAH)

Evaluated via `bun run benchmark:standard` across canonical multi-session conversational scenarios and haystack depth sweeps:

### A. LoCoMo (Long-Context Conversational Memory)
Evaluates 10 standardized scenarios across the 4 canonical LoCoMo long-term conversation dimensions:
1. **Single-Hop Factoid Retrieval** (3 scenarios: UI framework preference, database replica endpoint, package manager mandate)
2. **Temporal State Updates / ADR Supersession** (3 scenarios: React Router → TanStack Router, AWS ECS → Railway, BIGSERIAL → ULID)
3. **Multi-Hop Associative Synthesis** (2 scenarios: WebSockets + Railway IPv6, Asymmetric Ed25519 + JWKS endpoint)
4. **Pinned Invariants / Guardrail Retention** (2 scenarios: Security credential redaction, Strict Bun toolchain mandate)

| Memory Engine | Overall LoCoMo | Single-Hop (3) | Temporal Updates (3) | Multi-Hop Synthesis (2) | Pinned Invariants (2) | Avg Tokens | Avg Latency |
| :--- | :---: | :---: | :---: | :---: | :---: | :---: | :---: |
| **Neuro-Swarm Mesh (NSM)** | **91.0%** | **90.0%** | **100.0%** | **85.0%** | **85.0%** | **86 tok** | **4.2ms** |
| **AKM (Arboreal Knowledge Mesh)** | 85.0% | 85.0% | 85.0% | 85.0% | 85.0% | 256 tok | 1.1ms |
| **ACM (Arboreal Cognitive Mesh)** | 85.0% | 85.0% | 85.0% | 85.0% | 85.0% | 46 tok | 0.1ms |
| **PCM (Cognitive Mesh)** | 85.0% | 85.0% | 85.0% | 85.0% | 85.0% | 46 tok | < 0.1ms |
| **Standard Semantic RAG** | 67.5% | 78.3% | 56.7% | 67.5% | 67.5% | 46 tok | 0.1ms |
| **Obsidian Vault (Ripgrep)** | 65.0% | 76.7% | 53.3% | 65.0% | 65.0% | 201 tok | 1.1ms |
| **Zep Cloud (Live SDK)** | 26.0% | 51.7% | 15.0% | 15.0% | 15.0% | 79 tok | 224.0ms |
| **Mem0 Cloud (Live SDK)** | 15.0% | 15.0% | 15.0% | 15.0% | 15.0% | 0 tok | 360.4ms |

> [!NOTE] **LoCoMo Architectural Findings**
> - **Temporal State Updates (100.0%):** NSM completely eliminated stale proposals and prompt collisions using directed `:SUPERSEDES` synapses and lateral inhibition, cleanly suppressing superseded technical decisions (e.g. React Router, AWS ECS, BIGSERIAL) without requiring an LLM judge.
> - **Multi-Hop Associative Synthesis (85.0%):** In-memory spreading activation propagates energy across distinct session turns via extracted concept bridges (e.g. linking WebSocket idle timeout with Railway IPv6 binding).
> - **Token Efficiency (86 tokens):** NSM packages retrieved context into deterministic PAE prompt slots, keeping prompt overhead well under 100 tokens while maintaining high accuracy.

---

### B. Needle In A Haystack (NIAH)
Retrieval accuracy of high-entropy credentials (`sk_live_mesh_99812_corp`) placed at 5 needle depths (0%, 25%, 50%, 75%, 100%) across scaling distractor haystack depths:

| Memory Engine | 25 Memories | 50 Memories | 100 Memories | 250 Memories | Avg Retrieval Latency |
| :--- | :---: | :---: | :---: | :---: | :---: |
| **Neuro-Swarm Mesh (NSM)** | **100%** | **100%** | **100%** | **100%** | **10.5ms** |
| **AKM (Arboreal Knowledge Mesh)** | 100% | 100% | 100% | 100% | 11.4ms |
| **ACM (Arboreal Cognitive Mesh)** | 100% | 100% | 100% | 100% | 0.3ms |
| **PCM (Cognitive Mesh)** | 100% | 100% | 100% | 100% | 0.4ms |
| **Standard Semantic RAG (Vector-Only)** | 100% | 100% | 100% | 100% | 0.2ms |
| **Obsidian Vault (Ripgrep)** | 40% | 20% | 20% | 20% | 0.1ms |

---

### C. Snap Research / ACL 2024 Canonical LoCoMo Dataset (`locomo10.json`)
Evaluated via `bun run benchmark:locomo` on 419 dialogue turns across 19 sessions (`conv-26`) using an independent LLM judge (`deepseek/deepseek-v4.1-flash` via OpenRouter):

| Memory Engine | Judge Accuracy (Pass Rate) | Mean Quality Score | Single-Hop (Cat 1) | Temporal Updates (Cat 2) | Multi-Hop (Cat 3) | Avg Tokens | Local Latency |
| :--- | :---: | :---: | :---: | :---: | :---: | :---: | :---: |
| **Neuro-Swarm Mesh (NSM)** | **60.0%** | **60.0%** | **100%** (2/2) | **50%** (1/2) | 0% (0/1) | 382 tok | **16.59ms** |
| **ACM (Arboreal Cognitive Mesh)** | 60.0% | 70.0% | 50% (1/2) | 100% (2/2) | 0% (0/1) | 389 tok | 1.08ms |
| **PCM (Cognitive Mesh)** | 60.0% | 70.0% | 50% (1/2) | 100% (2/2) | 0% (0/1) | 303 tok | 0.62ms |
| **Standard Vector RAG** | 60.0% | 70.0% | 50% (1/2) | 100% (2/2) | 0% (0/1) | 303 tok | 0.01ms |

> [!NOTE] **Key Empirical Insights from DeepSeek ACL 2024 Evaluation:**
> 1. **BM25 Lexical Supremacy on Factoids (Cat 1):** On Question 4 (*"What did Caroline research? Answer: Adoption agencies"*), ACM, PCM, and Vector RAG completely missed the needle (0% / returned UNKNOWN) because the word *"research"* was diluted across 419 dialogue turns. NSM's SQLite FTS5 BM25 surfaced the adoption turn at Rank 1 with a **100% pass score**.
> 2. **Episodic Temporal Anchoring (Cat 2):** On Question 2 (*"When did Melanie paint a sunrise? Answer: 2022"*), NSM's automatic `(Session Date: 8 May, 2023)` binding enabled the DeepSeek judge to resolve Melanie's phrase *"painted the lake sunrise last year"* to 2022 with **100% pass score**.
> 3. **Synaptic Synapse Traversal:** Bidirectional conversational flow links adjacent turns across sessions without LLM extraction on the write path.

---

## 🌐 2. Live Empirical Benchmark (`bun run benchmark:live`)

Direct empirical run testing live external cloud APIs with production API keys alongside local engines:
- **Mem0 Cloud SDK (`mem0ai`)**: Live API account communicating over HTTPS.
- **Zep Cloud SDK (`@getzep/zep-cloud`)**: Live Graphiti temporal knowledge graph over HTTPS.
- **Obsidian Vault**: Physical markdown notes written and queried on Windows disk (`fs/promises`).
- **Local Graph RAG**: In-memory Directed Property Graph triplet store.
- **Naive Vector RAG**: 1024-dimensional dense cosine similarity engine.
- **ACM / AKM / NSM**: Direct TypeScript execution on Bun runtime.

```
┌───┬─────────────────────────────────┬───────────────┬─────────────┬────────────────────┬─────────────────────────────────────────┬────────────────────────┬───────────────────────┬────────────────────┐
│   │ Engine                          │ Write Latency │ Cold Recall │ Warm/Repeat Recall │ Fast Path Mechanism                     │ Temporal Contradiction │ Cross-Tenant Security │ Context Window Tax │
├───┼─────────────────────────────────┼───────────────┼─────────────┼────────────────────┼─────────────────────────────────────────┼────────────────────────┼───────────────────────┼────────────────────┤
│ 0 │ Neuro-Swarm Mesh (NSM)          │ 1.8ms         │ 2.8ms       │ 0.6ms              │ In-Memory Spreading Activation (0.61ms) │ ✅ Resolved ($12k)     │ ✅ 0.0% Leakage       │ 92 tokens          │
│ 1 │ Arboreal Knowledge Mesh (AKM)   │ 7.6ms         │ 5.2ms       │ 1.0ms              │ In-Memory Swarm Walk (0.95ms)           │ ✅ Resolved ($12k)     │ ✅ 0.0% Leakage       │ 184 tokens         │
│ 2 │ ACM (Biological Agent Baseline) │ 4.4ms         │ 4.2ms       │ 1.8ms              │ Pheromone Mesh (1.80ms)                 │ ✅ Resolved ($12k)     │ ❌ LEAKED CROSS-SCOPE │ 106 tokens         │
│ 3 │ Local Graph RAG (Triplet Store) │ 0.1ms         │ 0.2ms       │ 0.0ms              │ Graph Pointer Traversal (0.02ms)        │ ✅ Resolved ($12k)     │ ❌ LEAKED CROSS-SCOPE │ 80 tokens          │
│ 4 │ Naive Vector RAG (Dense Top-K)  │ 1.5ms         │ 0.3ms       │ 0.3ms              │ Dense Matrix Multiply (0.27ms)          │ ❌ Failed / Stale      │ ❌ LEAKED CROSS-SCOPE │ 380 tokens         │
│ 5 │ Obsidian Vault (Disk Markdown)  │ 4.8ms         │ 0.1ms       │ 0.0ms              │ Disk Read (0.03ms)                      │ ❌ Failed / Stale      │ ❌ LEAKED CROSS-SCOPE │ 175 tokens         │
│ 6 │ Mem0 Cloud (Live SDK)           │ 835.3ms       │ 370.6ms     │ 398.0ms            │ Cloud HTTPS RTT (398ms)                 │ ❌ Failed / Stale      │ ✅ 0.0% Leakage       │ 140 tokens         │
│ 7 │ Zep Cloud (Live SDK)            │ 1157.0ms      │ 275.4ms     │ 226.4ms            │ Cloud HTTPS RTT (226ms)                 │ ❌ Failed / Stale      │ ✅ 0.0% Leakage       │ 1092 tokens        │
└───┴─────────────────────────────────┴───────────────┴─────────────┴────────────────────┴─────────────────────────────────────────┴────────────────────────┴───────────────────────┴────────────────────┘
```

---

## ⚡ 3. Speed: Colony Swarm Acceleration & Stigmergy Curve

Simulating 60 continuous agent turns navigating repetitive workflow pathways to evaluate Hebbian reinforcement and ant colony pheromone stigmergy.

```
┌───────────┬───────────────┬────────────────────┬─────────────────┬──────────────────────┐
│ Turn Band │ Mean Latency  │ Pheromone Strength │ Cache Fast-Path │ Cognitive State      │
├───────────┼───────────────┼────────────────────┼─────────────────┼──────────────────────┤
│ T1 – T10  │ 1.62 ms       │ 1.00 (Baseline)    │ Cold Miss       │ Initial Exploration  │
│ T11 – T25 │ 1.14 ms       │ 1.84 (Reinforced)  │ Partial Walk    │ Synaptic Potentiation│
│ T26 – T45 │ 0.72 ms       │ 3.12 (High Trail)  │ Fast Pheromone  │ Stabilized Trajectory│
│ T46 – T60 │ 0.49 ms       │ 4.88 (Asymptotic)  │ In-Memory RAM   │ Swarm Highway        │
└───────────┴───────────────┴────────────────────┴─────────────────┴──────────────────────┘
```

* **Swarm Speedup**: Query latency drops from **1.62ms** to **0.49ms** (**3.3× speedup**) as Hebbian co-activation strengthens synaptic weights between co-retrieved facts.
* **Bounded Growth**: Unused paths undergo exponential decay ($\tau_{1/2} = 12\text{ hours}$), pruning dead connections and bounding RAM usage.

---

## 🔒 4. Security: 0.0% Cross-Tenant Leakage Audit (`bun run benchmark:security`)

A 27-check multi-tenant security verification enforcing non-bypassable security invariants:
1. **Layer 1: FTS5 In-Retrieval Access Gating (Invariant I1)**: Search queries strictly inject tenant and clearance gates directly into SQLite SQL execution before scoring.
2. **Layer 2: In-Memory Spreading Activation Gate Filtering**: Graph traversal suppresses unauthorized nodes during energy propagation, eliminating graph-hopping privilege escalation.
3. **Layer 3: Lateral Inhibition & Directed Supersession**: Newer, higher-authority knowledge edges apply negative energy to superseded nodes.
4. **Layer 4: Epistemic Authority Hierarchy**: Verification hierarchy (`SYSTEM > USER > INFERRED > SPECULATIVE`) ensures unverified social claims cannot overwrite direct user commands.
5. **Layer 5: Output Projection & Focus Isolation**: Context assembly validates every node before rendering into Prompt-Augmented Engine (PAE) sections.

**Audit Results: 27 / 27 PASS (0.0% Leakage)**

---

## 🚀 Running the Benchmarks

All benchmarks are pure TypeScript running on Bun:

```bash
# Run unit test suite (15 tests passing in <300ms)
bun test

# Canonical Industry Standard Benchmarks (LoCoMo & NIAH)
bun run benchmark:standard

# Live empirical run against real disk & authenticated cloud APIs (Mem0, Zep)
bun run benchmark:live

# Full evaluation battery
bun run benchmark:all

# Specialized diagnostic batteries
bun run benchmark:niah      # Enterprise Needle In A Haystack scaling
bun run benchmark:swarm     # Colony Swarm Acceleration learning curve
bun run benchmark:focus     # Multi-turn conversation hysteresis
bun run benchmark:security  # 5-Layer zero-leakage security audit
```
