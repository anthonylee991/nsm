import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";

/** Everything NSM stores lives under one directory: $NSM_HOME or ~/.nsm. */
export function nsmHome(): string {
  const dir = process.env.NSM_HOME ?? resolve(homedir(), ".nsm");
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return dir;
}

export function dbPath(): string {
  return process.env.NSM_DB ?? resolve(nsmHome(), "memory.db");
}

export function modelDir(): string {
  return process.env.NSM_MODEL_DIR ?? resolve(nsmHome(), "models");
}

export interface NsmConfig {
  /** Use the local models (dense leg + rerank). Set by `nsm models install`. */
  neural: boolean;
  embedModel: string;
  rerankModel: string;
  /** Memories returned by recall when the caller does not say. */
  k: number;
}

export const DEFAULT_CONFIG: NsmConfig = {
  neural: false,
  embedModel: "Xenova/bge-small-en-v1.5",
  rerankModel: "Xenova/ms-marco-MiniLM-L-6-v2",
  k: 10,
};

export function configPath(): string {
  return resolve(nsmHome(), "config.json");
}

export function loadConfig(): NsmConfig {
  const p = configPath();
  if (!existsSync(p)) return { ...DEFAULT_CONFIG };
  try {
    const raw = JSON.parse(readFileSync(p, "utf8")) as Partial<NsmConfig>;
    return { ...DEFAULT_CONFIG, ...raw };
  } catch {
    return { ...DEFAULT_CONFIG };
  }
}

export function saveConfig(cfg: NsmConfig): void {
  writeFileSync(configPath(), JSON.stringify(cfg, null, 2) + "\n");
}
