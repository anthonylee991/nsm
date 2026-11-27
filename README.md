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

That is the whole setup. From now on your agent has `nsm_recall` and `nsm_remember` (plus `nsm_forget`
and `nsm_list`), and their descriptions tell it when to use them: recall at the start of a task, remember
when you state a preference, a rule or a decision.

### Make your agent use it every time

The tool descriptions nudge an agent to recall and remember, but a nudge is not a habit: agents skip it
when they are busy, and they are much worse at saving than at looking things up. To make it routine, put
the instruction below in the file your agent reads at the start of every session:

| Tool | Where it goes |
| :--- | :--- |
| Claude Code | `~/.claude/CLAUDE.md` (all projects) or a project's `CLAUDE.md` |
| Codex | `~/.codex/AGENTS.md` (all projects) or a project's `AGENTS.md` |
| Cursor | Settings > Rules > User Rules, or a `.cursor/rules/nsm.mdc` file with `alwaysApply: true` |
| Anything else | wherever it keeps standing instructions or its system prompt |

```markdown
# Memory (NSM)

I keep a persistent local memory that every session and every agent shares, through the `nsm` MCP tools.
I rely on it so that I never have to tell an agent the same thing twice.

**Recall first.** At the start of every task, before planning, answering or writing code, call
`nsm_recall` with a short description of what you are about to do and your working directory as
`folder`. Follow any pinned rules it returns: they are my global rules plus this project's.
Treat the memories as dated context: when two disagree, the newer one wins. Recall again when the
conversation moves to a different project or question.

**Remember as you go.** Call `nsm_remember` as soon as one of these comes up, without waiting to be asked
and without waiting for the end of the session:

- a preference, rule or convention I state
- a decision we make (architecture, tooling, naming, scope) and the reason for it
- a fact about a project, its setup or its environment that is not obvious from the code
- the root cause of a bug that was hard to find
- the state of the work when a multi-step task finishes

Write one memory per call, in one or two sentences that make sense on their own (name the project, use
real dates), in my words where possible. Always pass your working directory as `folder`. Use
`scope: "global"` for things about me that hold in every project (how I work, what I prefer) and leave
the default, the current project, for things about this codebase. Use `pinned: true` only for rules that
must apply every time.

**Keep it clean.** Do not save small talk, temporary debugging detail, anything the repository or git
history already records, or secrets of any kind (keys, tokens, passwords). When I say something no longer
holds, `nsm_forget` the old memory and remember the new one.

If the `nsm` tools are not available in a session, tell me once and carry on without them.
```

### Optional: better recall with on-device models

```bash
nsm models install      # about 250 MB, downloaded once
```

This adds a small embedding model and a reranker that run on your CPU. Recall goes from about 6 ms to
about 1.3 s per question and gets noticeably better at questions that do not share words with the
memory (see the numbers below). `nsm models off` switches back.

## How agents connect

`nsm` reaches your agents through MCP (Model Context Protocol), the standard way to give an AI agent
extra tools. The agent starts a small helper program, asks it which tools it offers, and can then call
them during a conversation. `nsm serve` is that helper. It offers four tools:

| Tool | What it does |
| :--- | :--- |
| `nsm_recall` | Search the memory for a question or task; the global pinned rules and the current project's always come back |
| `nsm_remember` | Save a memory or a pinned rule, for the current project or for everywhere |
| `nsm_forget` | Delete a memory by id |
| `nsm_list` | List what is stored |

Each agent starts its own `nsm serve`, and every copy reads and writes the same file,
`~/.nsm/memory.db`. That is why what Claude Code saves, Cursor can recall. Nothing listens on a network
port: the agent talks to the helper over its standard input and output.

To connect an agent, tell it once which command to run:

**Claude Code**

```bash
claude mcp add nsm -- nsm serve
```

**Cursor**, in `.cursor/mcp.json` (or Cursor Settings > MCP):

```json
{ "mcpServers": { "nsm": { "command": "nsm", "args": ["serve"] } } }
```

**Codex**, in `~/.codex/config.toml`:

```toml
[mcp_servers.nsm]
command = "nsm"
args = ["serve"]
```

**Anything else that speaks MCP**: command `nsm`, argument `serve`, transport stdio.

Running from a clone instead of the installer? Use `bun` as the command and
`["/path/to/nsm/bin/nsm.ts", "serve"]` as the arguments.

## Using it yourself

