# nsm: a memory your AI agents keep on your own machine

Your coding agent forgets everything between sessions. Tell Claude Code your deploy target on Monday
and Cursor asks you again on Tuesday. `nsm` fixes that with one file on your disk: every agent that
speaks MCP (Claude Code, Cursor, Codex, Windsurf, Cline and the rest) reads and writes the same memory,
nothing leaves your computer, and there is no account and no bill.

It is also measured. On LoCoMo, the standard long-conversation memory benchmark, run through the same
harness and judges as commercial memory products, `nsm` with its optional on-device models matches
Mem0's cloud product on the questions both answered, and with no model at all it still beats plain
embedding search. The numbers and the things that did not work are further down.

---

## Install (two minutes)

You need `curl` and a terminal. The installer puts everything under `~/.nsm` and installs the Bun
runtime if you do not have it.

```bash
curl -fsSL https://raw.githubusercontent.com/anthonylee991/nsm/main/install.sh | sh
```

Then tell your agent where the memory is. One line per tool:

| Tool | Do this |
| :--- | :--- |
| Claude Code | `claude mcp add nsm -- nsm serve` |
| Cursor | `nsm setup cursor` prints the JSON to paste into `.cursor/mcp.json` |
| Codex | `nsm setup codex` prints the lines for `~/.codex/config.toml` |
| Anything else that speaks MCP | command `nsm`, args `serve`, transport stdio (`nsm setup generic`) |

Check it works:

```bash
nsm doctor
```

That is the whole setup. From now on your agent has two new tools, `nsm_recall` and `nsm_remember`,
and their descriptions tell it when to use them: recall at the start of a task, remember when you state
a preference, a rule or a decision.

### Optional: better recall with on-device models

```bash
nsm models install      # about 250 MB, downloaded once
```

This adds a small embedding model and a reranker that run on your CPU. Recall goes from about 6 ms to
about 1.3 s per question and gets noticeably better at questions that do not share words with the
memory (see the numbers below). `nsm models off` switches back.

## Using it yourself

```bash
nsm remember "We deploy to Railway, not Fly"            # a memory
nsm remember "Always use bun, never npm" --pin           # a rule: delivered on every recall
nsm recall "where do we deploy?"                         # what do I know about ...
nsm list --pinned
nsm forget <id>                                          # ids are shown by recall and list
nsm stats
```

Recall output is ready to paste into a prompt:

```
[PINNED RULES]
• Always use bun, never npm

[MEMORIES]
• (2026-10-14) We deploy to Railway, not Fly  [id: fact-1791963639945-izgja]
```

Everything lives in `~/.nsm/memory.db` (one SQLite file; copy it to move your memory to another
machine). Override the location with `NSM_HOME`.

## What is inside

* **Storage**: SQLite with an FTS5 index (Porter-stemmed BM25), a phrase leg and a substring leg
  fused by reciprocal rank fusion. Visibility filtering happens inside every leg.
* **Pinned rules**: memories marked `--pin` are delivered on every recall, matched or not.
* **A lifecycle, from ACM**: every memory has a strength that decays over about 90 days and is
  reinforced when recalled (and a little when its neighbours are). `nsm sweep` archives memories that
  have faded and gone unrecalled for 90 days; they stop competing on weak cues but a direct question
  still reaches them and brings them back. Nothing is deleted unless you ask.
* **Absence flags**: when a routine you kept mentioning on a regular rhythm has gone quiet, recall says
  so in an `[ANOMALY FLAGS]` slot above the memories, with no model involved.
* **Optional local models**: `bge-small-en-v1.5` for a dense leg (384-d, fused into the seeds at double
  weight) and `ms-marco-MiniLM-L-6-v2` as a cross-encoder over the top 100 candidates plus the memories
  saved around the top hits. Both run through ONNX via `@huggingface/transformers`, an optional
  dependency. `rerankCandidates: 50` halves recall latency at the accuracy of the previous release.
* **A graph you can turn on**: concept and term nodes, spreading activation with ACT-R fan damping,
  reinforcement and evaporation. It is off by default because, in three designs, it did not improve
  retrieval (below).
* **Library API** for your own programs: `NeuroSwarmMesh` (`src/mesh.ts`), with injectable
  `Embedder` / `Reranker` interfaces so you can bring other models.

```typescript
import { NeuroSwarmMesh } from "@skillvault/nsm";
const mesh = new NeuroSwarmMesh({ dbPath: "mesh.db" });
mesh.ingestText("I live in Seattle and work remotely");
console.log(mesh.query("where do I live?").paePrompt);
```

## Measured

Every number comes from MemVault's benchmark harness (`skillvault/apps/server/bench`), which runs
`nsm` on the public LoCoMo dataset with a fixed answer model (DeepSeek V4.1 Flash), a separate judge
(Qwen3.8 Flash) and prompts copied verbatim from Mem0's published harness: the same protocol as every
system in that repository's `bench/RESULTS.md`. Configurations were chosen on a dev split and confirmed
once on the held-out test split (885 questions). Comparisons are paired exact McNemar tests. Nothing is
typed in.

