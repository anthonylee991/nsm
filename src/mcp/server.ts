import { createInterface } from "node:readline";
import { MemoryStore } from "../app/store.js";

/**
 * MCP server over stdio (newline-delimited JSON-RPC 2.0), the transport every local MCP client
 * speaks (Claude Code, Cursor, Codex, Windsurf, Cline, ...). No SDK: the subset NSM needs is small.
 *
 * Methods: initialize, notifications/initialized, ping, tools/list, tools/call.
 * Logging goes to stderr only; stdout carries protocol messages.
 */
const PROTOCOL_VERSION = "2025-06-18";
export const SERVER_NAME = "nsm";
export const SERVER_VERSION = "2.0.0";

interface Req { jsonrpc: "2.0"; id?: string | number | null; method: string; params?: any }
interface Res { jsonrpc: "2.0"; id: string | number | null; result?: unknown; error?: { code: number; message: string } }

export const TOOLS = [
  {
    name: "nsm_recall",
    description:
      "Recall what the user has told you to remember. Call this at the start of any task, before planning, " +
      "coding, writing or answering about the user's preferences, projects, decisions or past work. Returns the " +
      "user's pinned rules (always) and the memories most relevant to the query, with dates and ids. Runs " +
      "locally; nothing leaves the machine.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "What you are about to do, or the question you need context for." },
        k: { type: "number", description: "How many memories to return (default 10)." },
      },
      required: ["query"],
      additionalProperties: false,
    },
  },
  {
    name: "nsm_remember",
    description:
      "Store something durable the user said or decided: a preference, a rule, a decision, a fact about their " +
      "work or life, a bug root cause, a how-to. Call it as soon as the thing is agreed, not at the end. Use " +
      "pinned=true for rules that must apply every time (coding standards, non-negotiables). One memory per call, " +
      "one or two sentences, in the user's words where possible.",
    inputSchema: {
      type: "object",
      properties: {
        text: { type: "string", description: "The memory, one or two sentences." },
        pinned: { type: "boolean", description: "True for a rule that must be delivered on every recall." },
        source: { type: "string", description: "Where it came from, e.g. 'claude-code', 'cursor', 'user'." },
      },
      required: ["text"],
      additionalProperties: false,
    },
  },
  {
    name: "nsm_forget",
    description: "Delete a memory by id (ids are shown by nsm_recall). Use when the user says something no longer holds.",
    inputSchema: {
      type: "object",
      properties: { id: { type: "string", description: "The memory id." } },
      required: ["id"],
      additionalProperties: false,
    },
  },
  {
    name: "nsm_list",
    description: "List stored memories, newest first. Use pinned=true to see only the pinned rules.",
    inputSchema: {
      type: "object",
      properties: {
        pinned: { type: "boolean", description: "Only pinned rules." },
        limit: { type: "number", description: "Maximum to return (default 50)." },
      },
      additionalProperties: false,
    },
  },
] as const;

export async function handle(store: MemoryStore, req: Req): Promise<Res | null> {
  const id = req.id ?? null;
  const ok = (result: unknown): Res => ({ jsonrpc: "2.0", id, result });
  const err = (code: number, message: string): Res => ({ jsonrpc: "2.0", id, error: { code, message } });
  try {
    switch (req.method) {
      case "initialize":
        return ok({
          protocolVersion: PROTOCOL_VERSION,
          capabilities: { tools: {} },
          serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
          instructions:
            "NSM is the user's local memory. Call nsm_recall before starting work; call nsm_remember when the user " +
            "states a preference, rule or decision.",
        });
      case "notifications/initialized":
        return null;
      case "ping":
        return ok({});
      case "tools/list":
        return ok({ tools: TOOLS });
      case "tools/call": {
        const name = String(req.params?.name ?? "");
        const args = (req.params?.arguments ?? {}) as Record<string, unknown>;
        const text = (s: string, structured?: unknown) => ok({
          content: [{ type: "text", text: s }],
          ...(structured !== undefined ? { structuredContent: structured } : {}),
          isError: false,
        });
        switch (name) {
          case "nsm_recall": {
            const query = String(args.query ?? "").trim();
            if (!query) return err(-32602, "query is required");
            const r = await store.recall(query, typeof args.k === "number" ? args.k : undefined);
            return text(r.prompt, { pinned: r.pinned, memories: r.memories, latencyMs: Math.round(r.latencyMs), neural: r.neural });
          }
          case "nsm_remember": {
            const t = String(args.text ?? "").trim();
            if (!t) return err(-32602, "text is required");
            const r = await store.remember(t, {
              pinned: args.pinned === true,
              source: typeof args.source === "string" ? args.source : "mcp",
            });
            return text(r.duplicate ? `already remembered (id ${r.id})` : `remembered (id ${r.id})`, r);
          }
          case "nsm_forget": {
            const fid = String(args.id ?? "");
            const done = store.forget(fid);
            return text(done ? `forgot ${fid}` : `no memory with id ${fid}`, { forgotten: done });
          }
          case "nsm_list": {
            const items = store.list({
              pinned: typeof args.pinned === "boolean" ? args.pinned : undefined,
              limit: typeof args.limit === "number" ? args.limit : 50,
            });
            return text(
              items.length ? items.map((m) => `• (${m.createdAt.slice(0, 10)})${m.pinned ? " [pinned]" : ""} ${m.text}  [id: ${m.id}]`).join("\n") : "(no memories)",
              { memories: items }
            );
          }
          default:
            return err(-32601, `unknown tool ${name}`);
        }
      }
      default:
        return req.id === undefined ? null : err(-32601, `method not found: ${req.method}`);
    }
  } catch (e) {
    return err(-32603, (e as Error).message);
  }
}

/** Run the server on this process's stdin/stdout until stdin closes. */
export async function serve(store: MemoryStore): Promise<void> {
  const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
  const write = (msg: Res) => process.stdout.write(JSON.stringify(msg) + "\n");
  for await (const line of rl) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      write({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "parse error" } });
      continue;
    }
    const batch = Array.isArray(parsed) ? parsed : [parsed];
    for (const req of batch as Req[]) {
      const res = await handle(store, req);
      if (res) write(res);
    }
  }
}
