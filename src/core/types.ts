export type NodeType =
  | 'invariant'
  | 'fact'
  | 'event'
  | 'profile'
  | 'note'
  | 'person'
  | 'concept'
  | 'location'
  | 'organization'
  | 'rule'
  | 'custom';

export type EntityCategory =
  | 'person'
  | 'organization'
  | 'place'
  | 'event'
  | 'rule'
  | 'concept'
  | 'general';

export interface MemoryNode {
  id: string;
  nodeType: NodeType;
  label: string;
  source: string; // e.g. 'user_invariant', 'user_fact', 'local_notes', 'calendar', 'cloud_mesh', 'ambient_signal'
  payload: Record<string, any>;
  authority?: number; // Epistemic authority weight [0.0 - 1.0]
  entityCategory?: EntityCategory;
  createdAt: number;
  updatedAt: number;
}

// Backward-compatible alias
export type ContextNode = MemoryNode;

export interface MemoryEdge {
  sourceId: string;
  targetId: string;
  relation: string; // e.g. 'co_occurs_with', 'scheduled_on', 'located_at', ':SUPERSEDES', 'has_role'
  weight: number;   // Synaptic strength / Pheromone level [0.0 - 1.0]
  lastActivated: number;
}

// Backward-compatible alias
export type ContextEdge = MemoryEdge;

export interface ScoredMemoryNode {
  node: MemoryNode;
  score: number;
  matchReasons: string[];
}

// Backward-compatible alias
export type ScoredNode = ScoredMemoryNode;

export const DEFAULT_SOURCE_AUTHORITY: Record<string, number> = {
  user_invariant: 1.0,
  user_fact: 1.0,
  rule_explicit: 1.0,
  cloud_mesh: 0.95,
  memvault: 0.95,
  calendar: 0.90,
  local_notes: 0.85,
  obsidian: 0.85,
  ambient_signal: 0.75,
  public_scraper: 0.60,
  social_feed: 0.60,
  inferred: 0.50,
};

export interface MemoryQueryOptions {
  /** Maximum candidate seeds retrieved via lexical hybrid search (default: 16) */
  lexicalLimit?: number;
  /** Maximum graph hops for spreading activation (default: 2) */
  maxHops?: number;
  /** Energy decay rate per hop (default: 0.45) */
  hopDecay?: number;
  /** Minimum activation energy threshold to continue spreading (default: 0.05) */
  minEnergyThreshold?: number;
  /** Maximum items retained per semantic category after lateral inhibition (default: 3) */
  lateralInhibitionMaxPerCategory?: number;
  /** External ambient key-value map to merge into PAE context */
  ambientContext?: Record<string, string>;
  /** Optional predicate hook to guarantee inclusion of domain-critical invariant nodes */
  guaranteedFilter?: (node: MemoryNode, query: string) => boolean;
}

export interface RetrievalTelemetry {
  seedCount: number;
  activatedCount: number;
  salientCount: number;
  searchDurationMs: number;
  activationDurationMs: number;
  inhibitionDurationMs: number;
  totalDurationMs: number;
}

export interface RetrievalResult {
  /** Top salient nodes after lexical RRF, spreading activation, and lateral inhibition */
  salientNodes: ScoredMemoryNode[];
  /** Candidate seeds initially matched by lexical scouts */
  seedNodes: ScoredMemoryNode[];
  /** Formatted Peripheral Attention Engineering (PAE) compact context window (<150-250 tokens) */
  paePrompt: string;
  /** Performance telemetry */
  telemetry: RetrievalTelemetry;
}

export interface ConsultationRecord {
  id: string;
  query: string;
  salientNodes: string[];
  ambientSummary?: string;
  recalledSummary?: string;
  metadata?: Record<string, any>;
  createdAt: number;
}
