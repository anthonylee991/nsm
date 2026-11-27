import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { MemoryStore } from "../src/app/store.js";
import { DEFAULT_CONFIG } from "../src/app/paths.js";
import { projectKey, projectName } from "../src/app/project.js";
import { MemoryDB } from "../src/db.js";
import { handle } from "../src/mcp/server.js";
import type { Reranker } from "../src/neural/types.js";

let root: string;
let alpha: string;
let beta: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "nsm-proj-"));
  alpha = join(root, "alpha");
  beta = join(root, "beta");
  mkdirSync(join(alpha, ".git"), { recursive: true });
  mkdirSync(join(alpha, "src", "deep"), { recursive: true });
  mkdirSync(join(beta, ".git"), { recursive: true });
  process.env.NSM_HOME = join(root, "home");
});

afterEach(() => {
  delete process.env.NSM_HOME;
  rmSync(root, { recursive: true, force: true });
});

const open = (extra: object = {}) =>
  new MemoryStore({ config: { ...DEFAULT_CONFIG }, neural: false, dbPath: join(root, "m.db"), ...extra });

describe("project keys", () => {
  it("are the git root, from any subfolder", () => {
    expect(projectKey(join(alpha, "src", "deep"))).toBe(projectKey(alpha));
    expect(projectName(projectKey(join(alpha, "src")))).toBe("alpha");
    expect(projectKey(beta)).not.toBe(projectKey(alpha));
  });

  it("fall back to the folder itself outside a repo, and are none for home or nothing", () => {
    const loose = join(root, "loose");
    mkdirSync(loose);
    expect(projectName(projectKey(loose))).toBe("loose");
    expect(projectKey(homedir())).toBeNull();
    expect(projectKey(undefined)).toBeNull();
    expect(projectName(null)).toBe("global");
  });
});

describe("project-scoped memories", () => {
  it("delivers global pinned rules everywhere and project ones only in their project", async () => {
    const store = open();
    try {
      await store.remember("I choose the AI model, never the assistant", { pinned: true, scope: "global", folder: alpha });
      await store.remember("Use bun in this repo", { pinned: true, folder: alpha });
      await store.remember("Deploy beta with docker compose", { pinned: true, folder: beta });
      const inAlpha = await store.recall("what next", 5, { folder: join(alpha, "src") });
      expect(inAlpha.project).toBe("alpha");
      expect(inAlpha.pinned.map((p) => p.text).sort()).toEqual(["I choose the AI model, never the assistant", "Use bun in this repo"]);
      const inBeta = await store.recall("what next", 5, { folder: beta });
      expect(inBeta.pinned.map((p) => p.text).sort()).toEqual(["Deploy beta with docker compose", "I choose the AI model, never the assistant"]);
      const nowhere = await store.recall("what next", 5);
      expect(nowhere.project).toBeNull();
      expect(nowhere.pinned.map((p) => p.text)).toEqual(["I choose the AI model, never the assistant"]);
    } finally {
      await store.close();
    }
  });

  it("ranks the current project's memories above another project's, without hiding the other", async () => {
    const store = open();
    try {
      await store.remember("The deploy target is Fly", { folder: beta });
      await store.remember("The deploy target is Railway", { folder: alpha });
      const r = await store.recall("deploy target", 5, { folder: alpha });
      expect(r.memories.map((m) => m.text)).toEqual(["The deploy target is Railway", "The deploy target is Fly"]);
      expect(r.memories.map((m) => m.project)).toEqual(["alpha", "beta"]);
      const rb = await store.recall("deploy target", 5, { folder: beta });
      expect(rb.memories[0]!.text).toBe("The deploy target is Fly");
    } finally {
      await store.close();
    }
  });

  it("uses the store's folder when a call gives none, and can rescope", async () => {
    const store = open({ folder: alpha });
    try {
      const r = await store.remember("Use bun in this repo", { pinned: true });
      expect(r.project).toBe("alpha");
      expect((await store.recall("x", 5, { folder: beta })).pinned.length).toBe(0);
      expect(store.rescope(r.id, null)).toEqual({ ok: true, project: "global" });
      expect((await store.recall("x", 5, { folder: beta })).pinned.length).toBe(1);
      expect(store.rescope(r.id, beta).project).toBe("beta");
      expect(store.rescope("nope", null).ok).toBe(false);
    } finally {
      await store.close();
    }
  });

  it("drops memories the reranker scores below the floor", async () => {
    const overlap: Reranker = {
      name: "fake",
      async score(_query, texts) {
        return texts.map((t) => (/deploy/i.test(t) ? 3 : -11));
      },
    };
    const store = open({ models: { reranker: overlap }, rerankFloor: -5 });
    try {
      await store.remember("The deploy target is Railway");
      await store.remember("Amazon sellers set a target price for each listing");
      // Both match "target", so both reach the reranker; only the one it scores above the floor is returned.
      const r = await store.recall("what is the deploy target", 10);
      expect(r.memories.map((m) => m.text)).toEqual(["The deploy target is Railway"]);
      const off = open({ models: { reranker: overlap }, rerankFloor: null, dbPath: join(root, "m.db") });
      expect((await off.recall("what is the deploy target", 10)).memories.length).toBe(2);
      await off.close();
    } finally {
      await store.close();
    }
  });

  it("MCP tools take folder and scope", async () => {
    const store = open();
    try {
      const call = (name: string, args: object) => handle(store, { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } });
      const rem = await call("nsm_remember", { text: "Use bun in this repo", pinned: true, folder: alpha });
      expect((rem!.result as any).content[0].text).toContain("alpha");
      await call("nsm_remember", { text: "I choose the model", pinned: true, scope: "global", folder: alpha });
      const rec = await call("nsm_recall", { query: "anything", folder: beta });
      expect((rec!.result as any).structuredContent.project).toBe("beta");
      expect((rec!.result as any).content[0].text).toContain("I choose the model");
      expect((rec!.result as any).content[0].text).not.toContain("Use bun");
    } finally {
      await store.close();
    }
  });
});

describe("3.0 databases", () => {
  it("gain a project column, with every existing memory global", () => {
    const path = join(root, "v30.db");
    const old = new Database(path);
    old.run(`CREATE TABLE memories (seq INTEGER PRIMARY KEY, id TEXT NOT NULL UNIQUE, text TEXT NOT NULL, pinned INTEGER NOT NULL DEFAULT 0,
      source TEXT NOT NULL, created_at INTEGER NOT NULL, occurred_at INTEGER NOT NULL, episode INTEGER, ordinal INTEGER,
      importance TEXT NOT NULL DEFAULT 'default', strength REAL NOT NULL, strength_at INTEGER NOT NULL, boosts INTEGER NOT NULL DEFAULT 0,
      last_recalled_at INTEGER, state TEXT NOT NULL DEFAULT 'active', archived_at INTEGER)`);
    old.run(`INSERT INTO memories (id, text, pinned, source, created_at, occurred_at, strength, strength_at) VALUES ('a', 'rule', 1, 'cli', 1, 1, 1, 1)`);
    old.close();
    const db = new MemoryDB(path);
    expect(db.get("a")).toMatchObject({ text: "rule", pinned: true, project: null });
    db.update("a", { project: "/x/alpha" });
    expect(db.get("a")!.project).toBe("/x/alpha");
    db.close();
  });
});
