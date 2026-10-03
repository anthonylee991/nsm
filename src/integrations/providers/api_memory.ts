import type { MemoryNode } from "../../core/types.js";
import type { IntegrationProvider, IntegrationConfigField, ConnectionStatus } from "../types.js";
import { ClausIEv2Extractor } from "../../extractors/clausie_v2.js";

export class ApiMemoryIntegration implements IntegrationProvider {
  public id = "api_memory";
  public name = "Remote Cognitive Memory API";
  public category = "memory" as const;
  public description = "Syncs personal invariants, rules, decisions, and milestones from an external memory REST API";
  public icon = "🛡️";
  public status: ConnectionStatus = "disconnected";
  public lastSyncedAt?: number;
  public errorMessage?: string;

  public configFields: IntegrationConfigField[] = [
    {
      key: "serverUrl",
      label: "API Server URL",
      type: "url",
      placeholder: "https://api.yourmemoryservice.com",
      required: true,
      description: "Base URL of the external memory API",
    },
    {
      key: "apiToken",
      label: "API Bearer Token",
      type: "password",
      placeholder: "Bearer token or API key",
      required: true,
      description: "Bearer authorization token",
    },
    {
      key: "endpointPath",
      label: "Memories Endpoint Path",
      type: "text",
      placeholder: "/api/v1/memories",
      required: false,
      description: "API path for retrieving memories (default: /api/v1/memories)",
      defaultValue: "/api/v1/memories",
    },
    {
      key: "projectFilter",
      label: "Scope / Project Filter",
      type: "text",
      placeholder: "e.g. core,system or leave empty for all",
      required: false,
      description: "Filter memory items to specific tags/scopes",
    },
  ];

  private serverUrl: string = "";
  private apiToken: string = "";
  private endpointPath: string = "/api/v1/memories";
  private projectFilter: string = "";

  public async connect(config: Record<string, any>): Promise<void> {
    const rawUrl = (config.serverUrl || "").trim();
    const rawToken = (config.apiToken || config.token || "").trim();

    if (!rawUrl) throw new Error("Server URL is required");
    if (!rawToken) throw new Error("API Token is required");

    this.serverUrl = rawUrl.replace(/\/+$/, "");
    this.apiToken = rawToken;
    this.endpointPath = (config.endpointPath || "/api/v1/memories").trim();
    this.projectFilter = (config.projectFilter || config.project || "").trim().toLowerCase();

    try {
      const res = await fetch(`${this.serverUrl}${this.endpointPath}?limit=1`, {
        headers: {
          Authorization: `Bearer ${this.apiToken}`,
          Accept: "application/json",
        },
        signal: AbortSignal.timeout(6000),
      });

      if (!res.ok) {
        const errBody = await res.text().catch(() => "");
        throw new Error(`Authentication failed (HTTP ${res.status}): ${errBody || res.statusText}`);
      }

      this.status = "connected";
      this.errorMessage = undefined;
    } catch (err: any) {
      this.status = "error";
      this.errorMessage = `Failed to connect to memory API: ${err.message}`;
      throw err;
    }
  }

  public async disconnect(): Promise<void> {
    this.serverUrl = "";
    this.apiToken = "";
    this.status = "disconnected";
    this.errorMessage = undefined;
  }

  public async sync(): Promise<MemoryNode[]> {
    if (!this.apiToken || !this.serverUrl) return [];
    this.status = "syncing";
    const nodes: MemoryNode[] = [];

    try {
      const url = `${this.serverUrl}${this.endpointPath}?limit=200`;
      const res = await fetch(url, {
        headers: {
          Authorization: `Bearer ${this.apiToken}`,
          Accept: "application/json",
        },
        signal: AbortSignal.timeout(10000),
      });

      if (!res.ok) {
        throw new Error(`Sync request returned HTTP ${res.status}`);
      }

      const data: any = await res.json().catch(() => ({}));
      const rawMemories: any[] = Array.isArray(data)
        ? data
        : Array.isArray(data.memories)
        ? data.memories
        : Array.isArray(data.items)
        ? data.items
        : [];

      for (const m of rawMemories) {
        const id = String(m.id || Math.random().toString(36).substring(2, 9));
        const rawText = String(m.text || m.rawText || m.content || "").trim();
        if (!rawText) continue;

        const scope = (m.scope?.project || m.project || m.category || "general").trim().toLowerCase();
        if (this.projectFilter) {
          const allowed = this.projectFilter.split(",").map((p) => p.trim().toLowerCase());
          if (!allowed.includes(scope)) continue;
        }

        const isPinned = m.importance === "pinned" || m.pinned === true;
        const isPreference = /preference:|rule:|invariant:/i.test(rawText);
        const isMilestone = /milestone:/i.test(rawText);

        const nodeType = (isPinned || isPreference) ? "invariant" : isMilestone ? "event" : "profile";
        const cleanLabel = rawText.replace(/^(preference|rule|invariant|decision|milestone):\s*/i, "").trim();
        const triplets = ClausIEv2Extractor.extract(cleanLabel);

        nodes.push({
          id: `api-mem-${id}`,
          nodeType,
          label: cleanLabel.length > 100 ? cleanLabel.substring(0, 97) + "..." : cleanLabel,
          source: isPinned ? "user_invariant" : "cloud_mesh",
          authority: isPinned ? 1.0 : 0.95,
          entityCategory: isPinned ? "rule" : "person",
          payload: {
            fullText: rawText,
            scope,
            triplets,
            rawMetadata: m.metadata || {},
          },
          createdAt: m.createdAt ? Number(new Date(m.createdAt)) : Date.now(),
          updatedAt: Date.now(),
        });
      }

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
