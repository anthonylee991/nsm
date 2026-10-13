import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

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

export interface JudgeEvaluationResult {
  passed: boolean;
  score: number; // 0 - 100
  candidateAnswer: string;
  groundTruth: string;
  reasoning: string;
}

const DEFAULT_JUDGE_MODEL = "deepseek/deepseek-v4.1-flash";

/**
 * Impartial LLM Judge using OpenRouter API to evaluate memory retrieval against ground truth.
 */
export async function evaluateWithJudge(params: {
  question: string;
  groundTruth: string;
  retrievedContext: string;
  category?: string | number;
  model?: string;
}): Promise<JudgeEvaluationResult> {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) {
    throw new Error(
      "OPENROUTER_API_KEY is not set in environment or .env. Cannot run LLM judge."
    );
  }

  const model = params.model || DEFAULT_JUDGE_MODEL;

  // If the memory engine retrieved nothing at all, fail honestly without wasting LLM tokens
  if (!params.retrievedContext || params.retrievedContext.trim().length === 0) {
    return {
      passed: false,
      score: 0,
      candidateAnswer: "NO_CONTEXT_RETRIEVED",
      groundTruth: params.groundTruth,
      reasoning: "The memory retrieval engine returned empty context.",
    };
  }

  const systemPrompt = `You are a rigorous, impartial scientific evaluator scoring an AI Agent's Long-Term Conversational Memory system.
Your job is to determine whether the memory engine retrieved the factual evidence needed to answer the question, and whether an agent relying solely on the retrieved context can answer correctly.

Respond ONLY with a valid JSON object in this exact schema:
{
  "extractedAnswer": "<the answer formulated strictly using only the retrieved context, or 'UNKNOWN' if missing>",
  "passed": <true if extractedAnswer is factually consistent and matches the ground truth, false otherwise>,
  "score": <integer from 0 to 100 reflecting accuracy and completeness: 100 = completely correct, 50 = partially correct/missing specifics, 0 = incorrect/unrelated/empty>,
  "reasoning": "<1-2 concise sentences explaining your evaluation>"
}`;

  const userPrompt = `[EVALUATION TASK]
Question: ${params.question}
Ground Truth Reference: ${params.groundTruth}
${params.category ? `Question Category: ${params.category}` : ""}

[RETRIEVED CONTEXT FROM AGENT MEMORY]
"""
${params.retrievedContext}
"""

Evaluate whether the retrieved context contains the necessary facts and matches the Ground Truth Reference. Return ONLY valid JSON.`;

  let attempts = 0;
  const maxAttempts = 3;
  while (attempts < maxAttempts) {
    attempts++;
    try {
      const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
        method: "POST",
        signal: AbortSignal.timeout(15000),
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
          "HTTP-Referer": "https://github.com/anthonylee991/nsm",
          "X-Title": "NSM Canonical LoCoMo Evaluator",
        },
        body: JSON.stringify({
          model,
          temperature: 0.0,
          response_format: { type: "json_object" },
          messages: [
            { role: "system", content: systemPrompt },
            { role: "user", content: userPrompt },
          ],
        }),
      });

      if (!response.ok) {
        const errorText = await response.text();
        if (response.status === 429 && attempts < maxAttempts) {
          console.warn(`[Judge] Rate limited by OpenRouter. Retrying in ${attempts * 2}s...`);
          await new Promise((r) => setTimeout(r, attempts * 2000));
          continue;
        }
        throw new Error(`OpenRouter HTTP ${response.status}: ${errorText}`);
      }

      const json = await response.json();
      const content = json.choices?.[0]?.message?.content?.trim();
      if (!content) {
        throw new Error("Empty response from LLM judge");
      }

      // Clean JSON if code fenced
      const cleanJson = content.replace(/^```json\s*/, "").replace(/\s*```$/, "");
      const parsed = JSON.parse(cleanJson);

      return {
        passed: Boolean(parsed.passed),
        score: typeof parsed.score === "number" ? Math.max(0, Math.min(100, Math.round(parsed.score))) : (parsed.passed ? 100 : 0),
        candidateAnswer: String(parsed.extractedAnswer || ""),
        groundTruth: params.groundTruth,
        reasoning: String(parsed.reasoning || ""),
      };
    } catch (err: any) {
      if (attempts >= maxAttempts) {
        console.error(`[Judge Error] Failed after ${maxAttempts} attempts for question "${params.question}":`, err.message);
        return {
          passed: false,
          score: 0,
          candidateAnswer: "JUDGE_CALL_FAILED",
          groundTruth: params.groundTruth,
          reasoning: `Judge evaluation error: ${err.message}`,
        };
      }
      await new Promise((r) => setTimeout(r, attempts * 1500));
    }
  }

  return {
    passed: false,
    score: 0,
    candidateAnswer: "UNKNOWN",
    groundTruth: params.groundTruth,
    reasoning: "Evaluation failed to complete.",
  };
}
