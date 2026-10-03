import type { CategorySummary, ContextCategory, IntegrationProvider } from "./types.js";
import { MarkdownVaultIntegration } from "./providers/markdown_vault.js";
import { ApiMemoryIntegration } from "./providers/api_memory.js";
import { CalendarFeedIntegration } from "./providers/calendar_feed.js";
import { SocialSignalIntegration } from "./providers/social_signal.js";
import { Database } from "bun:sqlite";
import type { NeuroSwarmMesh } from "../mesh.js";

export class IntegrationManager {
  private providers: Map<string, IntegrationProvider> = new Map();
  private db: Database;
  private mesh: NeuroSwarmMesh;

  constructor(mesh: NeuroSwarmMesh, dbPath: string = ":memory:") {
    this.mesh = mesh;
    this.db = new Database(dbPath);
    this.initSchema();
    this.registerDefaultProviders();
    this.loadSavedConfigs();
  }

  private initSchema() {
    this.db.run(`
      CREATE TABLE IF NOT EXISTS integration_configs (
        id TEXT PRIMARY KEY,
        category TEXT NOT NULL,
        status TEXT NOT NULL,
        config_json TEXT NOT NULL,
        last_synced_at INTEGER
      );
    `);
  }

  private registerDefaultProviders() {
    this.registerProvider(new MarkdownVaultIntegration());
    this.registerProvider(new ApiMemoryIntegration());
    this.registerProvider(new CalendarFeedIntegration());
    this.registerProvider(new SocialSignalIntegration());
  }

  public registerProvider(provider: IntegrationProvider) {
    this.providers.set(provider.id, provider);
  }

  public getProvider(id: string): IntegrationProvider | undefined {
    return this.providers.get(id);
  }

  private loadSavedConfigs() {
    try {
      const rows = this.db.query(`SELECT * FROM integration_configs`).all() as any[];
      for (const row of rows) {
        const provider = this.providers.get(row.id);
        if (provider && row.status === "connected") {
          const config = JSON.parse(row.config_json);
          provider.connect(config).catch(() => {});
          provider.lastSyncedAt = row.last_synced_at;
        }
      }
    } catch {}
  }

  public getAllCategories(): CategorySummary[] {
    const categories: CategorySummary[] = [
      {
        id: "memory",
        title: "Cognitive Memory & Second Brain",
        icon: "🧠",
        description: "Local markdown vaults, persistent rules, and cloud memory meshes",
        providers: [],
      },
      {
        id: "calendar",
        title: "Calendar & Horizon",
        icon: "🗓️",
        description: "Rolling schedules, routine commitments, and conflict density",
        providers: [],
      },
      {
        id: "social",
        title: "Social & Identity",
        icon: "🌐",
        description: "Public affiliations, developer profiles, and community context",
        providers: [],
      },
      {
        id: "documents",
        title: "Documents & Files",
        icon: "📄",
        description: "Knowledge bases, design documents, and project logs",
        providers: [],
      },
    ];

    for (const provider of this.providers.values()) {
      const cat = categories.find((c) => c.id === provider.category);
      if (cat) {
        cat.providers.push(provider);
      }
    }

    return categories;
  }

  public async connectProvider(id: string, config: Record<string, any>): Promise<{ success: boolean; syncedCount: number }> {
    const provider = this.providers.get(id);
    if (!provider) throw new Error(`Integration provider '${id}' not found`);

    await provider.connect(config);

    this.db.run(
      `INSERT INTO integration_configs (id, category, status, config_json, last_synced_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         status = excluded.status,
         config_json = excluded.config_json,
         last_synced_at = excluded.last_synced_at`,
      [provider.id, provider.category, provider.status, JSON.stringify(config), Date.now()]
    );

    const syncedCount = await this.syncProvider(id);
    if (provider.status === "error") {
      this.db.run(`UPDATE integration_configs SET status = 'error' WHERE id = ?`, [id]);
      throw new Error(provider.errorMessage || `Failed to sync provider '${id}'`);
    }

    return { success: true, syncedCount };
  }

  public async disconnectProvider(id: string): Promise<void> {
    const provider = this.providers.get(id);
    if (!provider) return;

    await provider.disconnect();
    this.db.run(`UPDATE integration_configs SET status = 'disconnected' WHERE id = ?`, [id]);
  }

  public async syncProvider(id: string): Promise<number> {
    const provider = this.providers.get(id);
    if (!provider || provider.status === "disconnected") return 0;

    const nodes = await provider.sync();

    // Ingest all nodes into the NeuroSwarmMesh
    for (const node of nodes) {
      this.mesh.ingestNode(node);

      // Link to root user ego node (user:me)
      const rel = node.entityCategory === "organization" ? "affiliated_with" : `has_${node.source}`;
      this.mesh.ingestEdge({
        sourceId: "user:me",
        targetId: node.id,
        relation: rel,
        weight: 0.95,
        lastActivated: Date.now(),
      });
    }

    return nodes.length;
  }

  public close() {
    this.db.close();
  }
}

