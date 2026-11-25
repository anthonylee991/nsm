# nsm
### A local memory for AI agents: hybrid retrieval, a short-term / long-term lifecycle, PAE-shaped recall

**Design specification**
*Version 3.0, November 2026. Anthony Lee.*

---

## 1. What it is, and what changed in 3.0

`nsm` is one SQLite file that every MCP-speaking agent on a machine reads and writes. It stores what the
user said, finds the right memories for a task with no API calls, and hands them to the agent in labelled
slots. With two small on-device models it matches Mem0's cloud product on LoCoMo (§4).

Versions 1 and 2 were built as the Neuro-Swarm Mesh: a concept graph extracted from every memory by
rule-based OpenIE (ClausIE), walked by spreading activation, sharpened by lateral inhibition, and tuned by
ant-colony pheromone reinforcement and evaporation. That design assumed the swarm would do the retrieval.
It does not: retrieval quality comes from the lexical and dense legs, the rank fusion, and above all a
cross-encoder that re-reads the candidates. Every graph design was measured and none moved accuracy
(§4: spreading activation off, p = 0.66; term nodes, fan damping, n.s.), while the graph made up about 80%
of the stored rows and most of the per-query work. Version 3.0 removes it, with the integrations and
extractors that only fed it, and keeps what the measurements support:

1. **Hybrid retrieval**: BM25, phrase and substring legs, an optional dense leg, rank fusion, an optional
   cross-encoder rerank over a deep pool (§3.2–3.3).
2. **Short-term and long-term memory**: memories decay, are refreshed by being recalled, and fade from
   short-term into long-term instead of being deleted (§3.4).
3. **PAE-shaped recall**: pinned rules, anomaly flags and dated memories in fixed slots (§3.6).

## 2. Architecture

```
 remember(text)                                   recall(query, k)
   │                                                │
   ▼                                                ▼
 ┌──────────────────────────────┐        ┌──────────────────────────────────────────────┐
 │ memories  (SQLite, WAL)      │◄───────┤ legs: BM25 · phrase · substring · [dense]    │
 │  text, dates, episode,       │        │ fusion: reciprocal rank fusion, dense ×2     │
 │  strength, state             │        │ [episode neighbours of the top 10]           │
 │ memories_fts (FTS5, porter)  │        │ [cross-encoder rerank of the top 100]        │
 │ vectors      (optional)      │        └───────────────────────┬──────────────────────┘
 └──────────────────────────────┘                                ▼
            ▲                            ┌──────────────────────────────────────────────┐
            │  reinforce recalled,       │ lifecycle rank: 0.75 relevance + 0.25        │
            └──spread to associates,─────┤ strength (a strong cue reactivates)          │
               daily sweep               └───────────────────────┬──────────────────────┘
                                                                 ▼
                                         [PINNED RULES] [ANOMALY FLAGS] [MEMORIES]
```

Code: `src/db.ts` (storage and legs), `src/retrieval.ts` (the pipeline), `src/app/store.ts` (the product:
lifecycle, prompt), `src/lifecycle/` (pure functions), `src/neural/` (optional local models),
`src/mcp/server.ts`, `bin/nsm.ts`.

## 3. Subsystems

### 3.1 Storage

One table, `memories`: id, text, pinned, source, created and occurred times, episode and ordinal, and the
lifecycle columns (importance, strength as of a time, reinforcement count, last recall, state). An FTS5
index over the text (`porter unicode61`, prefixes of 2 and 3) uses the table as external content, so the
text is stored once. Vectors, when the local embedder is on, sit in `vectors` and are deleted with their
memory. `meta` holds the time of the last sweep.

Several agents share the file, each through its own MCP server process: the database runs in WAL mode
with a busy timeout, and each process drops its in-RAM caches (all memories, lowercased texts, vectors)
when `PRAGMA data_version` shows another connection has committed.

A 2.x database (`nodes`, `edges`, `nodes_fts`, ...) is migrated on first open: memories and pinned rules
keep their ids, dates, strengths, states and vectors; concept nodes, edges, the audit log table and
integration configs are dropped; a snapshot of the old file is kept as `memory.db.v2-backup`.

### 3.2 Retrieval legs and fusion

* **BM25** over the query's content words, OR'd, each prefix-matched.
* **Phrase**: each adjacent query word pair (unless both are stop words) as an FTS phrase.
* **Substring**: memories containing query words anywhere (inside compounds, before stemming), ranked by
  how many they contain. Removing it cost 4 points at 5 memories (§4.2).
