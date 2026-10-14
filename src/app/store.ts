import { NeuroSwarmMesh } from "../mesh.js";
import type { MemoryNode, ScoredMemoryNode } from "../core/types.js";
import type { NeuralConfig } from "../neural/types.js";
import { LocalEmbedder, LocalReranker } from "../neural/local.js";
import { dbPath, loadConfig, modelDir, type NsmConfig } from "./paths.js";

export interface Memory {
  id: string;
  text: string;
  pinned: boolean;
  source: string;
  createdAt: string; // ISO
}

export interface RecallItem extends Memory {
  score: number;
  reasons: string[];
}

export interface RecallResult {
  pinned: Memory[];
  memories: RecallItem[];
  /** Ready to paste into a prompt: pinned rules first, then memories with dates and ids. */
  prompt: string;
  latencyMs: number;
  neural: boolean;
}

/**
 * The product surface over NeuroSwarmMesh: one SQLite file under ~/.nsm, optional local models,
 * and three verbs (remember, recall, forget). Used by the CLI and the MCP server.
 */
export class MemoryStore {
  readonly config: NsmConfig;
  readonly neural: boolean;
  private readonly mesh: NeuroSwarmMesh;

  constructor(options: { dbPath?: string; config?: NsmConfig; neural?: boolean } = {}) {
    this.config = options.config ?? loadConfig();
    this.neural = options.neural ?? this.config.neural;
    const neural: NeuralConfig = {};
    if (this.neural) {
      const dir = modelDir();
      neural.embedder = new LocalEmbedder(this.config.embedModel, { modelDir: dir });
      neural.reranker = new LocalReranker(this.config.rerankModel, { modelDir: dir });
      neural.rerankCandidates = 50;
    }
    this.mesh = new NeuroSwarmMesh({ dbPath: options.dbPath ?? dbPath(), neural });
  }

  private toMemory(n: MemoryNode): Memory {
    return {
      id: n.id,
      text: String(n.payload?.text ?? n.payload?.rule ?? n.label),
      pinned: n.nodeType === "invariant",
      source: n.source,
      createdAt: new Date(n.createdAt).toISOString(),
    };
  }

  private isMemory(n: MemoryNode): boolean {
    return n.nodeType === "fact" || n.nodeType === "invariant";
  }

  /** Store one memory. Exact duplicates (same text) return the existing id. */
  async remember(text: string, options: { pinned?: boolean; source?: string } = {}): Promise<{ id: string; duplicate: boolean }> {
    const clean = text.trim();
    if (!clean) throw new Error("empty memory");
    const existing = this.mesh
      .getStorage()
      .getAllNodes()
      .find((n) => this.isMemory(n) && String(n.payload?.text ?? "") === clean);
    if (existing) return { id: existing.id, duplicate: true };

    const pinned = options.pinned === true;
    const { nodeId } = this.mesh.ingestText(clean, {
      source: options.source ?? (pinned ? "user_invariant" : "user_fact"),
      nodeType: pinned ? "invariant" : "fact",
      authority: 1.0,
      payload: pinned ? { rule: clean } : {},
    });
    if (this.neural) await this.mesh.embedPending();
    return { id: nodeId, duplicate: false };
  }

  async recall(query: string, k?: number): Promise<RecallResult> {
    const start = performance.now();
    const limit = k ?? this.config.k;
    const options = {
      lateralInhibitionMaxPerCategory: Math.max(limit, 1),
      // Every pinned rule is delivered on every recall, whether or not the query mentions it.
      guaranteedFilter: (n: MemoryNode) => n.nodeType === "invariant",
    };
    const result = this.neural
      ? await this.mesh.queryAsync(query, options)
      : this.mesh.query(query, options);

    const pinned: Memory[] = [];
    const memories: RecallItem[] = [];
    const seen = new Set<string>();
    for (const s of result.salientNodes as ScoredMemoryNode[]) {
      if (!this.isMemory(s.node) || seen.has(s.node.id)) continue;
      seen.add(s.node.id);
      if (s.node.nodeType === "invariant") pinned.push(this.toMemory(s.node));
      else if (memories.length < limit) memories.push({ ...this.toMemory(s.node), score: s.score, reasons: s.matchReasons });
    }
    return {
      pinned,
      memories,
      prompt: formatPrompt(pinned, memories),
      latencyMs: performance.now() - start,
      neural: this.neural,
    };
  }

  forget(id: string): boolean {
    const node = this.mesh.getStorage().getNodeById(id);
    if (!node || !this.isMemory(node)) return false;
    this.mesh.deleteNode(id);
    return true;
  }

  list(options: { pinned?: boolean; limit?: number } = {}): Memory[] {
    const all = this.mesh
      .getStorage()
      .getAllNodes()
      .filter((n) => this.isMemory(n) && (options.pinned === undefined || (n.nodeType === "invariant") === options.pinned))
      .sort((a, b) => b.createdAt - a.createdAt)
      .map((n) => this.toMemory(n));
    return options.limit ? all.slice(0, options.limit) : all;
  }

  stats(): { memories: number; pinned: number; vectors: number; neural: boolean; db: string } {
    const nodes = this.mesh.getStorage().getAllNodes();
    return {
      memories: nodes.filter((n) => n.nodeType === "fact").length,
      pinned: nodes.filter((n) => n.nodeType === "invariant").length,
      vectors: this.mesh.getStorage().getAllVectors().size,
      neural: this.neural,
      db: dbPath(),
    };
  }

  /** Embed every memory that has no vector yet (after `nsm models install`, or after a bulk import). */
  async embedAll(): Promise<number> {
    return this.mesh.embedPending();
  }

  async close(): Promise<void> {
    await this.mesh.closeAsync();
  }
}

export function formatPrompt(pinned: Memory[], memories: RecallItem[]): string {
  const sections: string[] = [];
  if (pinned.length) {
    sections.push("[PINNED RULES]\n" + pinned.map((p) => `• ${p.text}`).join("\n"));
  }
  if (memories.length) {
    sections.push(
      "[MEMORIES]\n" + memories.map((m) => `• (${m.createdAt.slice(0, 10)}) ${m.text}  [id: ${m.id}]`).join("\n")
    );
  }
  if (sections.length === 0) return "(no memories match)";
  return sections.join("\n\n");
}
