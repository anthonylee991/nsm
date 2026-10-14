/**
 * Strength model and forgetting policy, taken from ACM (github.com/anthonylee991/acm, MIT), the
 * memory core MemVault runs in production. Pure functions; the store decides when to call them.
 *
 * Measured in MemVault (LoCoMo dev, 180 simulated days): deleting faded memories left never-asked
 * questions at 60.6% accuracy; demoting them kept 86.0%, the same as a fresh store (85.7%).
 */
export type Importance = "pinned" | "high" | "default";

export const DEFAULT_DECAY_WINDOW_DAYS = 90;
export const PINNED_STRENGTH = 1.0;
export const HIGH_INITIAL_STRENGTH = 0.8;
export const DEFAULT_INITIAL_STRENGTH = 0.4;
export const MIN_DECAYED_STRENGTH = 0.01;
/** Reinforcement on recall: S += BOOST_ALPHA * ln(1 + retrievals in the window). */
export const BOOST_ALPHA = 0.17;
/** Share of a full reinforcement an associate of a recalled memory receives. */
export const SPREAD_BOOST = 0.1;
export const SPREAD_SEEDS = 5;
export const SPREAD_NEIGHBOURS_PER_SEED = 4;
export const SPREAD_MIN_SIMILARITY = 0.65;
export const SPREAD_EPISODE_WINDOW_MINUTES = 60;
export const SPREAD_EPISODE_WEIGHT = 0.7;

export function initialStrength(importance: Importance): number {
  switch (importance) {
    case "pinned":
      return PINNED_STRENGTH;
    case "high":
      return HIGH_INITIAL_STRENGTH;
    default:
      return DEFAULT_INITIAL_STRENGTH;
  }
}

/**
 * Decayed strength after `elapsedMs` without reinforcement:
 *   S(t) = S_0 * exp(-t / tau),  tau = T_eff / 3,  T_eff = windowDays * (1 + 0.25 * min(B, 20))
 * where B is the number of reinforcements (the savings effect).
 */
export function decayedStrength(
  strength: number,
  elapsedMs: number,
  boostCount: number = 0,
  importance: Importance = "default",
  decayWindowDays: number = DEFAULT_DECAY_WINDOW_DAYS,
): number {
  if (importance === "pinned") return PINNED_STRENGTH;
  if (![elapsedMs, boostCount, strength, decayWindowDays].every(Number.isFinite)) return MIN_DECAYED_STRENGTH;
  const elapsedDays = Math.max(0, elapsedMs / 86_400_000);
  const effectiveWindowDays = decayWindowDays * (1 + 0.25 * Math.min(Math.max(0, boostCount), 20));
  const tau = effectiveWindowDays / 3;
  const decayed = strength * Math.exp(-elapsedDays / tau);
  return Math.max(MIN_DECAYED_STRENGTH, Math.min(1.0, decayed));
}

/** Reinforcement on recall, with diminishing returns for repeated retrievals in the same window. */
export function boostOnAccess(strength: number, importance: Importance, retrievalsInWindow: number = 1): number {
  if (importance === "pinned") return PINNED_STRENGTH;
  return Math.min(1.0, strength + BOOST_ALPHA * Math.log(1 + Math.max(1, retrievalsInWindow)));
}

/** The reinforcement an associate gets when a seed it is linked to is recalled. */
export function spreadBoost(weight: number = 1): number {
  return BOOST_ALPHA * Math.log(2) * SPREAD_BOOST * weight;
}

/**
 * Rank score: relevance (0..1) and cue-reactivated strength. A strong cue reactivates an old memory to
 * full strength so decay demotes stale noise without hiding something you ask about directly.
 */
export function rankScore(relevance: number, strength: number): number {
  const cue = Math.min(1.0, Math.pow(Math.max(0, relevance) / 0.4, 2));
  const effective = strength * (1 - cue) + 1.0 * cue;
  return relevance * 0.75 + effective * 0.25;
}

export interface ForgettingParams {
  /** Strength at or below which a memory counts as faded. */
  strengthFloor: number;
  /** Days without recall before a faded memory is forgotten. */
  idleDays: number;
  mode: "demote" | "delete";
}

export const DEFAULT_FORGETTING: ForgettingParams = { strengthFloor: 0.02, idleDays: 90, mode: "demote" };

export type ForgettingAction = "keep" | "demote" | "delete";

export function forgettingAction(
  memory: { strength: number; importance: Importance; lastRecalledAt?: number | null; createdAt: number; state?: string },
  now: number,
  params: ForgettingParams = DEFAULT_FORGETTING,
): ForgettingAction {
  if (memory.importance === "pinned" || memory.state === "archived") return "keep";
  const last = memory.lastRecalledAt ?? memory.createdAt;
  const idle = (now - last) / 86_400_000;
  if (memory.strength > params.strengthFloor || idle < params.idleDays) return "keep";
  return params.mode;
}
