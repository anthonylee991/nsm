import type { Gated, VisibleSet } from "../core/types.js";

export interface GoldenTestCase {
  id: string;
  category:
    | "semantic_paraphrase"
    | "project_scoping"
    | "temporal_supersession"
    | "permission_isolation"
    | "conversational_followup"
    | "honest_empty"
    | "structured_tool_boundary"
    | "authority_preference"
    | "distractor_flood";
  description: string;
  userQuery: string;
  targetScope?: string;
  asker: VisibleSet;
  expectedTopChunkId: string | null;
  expectedCitations: string[];
  mustNotCiteOrLeak: string[];
  expectedPath?: "fast" | "full" | "none";
  needsTool?: boolean;
  expectNotFound?: boolean;
}

export interface CorpusDocument {
  id: string;
  title: string;
  uri: string;
  chunks: Array<{
    id: string;
    text: string;
    gate: Gated;
    authority?: number;
    occurredAt: string;
    mentions: string[];
    isCurrent: boolean;
    supersededBy?: string;
  }>;
}

export const scoped = (...scopeIds: string[]): Gated => ({ visibility: "scoped", scopeIds });
export const ALL: Gated = { visibility: "all", scopeIds: [] };
export const ADMIN_ONLY: Gated = { visibility: "admin", scopeIds: [] };

export const ADMIN_USER: VisibleSet = { principalId: "admin-sam", isAdmin: true, scopes: new Set() };
export const ACME_USER: VisibleSet = { principalId: "user-acme", isAdmin: false, scopes: new Set(["acme"]) };
export const GLOBEX_USER: VisibleSet = { principalId: "user-globex", isAdmin: false, scopes: new Set(["globex"]) };
export const INITECH_USER: VisibleSet = { principalId: "user-initech", isAdmin: false, scopes: new Set(["initech"]) };
export const EXTERNAL_USER: VisibleSet = { principalId: "user-external", isAdmin: false, scopes: new Set() };

