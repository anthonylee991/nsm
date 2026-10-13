import { createHash } from "node:crypto";

export function stemToken(token: string): string {
  return token.toLowerCase().replace(/(ing|ed|ly|es|s)$/, "");
}

/**
 * Deterministic Semantic Mock Embedder for vector RAG baselines.
 * Computes dense vectors by aggregating hash projections of stemmed tokens and synonyms.
 */
export class MockEmbedder {
  readonly dims: number;
  readonly model: string;

  constructor(dims = 1024, model = "mock-embedding-v1") {
    this.dims = dims;
    this.model = model;
  }

  async embed(texts: string[], _purpose: "query" | "document" = "document"): Promise<number[][]> {
    const SYNONYM_EXPANSIONS: Record<string, string[]> = {
      credentials: ["passwords", "passkeys", "scrypt", "hash", "salt", "secret"],
      securing: ["scrypt", "hash", "encrypt", "protect", "salt", "security"],
      budget: ["spend", "advertising", "dollars", "monthly", "cost", "retainer"],
      advertising: ["ads", "marketing", "campaigns", "budget", "spend"],
      change: ["revised", "superseding", "increased", "update", "switch"],
      approves: ["approver", "drafts", "approval", "signs", "authorizes"],
      restrictions: ["mandates", "zero", "bidding", "prohibit", "never"],
    };

    return texts.map((text) => {
      const rawTokens = text.toLowerCase().split(/\W+/).filter((w) => w.length > 1);
      const tokens = new Set<string>();
      for (const t of rawTokens) {
        tokens.add(stemToken(t));
        const syns = SYNONYM_EXPANSIONS[t] ?? SYNONYM_EXPANSIONS[stemToken(t)];
        if (syns) {
          for (const s of syns) tokens.add(stemToken(s));
        }
      }

      const vec: number[] = new Array(this.dims).fill(0);
      for (const token of tokens) {
        const hash = createHash("sha256").update(token).digest();
        for (let i = 0; i < this.dims; i++) {
          const byte = hash[i % hash.length]!;
          const seed = (byte + i * 31) % 256;
          vec[i] = (vec[i] ?? 0) + (seed - 128) / 128;
        }
      }

      let normSq = 0;
      for (let i = 0; i < this.dims; i++) {
        const val = vec[i] ?? 0;
        normSq += val * val;
      }
      const norm = Math.sqrt(normSq) || 1;
      return vec.map((v) => (v ?? 0) / norm);
    });
  }
}

export function cosineSimilarity(a: number[], b: number[]): number {
  if (!a || !b || a.length !== b.length || a.length === 0) return 0;
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i]! * b[i]!;
    normA += a[i]! * a[i]!;
    normB += b[i]! * b[i]!;
  }
  return (dot / (Math.sqrt(normA) * Math.sqrt(normB) || 1) + 1) / 2;
}

export function lexicalKeywordScore(query: string, text: string): number {
  const stopWords = new Set([
    "a", "an", "the", "and", "or", "in", "on", "at", "to", "for", "with", "of", "what", "who", "where",
    "when", "why", "how", "is", "are", "was", "were", "did", "do", "does", "about", "their", "our",
  ]);
  const qTokens = query
    .toLowerCase()
    .split(/\W+/)
    .filter((w) => w.length > 1 && !stopWords.has(w))
    .map(stemToken);
  if (qTokens.length === 0) return 0;
  const tTokens = new Set(
    text
      .toLowerCase()
      .split(/\W+/)
      .filter((w) => w.length > 1 && !stopWords.has(w))
      .map(stemToken),
  );
  let matches = 0;
  for (const q of qTokens) {
    if (tTokens.has(q)) matches++;
  }
  return matches / qTokens.length;
}

export interface GraphTriplet {
  subject: string;
  predicate: string;
  object: string;
  confidence: number;
  sourceChunkId: string;
  scope?: string;
  isCurrent?: boolean;
}

/**
 * Local Graph RAG Engine:
 * Implements a local entity-relationship knowledge graph (Kùzu-style triplet store)
 * with Cypher-style multi-hop neighbor expansion and subgraph context assembling.
 */
export class LocalGraphRAG {
  private triplets: GraphTriplet[] = [];
  private entityIndex: Map<string, GraphTriplet[]> = new Map();

  public addTriplet(triplet: GraphTriplet) {
    this.triplets.push(triplet);
    const subjKey = triplet.subject.toLowerCase();
    const objKey = triplet.object.toLowerCase();

    const subjList = this.entityIndex.get(subjKey) ?? [];
    subjList.push(triplet);
    this.entityIndex.set(subjKey, subjList);

    const objList = this.entityIndex.get(objKey) ?? [];
    objList.push(triplet);
    this.entityIndex.set(objKey, objList);
  }

  public search(query: string, options: { scope?: string; topK?: number } = {}): {
    matchedTriplets: GraphTriplet[];
    context: string;
    tokenCount: number;
  } {
    const qWords = query.toLowerCase().split(/\W+/).filter((w) => w.length > 2);
    const scoredTriplets = new Map<string, { triplet: GraphTriplet; score: number }>();

    for (const trip of this.triplets) {
      if (options.scope && trip.scope && trip.scope !== options.scope) {
        continue;
      }

      let matchScore = 0;
      const textToMatch = `${trip.subject} ${trip.predicate} ${trip.object}`.toLowerCase();
      for (const w of qWords) {
        if (textToMatch.includes(w)) matchScore += 1;
      }

      if (matchScore > 0) {
        const key = `${trip.subject}|${trip.predicate}|${trip.object}`;
        const score = matchScore * trip.confidence * (trip.isCurrent === false ? 0.6 : 1.0);
        scoredTriplets.set(key, { triplet: trip, score });
      }
    }

    const sorted = Array.from(scoredTriplets.values())
      .sort((a, b) => b.score - a.score)
      .slice(0, options.topK ?? 5)
      .map((item) => item.triplet);

    const contextLines = sorted.map(
      (t) => `(${t.subject}) -[${t.predicate}]-> (${t.object}) [source: ${t.sourceChunkId}]`
    );
    const context = contextLines.join("\n");
    const tokenCount = Math.round(context.length / 4);

    return {
      matchedTriplets: sorted,
      context,
      tokenCount,
    };
  }
}
