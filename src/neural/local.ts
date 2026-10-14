import { homedir } from "node:os";
import { resolve } from "node:path";
import type { Embedder, Reranker } from "./types.js";

/**
 * Local models through @huggingface/transformers (ONNX, CPU). The package is an optional
 * dependency and is imported only when one of these classes is constructed, so a mesh without
 * neural components never loads it.
 *
 * Models are downloaded once into `modelDir` (default `$NSM_MODEL_DIR` or ~/.nsm/models).
 */
export type LocalDtype = "fp32" | "fp16" | "q8" | "int8";

export interface LocalModelOptions {
  modelDir?: string;
  dtype?: LocalDtype;
}

export const DEFAULT_EMBED_MODEL = "Xenova/all-MiniLM-L6-v2";
export const DEFAULT_RERANK_MODEL = "Xenova/ms-marco-MiniLM-L-6-v2";

function modelDir(opt?: string): string {
  return opt ?? process.env.NSM_MODEL_DIR ?? resolve(homedir(), ".nsm", "models");
}

async function transformers(dir: string) {
  const mod = await import("@huggingface/transformers");
  mod.env.cacheDir = dir;
  mod.env.allowLocalModels = false;
  return mod;
}

export class LocalEmbedder implements Embedder {
  readonly name: string;
  dims = 0;
  private pipe: any = null;
  private loading: Promise<void> | null = null;
  private readonly dir: string;
  private readonly dtype: LocalDtype;

  constructor(model: string = DEFAULT_EMBED_MODEL, options: LocalModelOptions = {}) {
    this.name = model;
    this.dir = modelDir(options.modelDir);
    this.dtype = options.dtype ?? "fp32";
  }

  private async load() {
    if (this.pipe) return;
    if (!this.loading) {
      this.loading = (async () => {
        const t = await transformers(this.dir);
        this.pipe = await t.pipeline("feature-extraction", this.name, { dtype: this.dtype });
      })();
    }
    await this.loading;
  }

  async embed(texts: string[], _purpose: "query" | "document"): Promise<Float32Array[]> {
    if (texts.length === 0) return [];
    await this.load();
    const out = await this.pipe(texts, { pooling: "mean", normalize: true });
    const [n, d] = out.dims as [number, number];
    this.dims = d;
    const data = out.data as Float32Array;
    const vecs: Float32Array[] = [];
    for (let i = 0; i < n; i++) vecs.push(data.slice(i * d, (i + 1) * d));
    return vecs;
  }

  async dispose() {
    if (this.pipe) await this.pipe.dispose?.();
    this.pipe = null;
    this.loading = null;
  }
}

export class LocalReranker implements Reranker {
  readonly name: string;
  private tok: any = null;
  private model: any = null;
  private loading: Promise<void> | null = null;
  private readonly dir: string;
  private readonly dtype: LocalDtype;

  constructor(model: string = DEFAULT_RERANK_MODEL, options: LocalModelOptions = {}) {
    this.name = model;
    this.dir = modelDir(options.modelDir);
    this.dtype = options.dtype ?? "fp32";
  }

  private async load() {
    if (this.model) return;
    if (!this.loading) {
      this.loading = (async () => {
        const t = await transformers(this.dir);
        this.tok = await t.AutoTokenizer.from_pretrained(this.name);
        this.model = await t.AutoModelForSequenceClassification.from_pretrained(this.name, { dtype: this.dtype });
      })();
    }
    await this.loading;
  }

  async score(query: string, texts: string[]): Promise<number[]> {
    if (texts.length === 0) return [];
    await this.load();
    const scores: number[] = [];
    // Batches keep peak memory bounded on long candidate lists.
    for (let i = 0; i < texts.length; i += 16) {
      const batch = texts.slice(i, i + 16);
      const enc = this.tok(new Array(batch.length).fill(query), { text_pair: batch, padding: true, truncation: true });
      const out = await this.model(enc);
      scores.push(...Array.from(out.logits.data as Float32Array));
    }
    return scores;
  }

  async dispose() {
    await this.model?.dispose?.();
    this.model = null;
    this.tok = null;
    this.loading = null;
  }
}
