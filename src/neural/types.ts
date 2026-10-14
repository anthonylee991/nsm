/**
 * Optional local neural components. NSM runs without them; when configured they run in-process
 * (no network, no API key) and add a dense leg to retrieval and/or a cross-encoder rerank.
 */
export interface Embedder {
  readonly name: string;
  readonly dims: number;
  /** Unit-length vectors, one per text. */
  embed(texts: string[], purpose: "query" | "document"): Promise<Float32Array[]>;
  dispose?(): Promise<void>;
}

export interface Reranker {
  readonly name: string;
  /** One relevance score per text (higher = more relevant to the query). */
  score(query: string, texts: string[]): Promise<number[]>;
  dispose?(): Promise<void>;
}

export interface NeuralConfig {
  /** Dense leg: embed memories at ingest and the query at recall; fused with the lexical legs by RRF. */
  embedder?: Embedder;
  /** Cross-encoder rerank of the top `rerankCandidates` memories after retrieval. */
  reranker?: Reranker;
  /** How many dense hits to fuse (default: the lexical limit). */
  denseLimit?: number;
  /** Weight of the dense leg in the rank fusion relative to each lexical leg (default 1). */
  denseWeight?: number;
  /** How many memories the reranker scores (default 50). */
  rerankCandidates?: number;
}
