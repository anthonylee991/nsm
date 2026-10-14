#!/usr/bin/env bun
/**
 * nsm: a local memory for AI agents. One SQLite file under ~/.nsm, optional on-device models.
 *
 *   nsm serve                         MCP server on stdio (what your agent harness runs)
 *   nsm remember "<text>" [--pin]     store a memory (or a pinned rule)
 *   nsm recall "<query>" [--k N] [--json]
 *   nsm forget <id>
 *   nsm list [--pinned] [--limit N]
 *   nsm models install | status       download the local models and switch recall to use them
 *   nsm setup <harness>               print the one line that wires nsm into claude-code | cursor | codex | generic
 *   nsm stats | doctor | --version
 */
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { MemoryStore } from "../src/app/store.js";
import { loadConfig, saveConfig, nsmHome, dbPath, modelDir } from "../src/app/paths.js";
import { LocalEmbedder, LocalReranker } from "../src/neural/local.js";
import { serve, SERVER_VERSION } from "../src/mcp/server.js";

const argv = process.argv.slice(2);
const command = argv[0];
const positional: string[] = [];
const flags: Record<string, string | boolean> = {};
for (const a of argv.slice(1)) {
  if (a.startsWith("--")) {
    const [k, v] = a.slice(2).split("=", 2);
    flags[k!] = v ?? true;
  } else positional.push(a);
}
const log = (s: string) => process.stderr.write(s + "\n");
const out = (s: string) => process.stdout.write(s + "\n");

