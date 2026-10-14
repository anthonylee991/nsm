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
about 700 ms per question and gets noticeably better at questions that do not share words with the
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
* **Optional local models**: `bge-small-en-v1.5` for a dense leg (384-d, fused into the seeds) and
  `ms-marco-MiniLM-L-6-v2` as a cross-encoder over the top 50. Both run through ONNX via
  `@huggingface/transformers`, an optional dependency.
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
| `nsm`, on-device models | **74.8** | **78.8** | **81.5** | **83.4** | 688 ms |
| Plain hosted embedding search | 52.0 | 60.6 | 68.5 | 77.1 | 308 ms |
| Mem0 cloud (776 of the questions) | | 75.3 | 81.1 | 85.6 | 468 ms |
| MemVault production (hosted embeddings + reranker + graph) | | 87.3 | | 91.9 | 785 ms |

**What this supports.** With the on-device models, `nsm` equals Mem0 cloud's top 50 on the questions
both answered (84.1% vs 85.6%, p = 0.30) and MemVault's pre-October recall at ten memories (78.8% vs
79.0%), and beats plain embedding search at every size by 6 to 23 points. The cross-encoder is the
largest single lever (+13 points at 5 memories, p = 2e-14). With no model, it still beats hosted
embedding search at every size at 6 ms.

**What it does not support.** Parity with current MemVault: 5.8 points behind its production default at
equal tokens, 8.5 behind its high-context mode (p ≤ 2e-6), mostly on multi-hop and paraphrase
questions. Any contribution from the graph: clause-extractor concepts, term nodes and fan damping were
each measured and none helped. Fast and accurate in one setting: 6 ms gets you the first row, 688 ms
the second.

**Lifecycle, 180 simulated days** (LoCoMo dev, half the questions asked along the way, daily sweep):
never-asked questions are answered at 63.8% on a fresh store, 63.8% with forgetting by demotion (identical
answers), and 47.6% with forgetting by deletion (p = 5e-9). Archiving instead of deleting costs nothing.

**Absence flags** (held-out test split of the synthetic routine dataset): the no-model detector flags 50%
of routines that stopped, with one false flag in 26 continuing routines, and the agent notices the stopped
routine in 50.0% of answers with the flag against 9.1% without (p = 0.004), with no rise in invented
anomalies. MemVault's hosted embedding detector reaches 54.5% against 4.5% on the same questions.

The full campaign, 24 retrieval arms including label weighting, episode expansion and a larger reranker
that were measured and rejected, plus the lifecycle and absence runs, is in `bench/RESULTS.md`; the design
is in [NSM-SPEC.md](NSM-SPEC.md).

## Development

```bash
bun install
bun test                 # 40 tests; the model tests use fakes, no download
bun run cli -- doctor
```

Benchmark (from `skillvault/apps/server`, needs the harness's API keys; `nsm` itself makes no calls):

```bash
bun bench/run-locomo.ts --system nsm2 --split test --run <tag>                              # no model
bun bench/run-locomo.ts --system nsm2+embedbge+rerank100+seeds100 --split test --run <tag>  # on-device models
bun bench/report-locomo.ts --run <tag>
```

## License

MIT © 2026 Anthony Lee.