| Configuration (test split) | 5 memories | 10 | 20 | 50 | Recall p50 |
| :--- | :---: | :---: | :---: | :---: | :---: |
| `nsm`, no model (defaults) | 62.3 | 69.4 | 75.5 | 81.8 | 6 ms |
| `nsm`, on-device models (defaults) | **76.5** | **81.8** | **84.6** | **87.1** | 1,290 ms |
| `nsm`, on-device models, 2026-10-14 morning release (reranker over 50) | 74.8 | 78.8 | 81.5 | 83.4 | 688 ms |
| Plain hosted embedding search | 52.0 | 60.6 | 68.5 | 77.1 | 308 ms |
| Markdown files + grep, hits ranked by query-word count | 61.1 | 68.6 | 74.2 | 78.5 | 0 ms |
| Markdown files + grep, plain grep output order | 26.9 | 37.6 | 48.9 | 63.6 | 0 ms |
| Markdown files + grep, whole session files (1 / 2 / 3 / 5 files) | 63.4 | 75.0 | 78.1 | 83.2 | 0 ms |
| Markdown files + grep, notes rewritten into typed fact files by a model (lines) | 59.1 | 66.2 | 71.5 | 77.4 | 0 ms |
| Mem0 cloud (776 of the questions) | | 75.3 | 81.1 | 85.6 | 468 ms |
| MemVault production (hosted embeddings + reranker + graph) | | 87.3 | | 91.9 | 785 ms |

**What this supports.** With the on-device models, `nsm` scores 86.9% against Mem0 cloud's top-50
85.6% on the questions both answered (p = 0.32, not a significant difference) and beats plain embedding
search at every size by 10 to 24 points. The cross-encoder is the largest single lever (+13 points at
5 memories, p = 2e-14); letting it judge 100 candidates plus the memories saved around the top hits,
with the dense leg at double weight, added the last 3.7 points (p ≤ 0.02 at every cutoff on test).
With no model, `nsm` still beats hosted embedding search at every size at 6 ms.

**Against plain markdown files and grep** (the pattern many agents and 2026 blog posts use: one note
file per session, retrieval by case-insensitive word match, no index, no model; measured 2026-10-15,
same split): grep works only if its hits are sorted. Ranking matching lines by how many query words
they contain is statistically equal to `nsm` with no model at 5, 10 and 20 memories (n.s.) and 3.3
points behind at 50 (p = 4e-3); the same hits in grep's own output order are 15 to 34 points worse
(p < 1e-28). Reading the five best-matching whole files reaches 83.2% at 5,116 context tokens, equal to
Mem0 cloud top-50 (n.s.) and 3.9 behind `nsm` with on-device models (p = 3e-3). Every markdown arm is
behind every model-backed system on multi-hop questions (57% vs 72 to 80%). The extra step reported for
Instinct, a model pass that rewrites notes into typed fact files with alias keywords, was reconstructed and
measured too: no better than the raw notes with ranked grep at any size (n.s.), and whole fact files are 10
points behind whole raw sessions. Tidying the notes is not where the gain is; the second model that re-reads
candidates is.

**What it does not support.** Parity with current MemVault: 2.7 points behind its production default at
equal tokens (p = 0.014), 4.8 behind its high-context mode (p = 1e-6), mostly on multi-hop and paraphrase
questions; Mem0 at its 200-memory, 6,771-token setting is also ahead (89.9%, p = 0.006). Any
contribution from the graph: clause-extractor concepts, term nodes and fan damping were each measured and
none helped. Fast and accurate in one setting: 6 ms gets you the first row, 1.3 s the second.

**Lifecycle, 180 simulated days** (LoCoMo dev, half the questions asked along the way, daily sweep):
never-asked questions are answered at 63.8% on a fresh store, 63.8% with forgetting by demotion (identical
answers), and 47.6% with forgetting by deletion (p = 5e-9). Archiving instead of deleting costs nothing.

**Absence flags** (held-out test split of the synthetic routine dataset): the no-model detector flags 50%
of routines that stopped, with one false flag in 26 continuing routines, and the agent notices the stopped
routine in 50.0% of answers with the flag against 9.1% without (p = 0.004), with no rise in invented
anomalies. MemVault's hosted embedding detector reaches 54.5% against 4.5% on the same questions.

The full campaign, 27 retrieval arms including label weighting, a graph in three designs and a larger
reranker that were measured and rejected, plus the lifecycle and absence runs, is in `bench/RESULTS.md`;
the design is in [NSM-SPEC.md](NSM-SPEC.md).

## Development

```bash
bun install
bun test                 # 49 tests; the model tests use fakes, no download
bun run cli -- doctor
```

Benchmark (from `skillvault/apps/server`, needs the harness's API keys; `nsm` itself makes no calls):

```bash
bun bench/run-locomo.ts --system nsm2 --split test --run <tag>                              # no model
bun bench/run-locomo.ts --system nsm2+embedbge+rerank --split test --run <tag>              # on-device models, library defaults
bun bench/report-locomo.ts --run <tag>
```

## License

MIT © 2026 Anthony Lee.