* **Dense** (with the embedder): brute-force cosine over unit vectors.

Fusion: $\text{RRF}(d) = \sum_m w_m / (60 + r_m(d))$ with $w = 2$ for the dense leg, 1 for the others,
and the substring leg scaled by $1 + 0.75 \cdot \text{hits}$. Kept: 50 candidates, or 100 with a dense leg.
Pinned rules are never ranked.

### 3.3 Local models (optional)

`bge-small-en-v1.5` (384-d) for the dense leg and `ms-marco-MiniLM-L-6-v2` as a cross-encoder, both
through ONNX on the CPU (`@huggingface/transformers`, an optional dependency; injectable `Embedder` /
`Reranker` interfaces). With them, the memories saved next to the top 10 hits (same episode, ordinal ±1)
join the pool, and the cross-encoder orders the top 100. The reranker's pool was the largest single lever
measured (§4).

### 3.4 Memory lifecycle: short-term, long-term, pinned

From ACM, measured in MemVault and in NSM (§4.3):

| State | What it is | How it behaves |
| :--- | :--- | :--- |
| short-term (`active`) | every new memory | competes on any cue |
| long-term (`archived`) | strength ≤ 0.02 and not recalled for 90 days | kept whole; hidden from `activeOnly` recall and lists; still reached by a direct question; back to short-term when recalled |
| pinned | rules the user marked | delivered on every recall, never decays, never ranked |

Strength $S(t) = S_0 e^{-t/\tau}$, $\tau = 30 (1 + 0.25 \min(B, 20))$ days ($B$ = times recalled: the
savings effect). Recall adds $0.17 \ln 2$; a tenth of that spreads to the top recalled memories' vector
neighbours (cosine ≥ 0.65), and seven hundredths to memories that happened within an hour of them. Final rank: $0.75 \cdot \text{relevance} + 0.25 \cdot S'$, where a
cue of relevance ≥ 0.4 reactivates $S'$ to 1, so decay pushes stale noise down without hiding what is
asked about directly. The sweep runs from `recall` once a day (CLI and MCP server) or on `nsm sweep`.

Long-term memories are not summarised or merged. Measured: deleting faded memories cost 16 points over
180 simulated days while demoting them cost nothing (§4.3); in MemVault, model summaries that replaced
originals cost 7 points, and rewriting notes into typed facts was no better than the raw notes and hurt
dates (§4, markdown arms). The space a summary would save is small next to what 3.0 freed by removing the
graph.

### 3.5 Absence flags

For each of the top 10 recalled memories, its family is the stored memories with word-overlap Jaccard ≥
0.15 (up to 12). A family of ≥ 5 at regular intervals (CV < 1) whose last entry is ≥ 3 median intervals
(and ≥ 4 days) old is flagged once: "nothing about this since <date> (<n> days); it usually comes up about
every <m> days". No model.

### 3.6 Recall slots (PAE)

Peripheral Attention Engineering (github.com/anthonylee991/pae): a model answers better when the context
it gets is sorted into labelled slots about the asker and their situation, with anomalies flagged, than
when it gets a flat list. `nsm` returns:

```
[PINNED RULES]      the user's standing rules (always)
[ANOMALY FLAGS]     routines that went quiet (when any)
[MEMORIES]          • (date it happened) text  [id: ...]   best first
```

The agent harness supplies the asker and the task; `nsm` supplies the user's side.

---

## 4. What has been measured

Every figure below comes from code in this repo or from MemVault's benchmark harness
(`skillvault/apps/server/bench`), run on a developer workstation (Bun 1.4, Windows). Nothing is typed in.
§4–4.3 were measured on 2.x, which still carried the graph; §4.5 checks that 3.0 retrieves the same
evidence.

**One LoCoMo conversation through the 2.x harness** (system `nsm`, conv-30, no model calls): 369 turns
ingested in 1.2 s into 1,735 nodes (1,366 of them concept nodes) and 1,786 edges; 10 to 25 ms per
query at that size. Latency grows with the store because `query` scans every node for scope detection
and substring matching, and `ingestText` scans every node for conflict resolution on each insert.

**LoCoMo, held-out test split** (885 questions, same answer model, judges and prompts as every system
in `bench/RESULTS.md`; run `nsm-test`):

