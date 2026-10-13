import type { MemoryClient } from "mem0ai";
import type { ZepClient } from "@getzep/zep-cloud";

export interface SettlementResult {
  settled: boolean;
  totalItems: number;
  elapsedMs: number;
  stabilizedAfterPolls: number;
}

/**
 * Robust async settlement poller for Mem0 Cloud.
 * Instead of firing queries immediately, this waits and polls until Mem0's
 * background worker pipeline finishes extracting and vectorizing memories.
 */
export async function waitForMem0Settlement(params: {
  client: any;
  userId: string;
  minExpectedItems?: number;
  maxWaitMs?: number;
  pollIntervalMs?: number;
  stabilityThreshold?: number; // consecutive polls with identical count
}): Promise<SettlementResult> {
  const {
    client,
    userId,
    minExpectedItems = 1,
    maxWaitMs = 60000,
    pollIntervalMs = 2500,
    stabilityThreshold = 3,
  } = params;

  const start = performance.now();
  let lastCount = -1;
  let stablePolls = 0;
  let currentCount = 0;

  console.log(`[Mem0 Settlement Poller] Waiting for async indexing for user: ${userId}...`);

  while (performance.now() - start < maxWaitMs) {
    try {
      const res = await client.getAll({ filters: { user_id: userId } });
      currentCount = (res && res.results) ? res.results.length : (res?.count ?? 0);

      const elapsed = ((performance.now() - start) / 1000).toFixed(1);
      console.log(`   ⏳ Mem0 Poll: ${currentCount} items indexed (${elapsed}s elapsed)`);

      if (currentCount >= minExpectedItems) {
        if (currentCount === lastCount) {
          stablePolls++;
          if (stablePolls >= stabilityThreshold) {
            console.log(`   ✅ Mem0 Index Settled: ${currentCount} items verified across ${stablePolls} consecutive polls.`);
            return {
              settled: true,
              totalItems: currentCount,
              elapsedMs: performance.now() - start,
              stabilizedAfterPolls: stablePolls,
            };
          }
        } else {
          stablePolls = 1;
          lastCount = currentCount;
        }
      }
    } catch (err: any) {
      console.warn(`   ⚠️ Mem0 poll probe error: ${err.message}`);
    }

    await new Promise((r) => setTimeout(r, pollIntervalMs));
  }

  console.warn(`   ⚠️ Mem0 indexing timed out after ${(maxWaitMs / 1000).toFixed(0)}s (final count: ${currentCount}). Proceeding with available items.`);
  return {
    settled: currentCount > 0,
    totalItems: currentCount,
    elapsedMs: performance.now() - start,
    stabilizedAfterPolls: stablePolls,
  };
}

/**
 * Robust async settlement poller for Zep Cloud.
 * Polls the graph episode and node status until asynchronous extraction settles.
 */
export async function waitForZepSettlement(params: {
  client: any;
  userId: string;
  minExpectedEpisodes?: number;
  maxWaitMs?: number;
  pollIntervalMs?: number;
  stabilityThreshold?: number;
}): Promise<SettlementResult> {
  const {
    client,
    userId,
    minExpectedEpisodes = 1,
    maxWaitMs = 60000,
    pollIntervalMs = 2500,
    stabilityThreshold = 3,
  } = params;

  const start = performance.now();
  let lastCount = -1;
  let stablePolls = 0;
  let currentCount = 0;

  console.log(`[Zep Settlement Poller] Waiting for graph indexing for user: ${userId}...`);

  while (performance.now() - start < maxWaitMs) {
    try {
      const epRes = await client.graph.episode.getByUserId(userId);
      const episodes = epRes?.episodes || epRes || [];
      currentCount = Array.isArray(episodes) ? episodes.length : 0;

      const elapsed = ((performance.now() - start) / 1000).toFixed(1);
      console.log(`   ⏳ Zep Poll: ${currentCount} episodes indexed (${elapsed}s elapsed)`);

      if (currentCount >= minExpectedEpisodes) {
        if (currentCount === lastCount) {
          stablePolls++;
          if (stablePolls >= stabilityThreshold) {
            console.log(`   ✅ Zep Graph Settled: ${currentCount} episodes verified.`);
            return {
              settled: true,
              totalItems: currentCount,
              elapsedMs: performance.now() - start,
              stabilizedAfterPolls: stablePolls,
            };
          }
        } else {
          stablePolls = 1;
          lastCount = currentCount;
        }
      }
    } catch (err: any) {
      console.warn(`   ⚠️ Zep poll probe error: ${err.message}`);
    }

    await new Promise((r) => setTimeout(r, pollIntervalMs));
  }

  console.warn(`   ⚠️ Zep indexing timed out after ${(maxWaitMs / 1000).toFixed(0)}s (final count: ${currentCount}). Proceeding.`);
  return {
    settled: currentCount > 0,
    totalItems: currentCount,
    elapsedMs: performance.now() - start,
    stabilizedAfterPolls: stablePolls,
  };
}