async function main() {
  switch (command) {
    case "serve": {
      const store = new MemoryStore();
      log(`[nsm] serving MCP on stdio (db ${dbPath()}, local models ${store.neural ? "on" : "off"})`);
      await serve(store);
      await store.close();
      return;
    }
    case "remember": {
      const text = positional.join(" ").trim();
      if (!text) throw new Error('usage: nsm remember "<text>" [--pin] [--source=<name>]');
      const store = new MemoryStore();
      const r = await store.remember(text, { pinned: flags.pin === true, source: typeof flags.source === "string" ? flags.source : "cli" });
      out(r.duplicate ? `already remembered: ${r.id}` : `remembered: ${r.id}${flags.pin ? " (pinned)" : ""}`);
      await store.close();
      return;
    }
    case "recall": {
      const query = positional.join(" ").trim();
      if (!query) throw new Error('usage: nsm recall "<query>" [--k=N] [--json]');
      const store = new MemoryStore();
      const r = await store.recall(query, typeof flags.k === "string" ? Number(flags.k) : undefined, { activeOnly: flags["active-only"] === true });
      out(flags.json ? JSON.stringify(r, null, 2) : r.prompt);
      log(`[nsm] ${r.memories.length} memories, ${r.pinned.length} pinned, ${r.flags.length} flags, ${r.latencyMs.toFixed(0)} ms${r.neural ? ", local models" : ""}`);
      await store.close();
      return;
    }
    case "sweep": {
      const store = new MemoryStore();
      const r = store.sweep();
      out(`sweep: ${r.demoted} demoted, ${r.deleted} deleted, ${r.kept} kept`);
      await store.close();
      return;
    }
    case "forget": {
      const id = positional[0];
      if (!id) throw new Error("usage: nsm forget <id>");
      const store = new MemoryStore();
      out(store.forget(id) ? `forgot ${id}` : `no memory with id ${id}`);
      await store.close();
      return;
    }
    case "list": {
      const store = new MemoryStore();
      const items = store.list({ pinned: flags.pinned === true ? true : undefined, limit: typeof flags.limit === "string" ? Number(flags.limit) : 50, includeArchived: flags.archived === true });
      out(items.length ? items.map((m) => `${m.createdAt.slice(0, 10)}  ${m.pinned ? "[pinned] " : ""}${m.state === "archived" ? "[archived] " : ""}${m.text}  (${m.id}, strength ${m.strength.toFixed(2)})`).join("\n") : "(no memories)");
      await store.close();
      return;
    }
    case "stats": {
      const store = new MemoryStore();
      out(JSON.stringify(store.stats(), null, 2));
      await store.close();
      return;
    }
    case "models": {
      const sub = positional[0] ?? "status";
      const cfg = loadConfig();
      if (sub === "status") {
        out(JSON.stringify({ neural: cfg.neural, embedModel: cfg.embedModel, rerankModel: cfg.rerankModel, modelDir: modelDir(), present: existsSync(modelDir()) }, null, 2));
        return;
      }
      if (sub === "install") {
        log(`[nsm] downloading ${cfg.embedModel} and ${cfg.rerankModel} into ${modelDir()} (about 250 MB, once)...`);
        const t0 = performance.now();
        const embedder = new LocalEmbedder(cfg.embedModel, { modelDir: modelDir() });
        await embedder.embed(["warm up"], "query");
        const reranker = new LocalReranker(cfg.rerankModel, { modelDir: modelDir() });
        await reranker.score("warm up", ["warm up"]);
        await embedder.dispose();
        await reranker.dispose();
        log(`[nsm] models ready in ${((performance.now() - t0) / 1000).toFixed(0)} s`);
        saveConfig({ ...cfg, neural: true });
        const store = new MemoryStore();
        const n = await store.embedAll();
        await store.close();
        out(`local models on; ${n} existing memories embedded. Recall now uses the dense leg and the reranker.`);
        return;
      }
      if (sub === "off") {
        saveConfig({ ...cfg, neural: false });
        out("local models off; recall is lexical only (6 ms).");
        return;
      }
      throw new Error("usage: nsm models install | status | off");
    }
    case "setup": {
      const harness = positional[0] ?? "generic";
      const bin = process.env.NSM_BIN ?? "nsm";
      const snippets: Record<string, string> = {
        "claude-code": `claude mcp add nsm -- ${bin} serve`,
        cursor: `Add to .cursor/mcp.json (or Cursor Settings > MCP):\n${JSON.stringify({ mcpServers: { nsm: { command: bin, args: ["serve"] } } }, null, 2)}`,
        codex: `Add to ~/.codex/config.toml:\n[mcp_servers.nsm]\ncommand = "${bin}"\nargs = ["serve"]`,
        generic: `Any MCP client: command "${bin}", args ["serve"], transport stdio.\nJSON form:\n${JSON.stringify({ mcpServers: { nsm: { command: bin, args: ["serve"] } } }, null, 2)}`,
      };
      out(snippets[harness] ?? snippets.generic!);
      return;
    }
    case "doctor": {
      const cfg = loadConfig();
      const checks: string[] = [];
      checks.push(`home     ${nsmHome()}`);
      checks.push(`db       ${dbPath()} ${existsSync(dbPath()) ? "(exists)" : "(will be created)"}`);
      checks.push(`models   ${cfg.neural ? "on" : "off"} (${modelDir()})`);
      const store = new MemoryStore({ neural: false });
      const s = store.stats();
      checks.push(`memories ${s.memories} (+${s.pinned} pinned, ${s.vectors} vectors)`);
      const t0 = performance.now();
      store.recall("doctor check");
      checks.push(`recall   ok, ${(performance.now() - t0).toFixed(1)} ms lexical`);
      await store.close();
      out(checks.join("\n"));
      return;
    }
    case "--version":
    case "version":
      out(SERVER_VERSION);
      return;
    default:
      out(`nsm ${SERVER_VERSION}: a local memory for AI agents\n\n` +
        `  nsm serve                          MCP server on stdio\n` +
        `  nsm remember "<text>" [--pin]      store a memory (or a pinned rule)\n` +
        `  nsm recall "<query>" [--k=N]       what do I know about ...\n` +
        `  nsm forget <id>\n` +
        `  nsm list [--pinned] [--archived] [--limit=N]\n` +
        `  nsm sweep                          apply forgetting: faded, idle memories are archived (not deleted)\n` +
        `  nsm models install | status | off  on-device models (better recall, ~700 ms instead of ~6 ms)\n` +
        `  nsm setup claude-code|cursor|codex|generic\n` +
        `  nsm stats | doctor | --version\n\n` +
        `Data: ${resolve(nsmHome())}`);
      if (command && command !== "help" && command !== "--help") process.exit(1);
  }
}

main().catch((e) => {
  log(`[nsm] ${(e as Error).message}`);
  process.exit(1);
});
