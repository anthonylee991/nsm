import { describe, it, expect } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { MemoryStore } from "../src/app/store.js";
import { DEFAULT_CONFIG } from "../src/app/paths.js";
import { handle, TOOLS } from "../src/mcp/server.js";

describe("MCP handler", () => {
  it("initialize, tools/list, tools/call round trip", async () => {
    const home = mkdtempSync(join(tmpdir(), "nsm-mcp-"));
    process.env.NSM_HOME = home;
    const store = new MemoryStore({ config: { ...DEFAULT_CONFIG }, neural: false });
    try {
      const init = await handle(store, { jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
      expect((init!.result as any).serverInfo.name).toBe("nsm");
      expect(await handle(store, { jsonrpc: "2.0", method: "notifications/initialized" })).toBeNull();
      const list = await handle(store, { jsonrpc: "2.0", id: 2, method: "tools/list" });
      expect((list!.result as any).tools.map((t: any) => t.name)).toEqual(TOOLS.map((t) => t.name));

      const rem = await handle(store, {
        jsonrpc: "2.0", id: 3, method: "tools/call",
        params: { name: "nsm_remember", arguments: { text: "The deploy target is Railway, not Fly", pinned: true } },
      });
      expect((rem!.result as any).content[0].text).toMatch(/^remembered \(id /);

      const rec = await handle(store, {
        jsonrpc: "2.0", id: 4, method: "tools/call",
        params: { name: "nsm_recall", arguments: { query: "where do we deploy?" } },
      });
      const text = (rec!.result as any).content[0].text as string;
      expect(text).toContain("[PINNED RULES]");
      expect(text).toContain("Railway");
      expect((rec!.result as any).structuredContent.pinned.length).toBe(1);

      const bad = await handle(store, { jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "nope", arguments: {} } });
      expect(bad!.error!.code).toBe(-32601);
      const missing = await handle(store, { jsonrpc: "2.0", id: 6, method: "tools/call", params: { name: "nsm_recall", arguments: {} } });
      expect(missing!.error!.code).toBe(-32602);
    } finally {
      await store.close();
      delete process.env.NSM_HOME;
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe("MCP over stdio (real process)", () => {
  it("answers initialize and a recall through the CLI", async () => {
    const home = mkdtempSync(join(tmpdir(), "nsm-stdio-"));
    try {
      const proc = Bun.spawn(["bun", resolve(import.meta.dir, "..", "bin", "nsm.ts"), "serve"], {
        env: { ...process.env, NSM_HOME: home },
        stdin: "pipe",
        stdout: "pipe",
        stderr: "pipe",
      });
      const msgs = [
        { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "0" } } },
        { jsonrpc: "2.0", method: "notifications/initialized" },
        { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "nsm_remember", arguments: { text: "Tests run with bun test" } } },
        { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "nsm_recall", arguments: { query: "how do I run the tests?" } } },
      ];
      proc.stdin.write(msgs.map((m) => JSON.stringify(m)).join("\n") + "\n");
      proc.stdin.end();
      const outText = await new Response(proc.stdout).text();
      await proc.exited;
      const lines = outText.trim().split("\n").map((l) => JSON.parse(l));
      expect(lines.length).toBe(3); // the notification gets no response
      expect(lines[0].result.serverInfo.name).toBe("nsm");
      expect(lines[2].result.content[0].text).toContain("bun test");
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  }, 30000);
});
