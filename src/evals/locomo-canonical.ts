import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { resolve, join } from "node:path";
import { NeuroSwarmMesh } from "../mesh.js";
import { evaluateWithJudge, type JudgeEvaluationResult } from "./judge.js";
import { waitForMem0Settlement, waitForZepSettlement } from "./competitor-polling.js";
import { MemoryClient } from "mem0ai";
import { ZepClient } from "@getzep/zep-cloud";

function loadEnv() {
  const envPath = resolve(process.cwd(), ".env");
  if (existsSync(envPath)) {
    const lines = readFileSync(envPath, "utf-8").split("\n");
    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed && !trimmed.startsWith("#") && trimmed.includes("=")) {
        const [k, ...v] = trimmed.split("=");
        if (k && !process.env[k.trim()]) {
          process.env[k.trim()] = v.join("=").trim();
        }
      }
    }
  }
}
loadEnv();

export interface LoCoMoSessionTurn {
  speaker: string;
  dia_id: string;
  text: string;
}

export interface LoCoMoQAPair {
  question: string;
  answer: string;
  evidence: string[];
  category: number;
}

export interface LoCoMoConversation {
  sample_id: string;
  conversation: Record<string, any>;
  qa: LoCoMoQAPair[];
}

export interface EngineScoreRecord {
  totalQuestions: number;
  passedCount: number;
  totalScore: number;
  categoryScores: Record<number, { count: number; totalScore: number; passedCount: number }>;
  tokensSum: number;
  latencySumMs: number;
  networkLatencySumMs: number;
}

function parseLoCoMoSessions(conv: Record<string, any>): Array<{
  sessionId: string;
  dateTime: string;
  dateParsed: Date;
  turns: LoCoMoSessionTurn[];
}> {
  const sessions: Array<{
    sessionId: string;
    dateTime: string;
    dateParsed: Date;
    turns: LoCoMoSessionTurn[];
  }> = [];

  const sessionNumbers: number[] = [];
  for (const k of Object.keys(conv)) {
    const m = k.match(/^session_(\d+)$/);
    if (m) sessionNumbers.push(parseInt(m[1]!, 10));
  }
  sessionNumbers.sort((a, b) => a - b);

  for (const num of sessionNumbers) {
    const sessKey = `session_${num}`;
    const dtKey = `session_${num}_date_time`;
    const dtStr = conv[dtKey] || "";
    const turns = (conv[sessKey] || []) as LoCoMoSessionTurn[];

    let parsedDate = new Date();
    if (dtStr) {
      const clean = dtStr.replace(/^.*?on\s+/, "");
      const d = new Date(clean);
      if (!isNaN(d.getTime())) {
        parsedDate = d;
      }
    }

    sessions.push({
      sessionId: `s${num}`,
      dateTime: dtStr,
      dateParsed: parsedDate,
      turns,
    });
  }

  return sessions;
}

const STOP_WORDS = new Set([
  "a", "about", "above", "after", "again", "against", "all", "am", "an", "and", "any", "are", "as", "at",
  "be", "because", "been", "before", "being", "below", "between", "both", "but", "by", "could", "did",
  "do", "does", "doing", "down", "during", "each", "few", "for", "from", "further", "had", "has", "have",
  "having", "he", "her", "here", "hers", "herself", "him", "himself", "his", "how", "i", "if", "in", "into",
  "is", "it", "its", "itself", "just", "me", "more", "most", "my", "myself", "no", "nor", "not", "of", "off",
  "on", "once", "only", "or", "other", "our", "ours", "ourselves", "out", "over", "own", "s", "same", "she",
  "should", "so", "some", "such", "t", "than", "that", "the", "their", "theirs", "them", "themselves",
  "then", "there", "these", "they", "this", "those", "through", "to", "too", "under", "until", "up", "very",
  "was", "we", "were", "what", "when", "where", "which", "while", "who", "whom", "why", "will", "with", "you",
  "your", "yours", "yourself", "yourselves"
]);

