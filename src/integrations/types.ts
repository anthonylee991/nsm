import type { MemoryNode } from "../core/types.js";

export type ContextCategory =
  | "memory"
  | "calendar"
  | "documents"
  | "social"
  | "custom";

export interface IntegrationConfigField {
  key: string;
  label: string;
  type: "text" | "password" | "path" | "url";
  placeholder: string;
  required: boolean;
  description?: string;
  defaultValue?: string;
}

export type ConnectionStatus = "disconnected" | "connected" | "syncing" | "error";

export interface IntegrationProvider {
  id: string;
  name: string;
  category: ContextCategory;
  description: string;
  icon: string;
  configFields: IntegrationConfigField[];
  status: ConnectionStatus;
  lastSyncedAt?: number;
  errorMessage?: string;

  connect(config: Record<string, any>): Promise<void>;
  disconnect(): Promise<void>;
  sync(): Promise<MemoryNode[]>;
}

export interface CategorySummary {
  id: ContextCategory;
  title: string;
  icon: string;
  description: string;
  providers: IntegrationProvider[];
}
