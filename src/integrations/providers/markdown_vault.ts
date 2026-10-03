import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import type { MemoryNode } from "../../core/types.js";
import type { IntegrationProvider, IntegrationConfigField, ConnectionStatus } from "../types.js";
import { ClausIEv2Extractor } from "../../extractors/clausie_v2.js";

export class MarkdownVaultIntegration implements IntegrationProvider {
  public id = "markdown_vault";
  public name = "Local Markdown Vault";
  public category = "memory" as const;
  public description = "Direct local markdown vault indexing (Obsidian/Logseq format) with ClausIE v2 relation extraction";
  public icon = "📓";
  public status: ConnectionStatus = "disconnected";
  public lastSyncedAt?: number;
  public errorMessage?: string;

  public configFields: IntegrationConfigField[] = [
    {
      key: "vaultPath",
      label: "Vault Folder Path",
      type: "path",
      placeholder: "e.g. /path/to/notes or C:\\path\\to\\notes",
      required: true,
      description: "Local directory containing markdown (.md) documents",
    },
    {
      key: "maxFiles",
      label: "Max Documents Limit",
      type: "text",
      placeholder: "100",
      required: false,
      description: "Max number of markdown files to scan per sync run (default: 100)",
      defaultValue: "100",
    },
  ];

  private vaultPath: string = "";
  private maxFiles: number = 100;

  public async connect(config: Record<string, any>): Promise<void> {
    const path = config.vaultPath?.trim();
    if (!path) throw new Error("Vault path is required");

    try {
      const s = await stat(path);
      if (!s.isDirectory()) throw new Error("Specified path is not a directory");
      this.vaultPath = path;
      this.maxFiles = Number(config.maxFiles) || 100;
      this.status = "connected";
      this.errorMessage = undefined;
    } catch (err: any) {
      this.status = "error";
      this.errorMessage = err.message;
      throw err;
    }
  }

  public async disconnect(): Promise<void> {
    this.vaultPath = "";
    this.status = "disconnected";
    this.errorMessage = undefined;
  }

  public async sync(): Promise<MemoryNode[]> {
    if (!this.vaultPath) return [];
    this.status = "syncing";
    const nodes: MemoryNode[] = [];

    try {
      const scanDir = async (dir: string, depth: number = 0) => {
        if (depth > 5 || nodes.length >= this.maxFiles) return;
        const entries = await readdir(dir, { withFileTypes: true });

        for (const entry of entries) {
          if (entry.name.startsWith(".")) continue;
          const fullPath = join(dir, entry.name);

          if (entry.isDirectory()) {
            await scanDir(fullPath, depth + 1);
          } else if (entry.isFile() && entry.name.endsWith(".md")) {
            const content = await readFile(fullPath, "utf-8");
            const title = entry.name.replace(/\.md$/, "");

            // Extract primary declarative sentences into ClausIE triplets
            const lines = content
              .split("\n")
              .map((l) => l.trim())
              .filter((l) => l.length > 10 && !l.startsWith("#"));

            const firstSnippet = lines.slice(0, 3).join(". ");
            const triplets = ClausIEv2Extractor.extract(firstSnippet);

            nodes.push({
              id: `vault-${Buffer.from(fullPath).toString("base64url").substring(0, 16)}`,
              nodeType: "note",
              label: title,
              source: "local_notes",
              authority: 0.85,
              payload: {
                title,
                path: fullPath,
                snippet: content.substring(0, 350),
                triplets,
              },
              createdAt: Date.now(),
              updatedAt: Date.now(),
            });
          }
        }
      };

      await scanDir(this.vaultPath);
      this.status = "connected";
      this.lastSyncedAt = Date.now();
      return nodes;
    } catch (err: any) {
      this.status = "error";
      this.errorMessage = err.message;
      throw err;
    }
  }
}