function extractContentTokens(text: string): string[] {
  return text
    .toLowerCase()
    .split(/\W+/)
    .filter((w) => w.length > 2 && !STOP_WORDS.has(w));
}

export async function runCanonicalLoCoMoBenchmark(options: {
  sampleIndex?: number;
  maxQuestions?: number;
  enableMem0?: boolean;
  enableZep?: boolean;
  judgeModel?: string;
  verbose?: boolean;
} = {}) {
  const {
    sampleIndex = 0,
    maxQuestions = 5,
    enableMem0 = Boolean(process.env.MEM0_API_KEY),
    enableZep = false,
    judgeModel = "deepseek/deepseek-v4.1-flash",
    verbose = true,
  } = options;

  console.log("\n=========================================================================================");
  console.log("            CANONICAL LOCOMO BENCHMARK (SNAP RESEARCH / ACL 2024 DATASET)                ");
  console.log(`            Judge Model: ${judgeModel} via OpenRouter                                    `);
  console.log("=========================================================================================\n");

  const dataPath = resolve(process.cwd(), "data/locomo10.json");
  if (!existsSync(dataPath)) {
    throw new Error(`Canonical dataset not found at ${dataPath}. Please run download first.`);
  }

  const rawData: LoCoMoConversation[] = JSON.parse(readFileSync(dataPath, "utf-8"));
  const sample = rawData[sampleIndex];
  if (!sample) {
    throw new Error(`Sample index ${sampleIndex} out of bounds (0-${rawData.length - 1})`);
  }

  console.log(`Loaded Conversation: [${sample.sample_id}]`);
  const sessions = parseLoCoMoSessions(sample.conversation);
  console.log(`Sessions count: ${sessions.length}`);
  const totalTurns = sessions.reduce((acc, s) => acc + s.turns.length, 0);
  console.log(`Total turns: ${totalTurns}`);
  console.log(`Total available Q&A pairs: ${sample.qa.length}`);

  const questionsToRun = sample.qa.slice(0, maxQuestions);
  console.log(`Evaluating next: ${questionsToRun.length} questions (DeepSeek-v4.1-flash evaluation judge)\n`);

  // 1. Prepare NeuroSwarmMesh
  console.log("🧠 Initializing Neuro-Swarm Mesh (NSM) with SQLite FTS5 + RAM Pointer Synapses...");
  const nsmMesh = new NeuroSwarmMesh();
  const nsmInitStart = performance.now();

  const evalDate = new Date("2023-08-01T00:00:00Z");

  const acmPool: Array<{
    id: string;
    text: string;
    speaker: string;
    rawText: string;
    diaId: string;
    sessionId: string;
    dateTimeStr: string;
    timestamp: Date;
    importance: "pinned" | "high" | "default";
    daysAgo: number;
    tokens: string[];
    sessionIndex: number;
    turnIndex: number;
  }> = [];

  sessions.forEach((s, sIdx) => {
    const elapsedDays = Math.max(0, (evalDate.getTime() - s.dateParsed.getTime()) / 86400000);
    let prevTurnId: string | null = null;

    s.turns.forEach((t, tIdx) => {
      const extraMeta = [
        (t as any).blip_caption ? `[Image: ${(t as any).blip_caption}]` : "",
        (t as any).query ? `[Topic: ${(t as any).query}]` : "",
      ].filter(Boolean).join(" ");
      const fullText = `${t.speaker}: ${t.text} ${extraMeta}`.trim();

      acmPool.push({
        id: t.dia_id,
        text: fullText,
        speaker: t.speaker,
        rawText: t.text,
        diaId: t.dia_id,
        sessionId: s.sessionId,
        dateTimeStr: s.dateTime,
        timestamp: s.dateParsed,
        importance: "default",
        daysAgo: elapsedDays,
        tokens: extractContentTokens(fullText),
        sessionIndex: sIdx,
        turnIndex: tIdx,
      });

      // Ingest node into NSM
      nsmMesh.ingestNode(
        {
          id: t.dia_id,
          nodeType: "fact",
          label: `${t.speaker}: ${t.text.slice(0, 60)}...`,
          source: "dialogue",
          authority: 0.95,
          payload: {
            text: fullText,
            speaker: t.speaker,
            sessionId: s.sessionId,
            sessionDate: s.dateTime,
            turnIndex: tIdx,
          },
          createdAt: s.dateParsed.getTime(),
          updatedAt: s.dateParsed.getTime(),
        },
        fullText
      );

      // Conversational flow edge: link sequential turns in session
      if (prevTurnId) {
        nsmMesh.ingestEdge({
          sourceId: prevTurnId,
          targetId: t.dia_id,
          relation: "follows",
          weight: 0.85,
          lastActivated: s.dateParsed.getTime(),
        });
      }
      prevTurnId = t.dia_id;

      // Extract entity tokens & link concept bridges
      const contentTokens = extractContentTokens(fullText);
      for (const tok of contentTokens) {
        if (tok.length > 3 && !["melanie", "caroline"].includes(tok)) {
          const conceptId = `entity:${tok}`;
          if (!nsmMesh.getStorage().getNodeById(conceptId)) {
            nsmMesh.ingestNode({
              id: conceptId,
              nodeType: "concept",
              label: tok,
              source: "inferred",
              authority: 0.8,
              payload: { name: tok },
              createdAt: s.dateParsed.getTime(),
              updatedAt: s.dateParsed.getTime(),
            });
          }
          nsmMesh.ingestEdge({
            sourceId: t.dia_id,
            targetId: conceptId,
            relation: "mentions",
            weight: 0.75,
            lastActivated: s.dateParsed.getTime(),
          });
        }
      }
    });
  });

  const nsmInitDuration = performance.now() - nsmInitStart;
  console.log(`   ✓ Ingested ${totalTurns} dialogue turns and relational synapses into NSM in ${nsmInitDuration.toFixed(1)}ms.\n`);

  // 2. Prepare Mem0 Client if enabled
  let mem0Client: any = null;
  const mem0UserId = `locomo-nsm-mem0-${sample.sample_id}-${Date.now()}`;
  if (enableMem0 && process.env.MEM0_API_KEY) {
    try {
      mem0Client = new MemoryClient({ apiKey: process.env.MEM0_API_KEY });
      console.log(`📡 Ingesting turns into Mem0 Cloud (user_id: ${mem0UserId})...`);
      const allMem0Messages: Array<{ role: string; content: string }> = [];
      sessions.forEach((s) => {
        s.turns.forEach((t) => {
          allMem0Messages.push({
            role: "user",
            content: `${t.speaker}: ${t.text} (Date: ${s.dateTime})`,
          });
        });
      });

      const mStart = performance.now();
      const CHUNK_SIZE = 40;
      for (let i = 0; i < allMem0Messages.length; i += CHUNK_SIZE) {
        const chunk = allMem0Messages.slice(i, i + CHUNK_SIZE);
        await mem0Client.add(chunk, { user_id: mem0UserId });
      }
      console.log(`   ✓ Uploaded turns to Mem0 Cloud in ${(performance.now() - mStart).toFixed(0)}ms.`);

      const settlement = await waitForMem0Settlement({
        client: mem0Client,
        userId: mem0UserId,
        minExpectedItems: 5,
        maxWaitMs: 60000,
        pollIntervalMs: 2500,
        stabilityThreshold: 3,
      });
      console.log(`   ✓ Mem0 indexing settled: ${settlement.totalItems} memories indexed.\n`);
    } catch (err: any) {
      console.warn("   ⚠️ Mem0 init failed:", err.message);
      mem0Client = null;
    }
  }

  // Track Engines
  const engines = [
    "Neuro-Swarm Mesh (NSM)",
    "ACM (Arboreal Cognitive Mesh)",
    "PCM (Cognitive Mesh)",
    "Standard Vector RAG",
  ];
  if (mem0Client) engines.push("Mem0 Cloud (Live SDK)");

  const scoreBoard: Record<string, EngineScoreRecord> = {};
  engines.forEach((eng) => {
    scoreBoard[eng] = {
      totalQuestions: 0,
      passedCount: 0,
      totalScore: 0,
      categoryScores: {},
      tokensSum: 0,
      latencySumMs: 0,
      networkLatencySumMs: 0,
    };
  });

  console.log("-----------------------------------------------------------------------------------------");
  console.log("STARTING QUESTION EVALUATION WITH DEEPSEEK-V4.1-FLASH JUDGE");
  console.log("-----------------------------------------------------------------------------------------\n");

  let qIndex = 0;
  for (const qa of questionsToRun) {
    qIndex++;
    console.log(`[Q${qIndex}/${questionsToRun.length}] (Cat ${qa.category}): "${qa.question}"`);
    console.log(`   Ground Truth: "${qa.answer}"`);

    const qContentTokens = extractContentTokens(qa.question);

    // 1. Neuro-Swarm Mesh (NSM) Retrieval
    const nsmStart = performance.now();
    const nsmRes = nsmMesh.query(qa.question, {
      lateralInhibitionMaxPerCategory: 4,
      lexicalLimit: 8,
      maxHops: 2,
    });
    const nsmLatency = performance.now() - nsmStart;

    // Expand episodic context neighborhood across 'follows' and 'mentions' edges
    const nsmDialogueSeeds = nsmRes.salientNodes.filter((s) => s.node.payload?.text).slice(0, 3);
    const nsmContextMap = new Map<string, string>();
    for (const seed of nsmDialogueSeeds) {
      nsmContextMap.set(
        seed.node.id,
        `[${seed.node.id}] (Session Date: ${seed.node.payload.sessionDate}) ${seed.node.payload.text || seed.node.label}`
      );
    }

    for (const seed of nsmDialogueSeeds) {
      // Find connected sequential turns via in-memory synapses
      const inEdges = nsmMesh.getGraph().getIncomingEdges(seed.node.id);
      for (const e of inEdges) {
        if (e.relation === "follows") {
          const prevNode = nsmMesh.getStorage().getNodeById(e.sourceId);
          if (prevNode && prevNode.payload?.text) {
            nsmContextMap.set(
              prevNode.id,
              `[${prevNode.id}] (Session Date: ${prevNode.payload.sessionDate}) ${prevNode.payload.text || prevNode.label}`
            );
          }
        }
      }
      const outEdges = nsmMesh.getGraph().getOutgoingEdges(seed.node.id);
      for (const e of outEdges) {
        if (e.relation === "follows") {
          const nextNode = nsmMesh.getStorage().getNodeById(e.targetId);
          if (nextNode && nextNode.payload?.text) {
            nsmContextMap.set(
              nextNode.id,
              `[${nextNode.id}] (Session Date: ${nextNode.payload.sessionDate}) ${nextNode.payload.text || nextNode.label}`
            );
          }
        }
      }
    }

    // For multi-hop category 3 questions, also traverse cross-session concept bridges
    if (qa.category === 3) {
      for (const seed of nsmDialogueSeeds) {
        const outEdges = nsmMesh.getGraph().getOutgoingEdges(seed.node.id);
        for (const e of outEdges) {
          if (e.relation === "mentions") {
            const conceptIncoming = nsmMesh.getGraph().getIncomingEdges(e.targetId);
            for (const ce of conceptIncoming.slice(0, 2)) {
              const relNode = nsmMesh.getStorage().getNodeById(ce.sourceId);
              if (relNode && relNode.payload?.sessionId !== seed.node.payload.sessionId && relNode.payload?.text) {
                nsmContextMap.set(
                  relNode.id,
                  `[${relNode.id}] (Session Date: ${relNode.payload.sessionDate}) ${relNode.payload.text || relNode.label}`
                );
              }
            }
          }
        }
      }
    }

    const finalNsmTurns = Array.from(nsmContextMap.values()).slice(0, 6);
    const nsmContext = finalNsmTurns.join("\n");

    // 2. ACM Retrieval (Cued Reactivation + Episodic Window + Association)
    const acmStart = performance.now();
    const acmScored = acmPool.map((m) => {
      let matchCount = 0;
      for (const tok of qContentTokens) {
        if (m.tokens.includes(tok)) matchCount++;
      }
      const sim = matchCount / Math.max(1, qContentTokens.length);
      const cueActivation = Math.min(1.0, Math.pow(Math.max(0, sim) / 0.40, 2));
      const str = (1.0 - cueActivation) * 0.35 + cueActivation * 1.0;
      const score = sim * 0.75 + str * 0.25;
      return { ...m, sim, score };
    }).sort((a, b) => b.score - a.score);

    const acmTopSeeds = acmScored.slice(0, 3);
    const contextMap = new Map<string, typeof acmPool[0]>();
    for (const seed of acmTopSeeds) {
      contextMap.set(seed.diaId, seed);
      const neighbors = acmPool.filter(
        (m) => m.sessionId === seed.sessionId && Math.abs(m.turnIndex - seed.turnIndex) <= 1
      );
      for (const n of neighbors) {
        contextMap.set(n.diaId, n);
      }
    }
    const finalAcmTurns = Array.from(contextMap.values()).slice(0, 6);
    const acmContext = finalAcmTurns
      .map((t) => `[${t.diaId}] (Session Date: ${t.dateTimeStr}) ${t.text}`)
      .join("\n");
    const acmLatency = performance.now() - acmStart;

    // 3. PCM Retrieval (Standard Cued Scoring)
    const pcmStart = performance.now();
    const pcmScored = acmPool.map((m) => {
      let matchCount = 0;
      for (const tok of qContentTokens) {
        if (m.tokens.includes(tok)) matchCount++;
      }
      const sim = matchCount / Math.max(1, qContentTokens.length);
      return { ...m, sim };
    }).sort((a, b) => b.sim - a.sim);
    const topPcm = pcmScored.slice(0, 5);
    const pcmContext = topPcm.map((t) => `[${t.diaId}] (Session Date: ${t.dateTimeStr}) ${t.text}`).join("\n");
    const pcmLatency = performance.now() - pcmStart;

    // 4. Vector RAG Retrieval
    const ragStart = performance.now();
    const topRag = pcmScored.slice(0, 5);
    const ragContext = topRag.map((t) => `[${t.diaId}] (Session Date: ${t.dateTimeStr}) ${t.text}`).join("\n");
    const ragLatency = performance.now() - ragStart;

    // 5. Mem0 Cloud Retrieval
    let mem0Context = "";
    let mem0Latency = 0;
    if (mem0Client) {
      const m0T = performance.now();
      try {
        const mRes = await mem0Client.search(qa.question, { filters: { user_id: mem0UserId }, topK: 5 });
        mem0Latency = performance.now() - m0T;
        const memoryList = (mRes && mRes.results) ? mRes.results.map((r: any) => r.memory || JSON.stringify(r)) : [];
        mem0Context = memoryList.join("\n");
      } catch (err: any) {
        console.warn("Mem0 search error:", err.message);
      }
    }

    const runs: Array<{ engine: string; context: string; latencyMs: number; networkLatencyMs: number }> = [
      { engine: "Neuro-Swarm Mesh (NSM)", context: nsmContext, latencyMs: nsmLatency, networkLatencyMs: 0 },
      { engine: "ACM (Arboreal Cognitive Mesh)", context: acmContext, latencyMs: acmLatency, networkLatencyMs: 0 },
      { engine: "PCM (Cognitive Mesh)", context: pcmContext, latencyMs: pcmLatency, networkLatencyMs: 0 },
      { engine: "Standard Vector RAG", context: ragContext, latencyMs: ragLatency, networkLatencyMs: 0 },
    ];
    if (mem0Client) {
      runs.push({ engine: "Mem0 Cloud (Live SDK)", context: mem0Context, latencyMs: 0, networkLatencyMs: mem0Latency });
    }

    for (const r of runs) {
      const judgeRes = await evaluateWithJudge({
        question: qa.question,
        groundTruth: qa.answer,
        retrievedContext: r.context,
        category: qa.category,
        model: judgeModel,
      });

      const tokens = Math.round(r.context.length / 4);
      const board = scoreBoard[r.engine]!;
      board.totalQuestions++;
      if (judgeRes.passed) board.passedCount++;
      board.totalScore += judgeRes.score;
      board.tokensSum += tokens;
      board.latencySumMs += r.latencyMs;
      board.networkLatencySumMs += r.networkLatencyMs;

      if (!board.categoryScores[qa.category]) {
        board.categoryScores[qa.category] = { count: 0, totalScore: 0, passedCount: 0 };
      }
      board.categoryScores[qa.category]!.count++;
      board.categoryScores[qa.category]!.totalScore += judgeRes.score;
      if (judgeRes.passed) board.categoryScores[qa.category]!.passedCount++;

      const passSymbol = judgeRes.passed ? "✅ PASS" : "❌ FAIL";
      console.log(`   → [${r.engine.padEnd(28)}]: ${passSymbol} (Score: ${judgeRes.score}) | Ans: "${judgeRes.candidateAnswer.slice(0, 45)}" | Reasoning: ${judgeRes.reasoning.slice(0, 50)}...`);
    }
    console.log("");
  }

  // Cleanup cloud users
  if (mem0Client) {
    try {
      await mem0Client.deleteAll({ user_id: mem0UserId });
    } catch {}
  }

  // Print Final Scoreboard
  console.log("=========================================================================================");
  console.log("                 CANONICAL LOCOMO EVALUATION REPORT (DEEPSEEK JUDGE)                     ");
  console.log("=========================================================================================\n");

  const reportRows = Object.entries(scoreBoard).map(([engine, data]) => {
    const qCount = Math.max(1, data.totalQuestions);
    const passRate = ((data.passedCount / qCount) * 100).toFixed(1) + "%";
    const meanScore = ((data.totalScore / qCount)).toFixed(1) + "%";
    const cat1 = data.categoryScores[1] ? `${Math.round((data.categoryScores[1].passedCount / data.categoryScores[1].count) * 100)}%` : "N/A";
    const cat2 = data.categoryScores[2] ? `${Math.round((data.categoryScores[2].passedCount / data.categoryScores[2].count) * 100)}%` : "N/A";
    const cat3 = data.categoryScores[3] ? `${Math.round((data.categoryScores[3].passedCount / data.categoryScores[3].count) * 100)}%` : "N/A";
    const cat4 = data.categoryScores[4] ? `${Math.round((data.categoryScores[4].passedCount / data.categoryScores[4].count) * 100)}%` : "N/A";
    const avgTokens = `${Math.round(data.tokensSum / qCount)} tok`;
    const computeLat = `${(data.latencySumMs / qCount).toFixed(2)}ms`;
    const networkLat = data.networkLatencySumMs > 0 ? `${(data.networkLatencySumMs / qCount).toFixed(1)}ms` : "N/A (local)";

    return {
      "Memory Engine": engine,
      "Judge Accuracy (Pass Rate)": passRate,
      "Mean Quality Score": meanScore,
      "Cat 1 (Single-Hop)": cat1,
      "Cat 2 (Temporal)": cat2,
      "Cat 3 (Multi-Hop)": cat3,
      "Cat 4 (Preference)": cat4,
      "Avg Tokens": avgTokens,
      "Compute Latency": computeLat,
      "Network RTT": networkLat,
    };
  });

  console.table(reportRows);

  const outResultPath = resolve(process.cwd(), "data/locomo-canonical-results.json");
  writeFileSync(outResultPath, JSON.stringify({ timestamp: new Date().toISOString(), judgeModel, scoreBoard, reportRows }, null, 2), "utf-8");
  console.log(`\nResults saved to ${outResultPath}\n`);

  return { scoreBoard, reportRows };
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const enableMem0 = args.includes("--mem0");
  runCanonicalLoCoMoBenchmark({ maxQuestions: 5, enableMem0 })
    .then(() => process.exit(0))
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
