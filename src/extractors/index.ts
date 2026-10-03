export * from "./svo_hearst.js";
export * from "./clausie_v2.js";

import { ClausIEv2Extractor, type ClausIEv2Triplet } from "./clausie_v2.js";
import { SVOHearstExtractor, type ExtractedTriplet } from "./svo_hearst.js";

/**
 * Universal Zero-LLM Information Extractor:
 * Decomposes natural language text into structured subject-relation-object triplets
 * with rich grammatical attributes (lists, numbers, ages, roles) in <0.2ms.
 */
export function extractTriplets(text: string): (ClausIEv2Triplet | ExtractedTriplet)[] {
  const clausieHits = ClausIEv2Extractor.extract(text);
  if (clausieHits.length > 0) {
    return clausieHits;
  }
  return SVOHearstExtractor.extract(text);
}