```bash
nsm remember "We deploy to Railway, not Fly"            # a memory for the project you are in
nsm remember "Always use bun, never npm" --pin           # a rule for this project: delivered on every recall here
nsm remember "I choose the AI model" --pin --global      # a rule for everywhere
nsm recall "where do we deploy?"                         # what do I know about ...
nsm list --pinned
nsm list --archived                                      # include long-term (faded) memories
nsm scope <id> global                                    # move a memory to everywhere (or `project`: to this one)
nsm forget <id>                                          # ids are shown by recall and list
nsm sweep                                                # move faded memories to long-term now (recall does it daily)
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

* **Storage**: one SQLite file. Memories in a plain table, an FTS5 index over their text (Porter-stemmed
  BM25), optional vectors. Several agents can use it at once (WAL mode; each server sees the others' writes).
* **Retrieval**: BM25, phrase and substring legs fused by reciprocal rank fusion; with the on-device models,
  a dense leg at double weight and a cross-encoder that re-reads the top 100 candidates plus the memories
  saved around the top hits.
* **Projects**: every memory belongs to a project (the git repository of the folder the agent is working
  in) or to everywhere. Pinned rules are delivered only where they apply: your global ones everywhere, a
  project's only in that project. Other memories stay searchable from any project, ranked at half weight
  outside their own, so a decision made in one repo can still help in another.
* **Pinned rules**: memories marked `--pin` are delivered on every recall in their scope, matched or not.
* **Nothing irrelevant to fill space**: with the on-device models, a memory the reranker scores as
  unrelated (below -11) is left out, so a small store does not hand back everything it has. That floor
  was the strictest one that lost no evidence on the LoCoMo dev split.
* **Short-term and long-term memory, from ACM**: every memory has a strength that decays over about 90
  days and is refreshed when it is recalled (and a little when its neighbours are). Once a day, memories
  that have faded and gone unrecalled for 90 days move to long-term: kept whole, out of the way of weak
  cues, still found by a direct question, and back in short-term once recalled. Nothing is deleted unless
  you ask.
* **Absence flags**: when a routine you kept mentioning on a regular rhythm has gone quiet, recall says
  so in an `[ANOMALY FLAGS]` slot above the memories, with no model involved.
* **PAE-shaped output**: pinned rules, anomaly flags and dated memories in labelled slots, the structure
  [Peripheral Attention Engineering](https://github.com/anthonylee991/pae) measured to help models use
  context.
* **Optional local models**: `bge-small-en-v1.5` (384-d) and `ms-marco-MiniLM-L-6-v2`, through ONNX via
  `@huggingface/transformers`, an optional dependency.
* **Library API** for your own programs: `MemoryStore` (the product: lifecycle and prompt) and `Retriever`
  (retrieval only), with injectable `Embedder` / `Reranker` interfaces so you can bring other models.

```typescript
import { MemoryStore } from "@skillvault/nsm";
const store = new MemoryStore({ dbPath: "memory.db" });
await store.remember("I live in Seattle and work remotely");
console.log((await store.recall("where do I live?")).prompt);
```

Versions before 3.0 also built a concept graph from every memory (rule-based clause extraction, spreading
activation, ant-colony pheromone trails). It was measured in three designs and never helped retrieval,
while making up most of the stored rows, so 3.0 removed it. A 2.x database is migrated on first open and
the old file is kept as `memory.db.v2-backup`.

## Measured

Every number was measured in October 2026 with the benchmark harness of MemVault, a hosted memory
product by the same author that has since been discontinued. The harness ran every system on the public
LoCoMo dataset with a fixed answer model (DeepSeek V4.1 Flash), a separate judge (Qwen3.8 Flash) and
prompts copied verbatim from Mem0's published harness. Configurations were chosen on a dev split and
confirmed once on the held-out test split (885 questions). Comparisons are paired exact McNemar tests.
Nothing is typed in.

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
| MemVault (hosted embeddings + reranker + graph; discontinued) | | 87.3 | | 91.9 | 785 ms |

Those rows were measured on 2.1. Version 3.0 removed the graph and was checked against 2.1 on the same
split without the answer model: the same evidence reaches the top 5 to 50 at every cutoff, with and
without models (no difference significant; NSM-SPEC §4.5), while `remember` went from 92 ms to 0.9 ms
and no-model recall from 1.4 s to 30 ms at 5,900 memories.

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

**What it does not support.** Parity with MemVault as it was: 2.7 points behind its production default at
equal tokens (p = 0.014), 4.8 behind its high-context mode (p = 1e-6), mostly on multi-hop and paraphrase
questions; Mem0 at its 200-memory, 6,771-token setting is also ahead (89.9%, p = 0.006). Any
contribution from the graph: clause-extractor concepts, term nodes and fan damping were each measured and
none helped (3.0 removed it). Fast and accurate in one setting: 6 ms gets you the first row, 1.3 s the second.

**Lifecycle, 180 simulated days** (LoCoMo dev, half the questions asked along the way, daily sweep):
never-asked questions are answered at 63.8% on a fresh store, 63.8% with forgetting by demotion (identical
answers), and 47.6% with forgetting by deletion (p = 5e-9). Archiving instead of deleting costs nothing.

**Absence flags** (held-out test split of the synthetic routine dataset): the no-model detector flags 50%
of routines that stopped, with one false flag in 26 continuing routines, and the agent notices the stopped
routine in 50.0% of answers with the flag against 9.1% without (p = 0.004), with no rise in invented
anomalies. MemVault's hosted embedding detector reaches 54.5% against 4.5% on the same questions.

The campaign covered 27 retrieval arms, including label weighting, a graph in three designs and a larger
reranker that were measured and rejected, plus the lifecycle and absence runs. The design, the results
and the list of what 3.0 removed are in [NSM-SPEC.md](NSM-SPEC.md).

## Development

```bash
bun install
bun test                 # the model tests use fakes, no download
bun run cli -- doctor
```

The benchmark harness that produced the numbers above lived in the MemVault repository and is not part
of this one, so the answer-accuracy scores cannot be re-run from here.

## License

MIT © 2026 Anthony Lee.