| Configuration | @5 | @10 | @20 | @50 | Recall p50 |
| :--- | :---: | :---: | :---: | :---: | :---: |
| As first audited, 2026-10-13 (unicode61 BM25 + substring, clause graph, concept nodes indexed) | 60.5 | 68.1 | 75.0 | 80.3 | 27 ms |
| No model, 2026-10-14 defaults (porter BM25 + phrase + substring, concept nodes graph-only) | 62.3 | 69.4 | 75.5 | 81.8 | 6 ms |
| Local models, morning release (bge-small-en-v1.5 dense leg, 100 fused seeds, rerank over 50) | 74.8 | 78.8 | 81.5 | 83.4 | 688 ms |
| Local models, defaults (dense leg at weight 2, inhibition cap 100, neighbours of the top 10 hits in the pool, rerank over 100) | 76.5 | 81.8 | 84.6 | 87.1 | 1,290 ms |

Every 2026-10-14 configuration was chosen on the dev split and confirmed once on test. The default
local-model configuration beats the morning release at every cutoff (p ≤ 0.02) and the audited version by
16 points at 5 memories; on the 776 questions both answered it scores 86.9% against Mem0 cloud's top-50
85.6% (p = 0.32); it is 2.7 points behind MemVault's production default at equal tokens (p = 0.014) and
4.8 behind its high-context mode (p = 1e-6). The gain came from the reranker's pool: multi-hop questions
had all their evidence among the 50 memories 36% of the time with a 50-candidate pool and 43% with 100
candidates plus episode neighbours and a double-weight dense leg. The no-model gains over the audited
version are about one point and not significant on test. The campaign (27 retrieval arms, each paired
against its control) is in `bench/RESULTS.md`.

**Markdown files + grep, same split (run `test-markdown`, 2026-10-15; system `md-grep` in the harness).**
One markdown file per session, one dated bullet per turn, retrieval by case-insensitive substring match of
the question's content words (speaker names excluded), no index, no model, 0 ms recall. Lines ranked by
how many query words they contain: 61.1 / 68.6 / 74.2 / 78.5 at 5/10/20/50, equal to the no-model `nsm`
at 5/10/20 (n.s.) and 3.3 behind at 50 (p = 4e-3). The same hits in plain grep order: 26.9 / 37.6 / 48.9 /
63.6 (15 to 34 points worse, p < 1e-28). Whole session files, 1/2/3/5 files: 63.4 / 75.0 / 78.1 / 83.2 at
1,095 to 5,116 tokens; 5 files equals Mem0 top-50 (n.s.), is behind the local-model `nsm` (p = 3e-3) and
MemVault high-context (p = 3e-13). Multi-hop is where every markdown arm loses (56 to 57% vs 71.5% for
local-model `nsm`). What this says about `nsm`: its no-model lexical stack is roughly a ranked grep with
stemming, phrase and substring legs, worth about three points at 50; the on-device models are what
separate it from plain files. A model pass that rewrites notes into typed fact files with aliases (the step
reported for Instinct) was reconstructed and measured on 2026-10-16: 59.1 / 66.2 / 71.5 / 77.4 as ranked
lines, equal to the raw notes (n.s.), 73.3 as five whole fact files (10 behind whole raw sessions, p = 4e-11);
it helps multi-hop (names on every fact) and hurts temporal (rewritten dates). Extraction cost $0.10.

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

### 4.3 Lifecycle and absence (measured 2026-10-14)

The product layer (`src/app/store.ts`) carries ACM's lifecycle as pure functions (`src/lifecycle`), as in §3.4:
strength `S(t) = S0 · exp(−t/τ)` with `τ = 30 · (1 + 0.25 · min(boosts, 20))` days, reinforcement on
recall `S += 0.17 · ln(1 + n)`, spreading of a tenth of that to same-hour memories (or vector neighbours
at cosine ≥ 0.65), rank score `0.75 · relevance + 0.25 · S'` where a cue with relevance ≥ 0.4 reactivates
`S'` to 1, and forgetting by demotion (strength ≤ 0.02 and no recall for 90 days → archived; still a
candidate; recall reactivates). Absence flags: for each of the top 10 recalled memories, its family is the
memories with word-overlap Jaccard ≥ 0.15 (up to 12); a family of ≥ 5 at regular intervals (CV < 1) whose
last entry is ≥ 3 median intervals (and ≥ 4 days) ago is flagged.

Measured through the MemVault harness (`bench/nsm-lifecycle-sim.ts`, `bench/run-surprisal.ts`):

