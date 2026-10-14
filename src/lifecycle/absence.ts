/**
 * Absence flags, taken from ACM (github.com/anthonylee991/acm, MIT): a regular routine that has gone
 * quiet. No model is needed: a routine is the recalled memory plus its family of similar earlier
 * memories; if the family has regular intervals and the last entry is several intervals ago, flag it.
 *
 * Measured in MemVault on a synthetic held-out set (routines that stopped): answers that noticed the
 * stopped routine went from 4.5% to 54.5% (p = 0.001) with the flag, and no continuing routine was
 * flagged. Surprisal flags (an entry that breaks its routine's pattern) need a model judge and are
 * not implemented here.
 */
export const FAMILY_MAX = 12;
export const FAMILY_MIN = 4;
export const ABSENCE_SEEDS = 10;
export const ABSENCE_MIN_ENTRIES = 5;
export const ABSENCE_GAP_FACTOR = 3;

export interface DatedMemory {
  id: string;
  text: string;
  /** Epoch ms of the event the memory records. */
  occurredAt: number;
}

export interface AbsenceFlag {
  metric: "absence";
  description: string;
  memoryId: string;
  text: string;
  occurredAt: string;
  /** Days since the last entry. */
  sinceDays: number;
  /** The routine's usual interval in days. */
  usualIntervalDays: number;
}

/** Similarity between two memories, 0..1. The store supplies cosine when vectors exist, else lexical. */
export type Similarity = (a: DatedMemory, b: DatedMemory) => number;

const STOP = new Set(["the", "and", "for", "with", "that", "this", "was", "were", "have", "has", "had", "from", "about", "just", "today", "this", "morning", "evening", "night", "yesterday", "week", "again"]);

/** Jaccard over content words of three or more letters; the no-model fallback for family selection. */
export function lexicalSimilarity(a: DatedMemory, b: DatedMemory): number {
  const words = (t: string) => new Set(t.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length >= 3 && !STOP.has(w)));
  const A = words(a.text);
  const B = words(b.text);
  if (A.size === 0 || B.size === 0) return 0;
  let inter = 0;
  for (const w of A) if (B.has(w)) inter++;
  return inter / (A.size + B.size - inter);
}

/**
 * The family of `memory`: up to FAMILY_MAX other memories with similarity >= `minSimilarity`, oldest
 * first; null when fewer than FAMILY_MIN qualify (no routine to speak of).
 */
export function selectFamily<T extends DatedMemory>(
  memory: DatedMemory,
  candidates: T[],
  similarity: Similarity,
  minSimilarity: number,
): T[] | null {
  const members = candidates
    .filter((c) => c.id !== memory.id)
    .map((c) => ({ c, s: similarity(memory, c) }))
    .filter((x) => x.s >= minSimilarity)
    .sort((a, b) => b.s - a.s)
    .slice(0, FAMILY_MAX)
    .map((x) => x.c)
    .sort((a, b) => a.occurredAt - b.occurredAt);
  return members.length >= FAMILY_MIN ? members : null;
}

/**
 * For each of the top recalled memories (in rank order), the routine = the memory plus its family. A
 * routine with at least ABSENCE_MIN_ENTRIES entries at regular intervals (coefficient of variation < 1)
 * whose last entry is at least ABSENCE_GAP_FACTOR median intervals ago (and between 4 and 365 days)
 * is flagged once.
 */
export function absenceFlags<T extends DatedMemory>(
  recalled: T[],
  all: T[],
  asOf: number,
  similarity: Similarity,
  minSimilarity: number,
): AbsenceFlag[] {
  const DAY = 86_400_000;
  const out: AbsenceFlag[] = [];
  const flagged: Array<Set<string>> = [];
  for (const seed of recalled.slice(0, ABSENCE_SEEDS)) {
    const family = selectFamily(seed, all, similarity, minSimilarity);
    if (!family) continue;
    const members = [seed, ...family];
    const ids = new Set(members.map((m) => m.id));
    if (members.length < ABSENCE_MIN_ENTRIES) continue;
    if (flagged.some((f) => [...ids].filter((id) => f.has(id)).length >= ids.size / 2)) continue;

    const times = members.map((m) => m.occurredAt).sort((a, b) => a - b);
    const gaps = times.slice(1).map((t, i) => (t - times[i]!) / DAY);
    const median = [...gaps].sort((a, b) => a - b)[Math.floor(gaps.length / 2)]!;
    const mean = gaps.reduce((a, b) => a + b, 0) / gaps.length;
    const sd = Math.sqrt(gaps.reduce((a, b) => a + (b - mean) ** 2, 0) / gaps.length);
    if (median <= 0 || sd / mean >= 1) continue;
    const since = (asOf - times[times.length - 1]!) / DAY;
    if (since < Math.max(ABSENCE_GAP_FACTOR * median, 4) || since > 365) continue;

    const last = members.reduce((a, b) => (b.occurredAt > a.occurredAt ? b : a));
    flagged.push(ids);
    out.push({
      metric: "absence",
      description:
        `nothing about this since ${new Date(last.occurredAt).toISOString().slice(0, 10)} (${Math.round(since)} days); ` +
        `it usually comes up about every ${Math.max(1, Math.round(median))} days`,
      memoryId: last.id,
      text: last.text,
      occurredAt: new Date(last.occurredAt).toISOString(),
      sinceDays: Math.round(since),
      usualIntervalDays: Math.max(1, Math.round(median)),
    });
  }
  return out;
}