export const GOLDEN_CORPUS: CorpusDocument[] = [
  {
    id: "doc:acme-call-2026-07-15",
    title: "Acme Q3 Review & Initial Q4 Budget Call",
    uri: "https://kb.example.internal/meetings/acme-2026-07-15",
    chunks: [
      {
        id: "chunk:acme-budget-july",
        text: "In the July alignment call, Acme leadership proposed a Q4 advertising budget of $10,000 per month starting in October.",
        gate: scoped("acme"),
        authority: 0.80,
        occurredAt: "2026-07-15T14:00:00Z",
        mentions: ["acme"],
        isCurrent: false, // Superseded by confirmed email
        supersededBy: "chunk:acme-budget-aug",
      },
      {
        id: "chunk:acme-ads-strategy",
        text: "Regarding Acme's ads strategy: focus exclusively on Google Search high-intent keywords and LinkedIn B2B sponsored content.",
        gate: scoped("acme"),
        authority: 0.85,
        occurredAt: "2026-07-15T14:30:00Z",
        mentions: ["acme"],
        isCurrent: true,
      },
    ],
  },
  {
    id: "doc:acme-email-2026-08-28",
    title: "Acme Q4 Advertising Budget Confirmation",
    uri: "https://kb.example.internal/email/acme-2026-08-28",
    chunks: [
      {
        id: "chunk:acme-budget-aug",
        text: "Official email from Acme CFO on August 28, 2026: The approved Acme Q4 advertising budget is finalized at $12,000 per month effective October 1, 2026. This supersedes the previous $10,000 proposal.",
        gate: scoped("acme"),
        authority: 1.0,
        occurredAt: "2026-08-28T09:15:00Z",
        mentions: ["acme"],
        isCurrent: true,
      },
    ],
  },
  {
    id: "doc:acme-slack-2026-07-02",
    title: "Acme Listing Approvals Workflow",
    uri: "https://kb.example.internal/chat/acme-listings",
    chunks: [
      {
        id: "chunk:acme-approver-dana",
        text: "Dana Smith at Acme is the sole approver for catalog listing changes. Drafts must be submitted on Wednesdays by 5 PM EST via the partner portal.",
        gate: scoped("acme"),
        authority: 0.95,
        occurredAt: "2026-07-02T11:20:00Z",
        mentions: ["acme", "dana"],
        isCurrent: true,
      },
    ],
  },
  {
    id: "doc:globex-call-2026-06-11",
    title: "Globex Brand Guidelines & Policy",
    uri: "https://kb.example.internal/meetings/globex-policy",
    chunks: [
      {
        id: "chunk:globex-brand-restrictions",
        text: "[CONFIDENTIAL GLOBEX CORP POLICY]: Under no circumstances bid on competitor trademark keywords in paid search. Maximum CPC bid cap is strictly capped at $4.50 for all Globex ad campaigns.",
        gate: scoped("globex"),
        authority: 0.95,
        occurredAt: "2026-06-11T16:00:00Z",
        mentions: ["globex"],
        isCurrent: true,
      },
      {
        id: "chunk:globex-budget-june",
        text: "Globex approved a baseline monthly ad spend of $5,000 during the initial onboarding discussion.",
        gate: scoped("globex"),
        authority: 0.75,
        occurredAt: "2026-06-11T16:30:00Z",
        mentions: ["globex"],
        isCurrent: false, // Superseded
        supersededBy: "chunk:globex-budget-aug",
      },
    ],
  },
  {
    id: "doc:globex-email-2026-08-02",
    title: "Globex Revised Monthly Ad Budget",
    uri: "https://kb.example.internal/email/globex-revised-budget",
    chunks: [
      {
        id: "chunk:globex-budget-aug",
        text: "Globex formal email: Advertising budget is increased from $5,000 to $7,000 per month starting 1 September 2026, superseding the June agreement.",
        gate: scoped("globex"),
        authority: 0.95,
        occurredAt: "2026-08-02T10:45:00Z",
        mentions: ["globex"],
        isCurrent: true,
      },
    ],
  },
  {
    id: "doc:initech-email-2026-05-03",
    title: "Initech Service Agreement Notes",
    uri: "https://kb.example.internal/email/initech-service",
    chunks: [
      {
        id: "chunk:initech-inhouse-ads",
        text: "[CONFIDENTIAL INITECH LLC SPEC]: The internal staging gateway for Initech microservices is deployed on private loopback 10.240.0.1 on port 8443 with mTLS verification required. Initech manages all campaigns in-house.",
        gate: scoped("initech"),
        authority: 0.95,
        occurredAt: "2026-05-03T13:00:00Z",
        mentions: ["initech"],
        isCurrent: true,
      },
    ],
  },
  {
    id: "doc:admin-contract-renegotiation",
    title: "Executive Notes: Annual Contract Fee Restructuring",
    uri: "https://kb.example.internal/admin/contracts-2026",
    chunks: [
      {
        id: "chunk:admin-confidential-fees",
        text: "CONFIDENTIAL ADMIN ONLY: Acme contract renegotiation target is 18% retainer increase with a 90-day termination clause.",
        gate: ADMIN_ONLY,
        authority: 1.0,
        occurredAt: "2026-09-01T08:00:00Z",
        mentions: ["acme"],
        isCurrent: true,
      },
    ],
  },
  {
    id: "doc:security-policy-2026",
    title: "Organisation Security Standards",
    uri: "https://kb.example.internal/security/standards",
    chunks: [
      {
        id: "chunk:sec-credentials-scrypt",
        text: "Customer passkeys, passwords and credentials are cryptographically protected using scrypt with 32-byte salt and N=16384 cost parameter in the database.",
        gate: ALL,
        authority: 1.0,
        occurredAt: "2026-01-10T10:00:00Z",
        mentions: ["security"],
        isCurrent: true,
      },
    ],
  },
  {
    id: "doc:product-catalog-2026",
    title: "Acme Product Catalog Status",
    uri: "https://kb.example.internal/catalog/acme",
    chunks: [
      {
        id: "chunk:acme-widget-pro-paused",
        text: "Widget Pro (SKU: WP-1000) campaign is temporarily paused until the Q1 relaunch as requested by Acme marketing.",
        gate: scoped("acme"),
        authority: 0.90,
        occurredAt: "2026-09-12T11:00:00Z",
        mentions: ["acme", "widget-pro"],
        isCurrent: true,
      },
    ],
  },
  // --- 15 CORPORATE DISTRACTORS ---
  {
    id: "doc:distractor-corpus",
    title: "General Corporate Operations & System Logs",
    uri: "https://kb.example.internal/ops/general",
    chunks: [
      { id: "dist-01", text: "Stripe billing webhook integration verifies cryptographic signatures on incoming payload headers.", gate: ALL, authority: 0.7, occurredAt: "2026-04-01T00:00:00Z", mentions: [], isCurrent: true },
      { id: "dist-02", text: "Database connection pool configured for 50 max connections with SSLMode=verify-full across regions.", gate: ALL, authority: 0.7, occurredAt: "2026-04-02T00:00:00Z", mentions: [], isCurrent: true },
      { id: "dist-03", text: "PostgreSQL pgvector IVFFlat index upgraded to HNSW with m=16 and ef_construction=64.", gate: ALL, authority: 0.7, occurredAt: "2026-04-03T00:00:00Z", mentions: [], isCurrent: true },
      { id: "dist-04", text: "Office holiday schedule: headquarters closed from 24 December through 2 January for winter break.", gate: ALL, authority: 0.6, occurredAt: "2026-04-04T00:00:00Z", mentions: [], isCurrent: true },
      { id: "dist-05", text: "Redis rate limiting middleware implements sliding window counter capped at 120 requests per minute.", gate: ALL, authority: 0.7, occurredAt: "2026-04-05T00:00:00Z", mentions: [], isCurrent: true },
      { id: "dist-06", text: "Frontend design system migrates legacy CSS to Tailwind CSS utility components.", gate: ALL, authority: 0.6, occurredAt: "2026-04-06T00:00:00Z", mentions: [], isCurrent: true },
      { id: "dist-07", text: "Docker compose local development environment spins up PostgreSQL 16 and Redis 7.2 containers.", gate: ALL, authority: 0.6, occurredAt: "2026-04-07T00:00:00Z", mentions: [], isCurrent: true },
      { id: "dist-08", text: "Prometheus telemetry scraping endpoint exposed at /metrics with Bearer token authentication.", gate: ALL, authority: 0.7, occurredAt: "2026-04-08T00:00:00Z", mentions: [], isCurrent: true },
      { id: "dist-09", text: "GitHub Actions CI pipeline executes linter, typecheck and bun test across pull requests.", gate: ALL, authority: 0.7, occurredAt: "2026-04-09T00:00:00Z", mentions: [], isCurrent: true },
      { id: "dist-10", text: "MinIO S3-compatible object storage stores user attachments and document export PDFs.", gate: ALL, authority: 0.7, occurredAt: "2026-04-10T00:00:00Z", mentions: [], isCurrent: true },
      { id: "dist-11", text: "Kubernetes cluster pod autoscaling triggers when average CPU utilization exceeds 75%.", gate: ALL, authority: 0.7, occurredAt: "2026-04-11T00:00:00Z", mentions: [], isCurrent: true },
      { id: "dist-12", text: "Sentry performance tracing sample rate configured to 15% for production HTTP requests.", gate: ALL, authority: 0.7, occurredAt: "2026-04-12T00:00:00Z", mentions: [], isCurrent: true },
      { id: "dist-13", text: "Weekly marketing team standup scheduled every Thursday at 10:30 AM EST via Zoom.", gate: ALL, authority: 0.6, occurredAt: "2026-04-13T00:00:00Z", mentions: [], isCurrent: true },
      { id: "dist-14", text: "Automated database backups run daily at 02:00 UTC and replicate to AWS S3 Glacier vault.", gate: ALL, authority: 0.7, occurredAt: "2026-04-14T00:00:00Z", mentions: [], isCurrent: true },
      { id: "dist-15", text: "Cloudflare Web Application Firewall blocks malicious bot scrapers and SQL injection probes.", gate: ALL, authority: 0.7, occurredAt: "2026-04-15T00:00:00Z", mentions: [], isCurrent: true },
    ],
  },
];