| Test | Result |
| :--- | :--- |
| 180 simulated days, LoCoMo dev, never-asked questions @10 | fresh 63.8%, demote 63.8% (identical answers), delete 47.6% (p = 5e-9) |
| Evidence still competing after 180 days | demote 69.6%, demote without spreading 58.8%, delete 61.2% (and 39% gone for good) |
| Absence flags, test split | 50% of stopped routines flagged, 1 of 26 continuing routines falsely flagged |
| Answers noticing a stopped routine, test | 50.0% with flags vs 9.1% without (9 vs 0 discordant, p = 0.004); false alarms unchanged |

Not in NSM: surprisal flags for an entry that breaks its routine's pattern, which need a model judge.
Cosine families from the local embedder flagged fewer stopped routines than word overlap at every floor
(best 50% vs 65% on dev) and are off by default.

### 4.4 Defaults (3.0)

Without models: BM25 (Porter, prefix) + phrase + substring legs, RRF k = 60, 50 candidates; the store ranks
a pool of max(3k, 20) by the lifecycle score and returns k (default 10). With models: the dense leg at
weight 2 over as many hits as candidates (100), the episode neighbours (radius 1) of the top 10 hits, the
cross-encoder over the top 100. These are the 2026-10-14 configurations confirmed on test, with one
correction: 2.x's store fused only 16 dense hits (a fallback meant for an unset option), not the 100 the
benchmark measured; 3.0 uses 100 in the product too.

### 4.5 3.0 against 2.1: same evidence, less work

Measured 2026-11-25 without answer-model or judge calls: each LoCoMo test conversation ingested as the
harness does, the top 50 retrieved per question (885 questions), and the rank of every evidence turn
recorded, for 2.1 (commit 6352ec4) and 3.0. "All evidence" = every evidence turn of the question within
the cutoff; paired exact McNemar.

| All evidence within k | @5 | @10 | @20 | @50 |
| :--- | :---: | :---: | :---: | :---: |
| No model, 2.1 | 46.7 | 54.0 | 60.5 | 67.3 |
| No model, 3.0 | 47.2 | 53.9 | 60.9 | 67.8 |
| On-device models, 2.1 | 63.2 | 69.8 | 73.4 | 78.5 |
| On-device models, 3.0 | 63.5 | 70.4 | 73.8 | 79.7 |

No difference is significant (no model p ≥ 0.23; models p ≥ 0.11, 21 questions gained and 11 lost at
50). The answer-model scores of §4 therefore carry over; they were not re-run.

Cost, through `MemoryStore` (no model, reinforcement and absence flags on), after remembering all 5,882
LoCoMo turns, 200 recalls:

| | 2.1 | 3.0 |
| :--- | :---: | :---: |
| remember, per memory | 92.5 ms | 0.9 ms |
| recall p50 / p95 | 1,393 / 2,104 ms | 30 / 55 ms |
| database file | 23.2 MB | 3.2 MB |
| recall with models, p50 (one conversation, 152 questions) | 1,629 ms | 1,333 ms |

Where 2.1's time went: every write re-parsed every stored row (the dedupe check and the episode ordinal
scanned a cache the write had just dropped), and every recall tokenised every memory again for the
absence-flag families. 3.0 answers those from SQL and keeps word sets and a word index between recalls;
the flags are identical (200 of 200 recalls checked against the reference implementation).

---

## 5. Removed in 3.0

| Removed | Why |
| :--- | :--- |
| Concept graph: ClausIE / SVO-Hearst extraction, concept and term nodes, edges, spreading activation, fan damping | No effect on accuracy in three designs (§4); 80% of stored rows; extraction on every write and a walk on every read |
| Ant-colony reinforcement and pheromone evaporation | A no-op in practice: each query reinforced the edge between its top two results, and edges only ever ran from a memory to a concept, never between two memories; evaporation was never called by the product |
| Lateral inhibition | Its per-type cap was a top-N cut; its supersession only fired for `social` / `scraper` / `feed` sources that only the integrations wrote |
| Directed supersession and epistemic authority | Every memory is first-party at authority 1.0, so the weighting was a no-op (2.x §4.1); "what is true now" is better served by dates on every memory and the newest dated statement winning (MemVault's LongMemEval result) |
| Focus hysteresis, scope and visibility gates | Never set by the store, CLI or MCP server; scanned every memory on every query |
| Integrations (markdown vault, calendar feed, social signal, remote API) | Not wired to any surface; opened a second connection to the database on every start; would have kept a bearer token in plain text |
| `[AMBIENT CONTEXT]` / `[SCHEDULE]` / `[USER PROFILE]` slot formatter in the graph | The store never used it; `formatPrompt` is the one prompt |
| Audit-log table | Written by nothing |