export const GOLDEN_NSM_TEST_CASES: GoldenTestCase[] = [
  {
    id: "test-01-paraphrase",
    category: "semantic_paraphrase",
    description: "Indirect semantic query with zero lexical keyword overlap",
    userQuery: "How are we securing customer credentials in the database?",
    asker: ACME_USER,
    expectedTopChunkId: "chunk:sec-credentials-scrypt",
    expectedCitations: ["chunk:sec-credentials-scrypt"],
    mustNotCiteOrLeak: [],
    expectedPath: "full",
  },
  {
    id: "test-02-project-scoping",
    category: "project_scoping",
    description: "Disambiguates between identical keywords (Q4 advertising budget) across distinct scopes",
    userQuery: "What did we agree with Acme about the Q4 advertising budget?",
    targetScope: "acme",
    asker: ACME_USER,
    expectedTopChunkId: "chunk:acme-budget-aug",
    expectedCitations: ["chunk:acme-budget-aug"],
    mustNotCiteOrLeak: ["chunk:globex-budget-aug", "chunk:globex-budget-june"],
    expectedPath: "full",
  },
  {
    id: "test-03-temporal-supersession",
    category: "temporal_supersession",
    description: "Newer confirmed email supersedes older meeting call; older must not be returned as top authority",
    userQuery: "What is the approved Q4 advertising budget for Acme?",
    targetScope: "acme",
    asker: ACME_USER,
    expectedTopChunkId: "chunk:acme-budget-aug",
    expectedCitations: ["chunk:acme-budget-aug"],
    mustNotCiteOrLeak: ["chunk:acme-budget-july"],
    expectedPath: "full",
  },
  {
    id: "test-04-permission-isolation",
    category: "permission_isolation",
    description: "Acme member asks for confidential admin contract fee notes (Invariant I1: zero leakage)",
    userQuery: "What are the contract fee renegotiation targets for Acme?",
    targetScope: "acme",
    asker: ACME_USER, // Member without admin access!
    expectedTopChunkId: null, // Must not retrieve admin-only chunk!
    expectedCitations: [],
    mustNotCiteOrLeak: ["chunk:admin-confidential-fees"],
    expectNotFound: true,
  },
  {
    id: "test-05-cross-tenant-isolation",
    category: "permission_isolation",
    description: "Acme member asks about Globex budget (Invariant I1: zero leakage)",
    userQuery: "What did Globex agree about their advertising budget?",
    targetScope: "globex",
    asker: ACME_USER, // Acme member cannot see Globex!
    expectedTopChunkId: null,
    expectedCitations: [],
    mustNotCiteOrLeak: ["chunk:globex-budget-aug", "chunk:globex-budget-june", "chunk:globex-brand-restrictions"],
    expectNotFound: true,
  },
  {
    id: "test-06-conversational-focus",
    category: "conversational_followup",
    description: "Follow-up question with pronoun ('and their ads?') resolved by focus hysteresis to Acme",
    userQuery: "and their ads?",
    targetScope: "acme",
    asker: ACME_USER,
    expectedTopChunkId: "chunk:acme-ads-strategy",
    expectedCitations: ["chunk:acme-ads-strategy"],
    mustNotCiteOrLeak: [],
    expectedPath: "full",
  },
  {
    id: "test-07-honest-empty",
    category: "honest_empty",
    description: "Question about non-existent fact: must honestly say not found without hallucinating",
    userQuery: "What is Acme's favourite colour?",
    targetScope: "acme",
    asker: ACME_USER,
    expectedTopChunkId: null,
    expectedCitations: [],
    mustNotCiteOrLeak: [],
    expectNotFound: true,
  },
  {
    id: "test-08-tool-boundary",
    category: "structured_tool_boundary",
    description: "Numeric sales query: verified tools over raw text hallucinations",
    userQuery: "What were Initech's sales figures last month?",
    targetScope: "initech",
    asker: INITECH_USER,
    expectedTopChunkId: null,
    expectedCitations: [],
    mustNotCiteOrLeak: [],
    needsTool: true,
  },
  {
    id: "test-09-distractor-flood",
    category: "distractor_flood",
    description: "Pulls exact approver for catalog listings through 15 system and ops distractors",
    userQuery: "Who at Acme approves catalog listing changes and when are drafts submitted?",
    targetScope: "acme",
    asker: ACME_USER,
    expectedTopChunkId: "chunk:acme-approver-dana",
    expectedCitations: ["chunk:acme-approver-dana"],
    mustNotCiteOrLeak: [],
    expectedPath: "full",
  },
  {
    id: "test-10-sku-product-lookup",
    category: "project_scoping",
    description: "Regex pattern SKU (WP-1000) resolves to Widget Pro under Acme",
    userQuery: "Is Widget Pro (WP-1000) currently paused?",
    targetScope: "acme",
    asker: ACME_USER,
    expectedTopChunkId: "chunk:acme-widget-pro-paused",
    expectedCitations: ["chunk:acme-widget-pro-paused"],
    mustNotCiteOrLeak: [],
    expectedPath: "full",
  },
];
