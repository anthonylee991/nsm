import type { ExtractedTriplet } from "./svo_hearst.js";
import type { EntityCategory } from "../core/types.js";

export interface ClausIEv2Triplet extends ExtractedTriplet {
  attributes?: Record<string, any>;
  entityCategory?: EntityCategory;
}

export class ClausIEv2Extractor {
  private static COPULA_VERBS = new Set(["is", "are", "was", "were", "am", "become", "became"]);
  private static COMMON_VERBS = new Set([
    "work", "works", "worked",
    "live", "lives", "lived", "reside", "resides", "resided",
    "located", "headquartered", "based", "founded",
    "have", "has", "had",
    "own", "owns", "owned",
    "graduated", "attended", "went", "study", "studied",
    "build", "builds", "built",
    "invest", "invests", "invested",
    "prefer", "prefers", "require", "requires",
    "run", "runs", "ran",
    "earn", "earns", "earned"
  ]);

  private static PREPOSITIONS = new Set(["in", "at", "on", "to", "for", "with", "from", "as", "by", "into", "over"]);

  public static extract(text: string): ClausIEv2Triplet[] {
    const triplets: ClausIEv2Triplet[] = [];
    // Split into sentences first
    const sentences = text
      .split(/(?<=[.!?])\s+/)
      .map((s) => s.replace(/[.;!]+$/, "").trim())
      .filter((s) => s.length > 0);

    let inheritedSubject = "I";

    for (const sent of sentences) {
      // 1. Clause Segmentation with Verb-Gated Conjunction Checking
      const rawClauses = this.segmentClauses(sent);

      // 2. Parse Each Clause
      for (const clauseStr of rawClauses) {
        const parsed = this.parseSingleClause(clauseStr, inheritedSubject);
        if (parsed) {
          inheritedSubject = parsed.subject;
          triplets.push(...parsed.triplets);
        }
      }
    }

    return triplets;
  }

  /**
   * Verb-Gated Conjunction Segmentation:
   * Only splits on "and" / "but" if what follows contains an active verb phrase.
   * Preserves lists like "aged 28, 14, and 6" or "peanuts, shellfish, and tree nuts".
   */
  private static segmentClauses(text: string): string[] {
    // Check for relative clause: "X, who is Y, does Z"
    const relMatch = text.match(/^(.+?),\s*(who|which|that)\s+(.+?),\s*(.+)$/i);
    if (relMatch) {
      const subj = relMatch[1].trim();
      return [
        `${subj} ${relMatch[3].trim()}`, // Relative clause
        `${subj} ${relMatch[4].trim()}`  // Matrix clause
      ];
    }

    // Verb-gated split on " and " / " but "
    const conjunctionRegex = /\s+(?:and|but)\s+/gi;
    let match: RegExpExecArray | null;
    let lastIndex = 0;
    const clauseSplits: string[] = [];

    while ((match = conjunctionRegex.exec(text)) !== null) {
      const before = text.substring(lastIndex, match.index).trim();
      const after = text.substring(match.index + match[0].length).trim();

      // Lookahead: does the text AFTER the conjunction start with an active verb or Subject+Verb?
      if (this.isClausalContinuation(after)) {
        clauseSplits.push(before);
        lastIndex = match.index + match[0].length;
      }
    }

    clauseSplits.push(text.substring(lastIndex).trim());
    return clauseSplits.filter((c) => c.length > 0);
  }

  /**
   * Determines if text following "and" is a new clause (contains a verb) or a list item (noun/number)
   */
  private static isClausalContinuation(afterText: string): boolean {
    const tokens = afterText.toLowerCase().split(/\s+/);
    if (tokens.length === 0) return false;

    // Direct verb following "and": "...and work remotely", "...and owns three houses"
    const firstWord = tokens[0].replace(/[^a-z]/g, "");
    if (this.COMMON_VERBS.has(firstWord) || this.COPULA_VERBS.has(firstWord)) {
      return true;
    }

    // Subject + Verb following "and": "...and I work remotely", "...and my sister lives in..."
    if (tokens.length >= 2) {
      const secondWord = tokens[1].replace(/[^a-z]/g, "");
      if ((tokens[0] === "i" || tokens[0] === "we" || tokens[0] === "they") &&
          (this.COMMON_VERBS.has(secondWord) || this.COPULA_VERBS.has(secondWord))) {
        return true;
      }
    }

    // Otherwise it's a noun phrase or numerical enumeration: "14, and 6", "peanuts and tree nuts"
    return false;
  }

  /**
   * Parses a single clause into Subject, Verb, Object/Complement, and extracts rich attributes
   */
  private static parseSingleClause(
    text: string,
    fallbackSubject: string
  ): { subject: string; triplets: ClausIEv2Triplet[] } | null {
    const tokens = text.trim().split(/\s+/);
    if (tokens.length < 2) return null;

    // Locate Main Verb across the entire clause
    let verbIdx = -1;
    let isCompoundVerb = false;

    for (let i = 0; i < tokens.length; i++) {
      const t = tokens[i].toLowerCase().replace(/[^a-z]/g, "");
      if (this.COPULA_VERBS.has(t)) {
        verbIdx = i;
        // Check for passive / copular combinations: "is located", "are headquartered", "was founded"
        if (i + 1 < tokens.length) {
          const nextT = tokens[i + 1].toLowerCase().replace(/[^a-z]/g, "");
          if (["located", "headquartered", "based", "founded"].includes(nextT)) {
            isCompoundVerb = true;
          }
        }
        break;
      }
      if (this.COMMON_VERBS.has(t)) {
        verbIdx = i;
        break;
      }
    }

    if (verbIdx === -1) verbIdx = 0;

    // 1. Identify Subject: All tokens preceding the verb (or fallback if verb is at index 0)
    let subject = "";
    if (verbIdx > 0) {
      subject = tokens.slice(0, verbIdx).join(" ").trim();
    } else {
      subject = fallbackSubject;
    }

    // 2. Identify Verb Phrase
    let verb = tokens[verbIdx].toLowerCase().replace(/[^a-z]/g, "");
    let afterVerb = tokens.slice(verbIdx + 1);

    if (isCompoundVerb && afterVerb.length > 0) {
      const participle = afterVerb[0].toLowerCase().replace(/[^a-z]/g, "");
      verb = `${verb} ${participle}`;
      afterVerb = afterVerb.slice(1);
    }

    // 3. Entity Categorization
    let entityCategory: EntityCategory = 'general';
    const lowerSubj = subject.toLowerCase();
    if (/office|company|hq|headquarters|firm|agency|corp|inc|llc|lda|studio|lab|ltd|organization|ventures|technologies|solutions/i.test(lowerSubj)) {
      entityCategory = 'organization';
    } else if (/^(i|me|my\b|we|they|he|she|sister|brother|father|mother|parents|daughter|son|founder|engineer|doctor|teacher)/i.test(lowerSubj)) {
      entityCategory = 'person';
    }

    // Preposition & Adverbial Parsing
    const adverbials: { relation: string; value: string }[] = [];
    const directTokens: string[] = [];

    let currentPrep = "";
    let prepTokens: string[] = [];

    for (let i = 0; i < afterVerb.length; i++) {
      const token = afterVerb[i];
      const lowerT = token.toLowerCase();

      // Only treat as preposition boundary if not inside a list
      if (this.PREPOSITIONS.has(lowerT) && i > 0 && !afterVerb[i - 1].endsWith(",")) {
        if (currentPrep && prepTokens.length > 0) {
          adverbials.push({
            relation: `${currentPrep}_relation`,
            value: prepTokens.join(" "),
          });
          prepTokens = [];
        }
        currentPrep = lowerT;
      } else if (currentPrep) {
        prepTokens.push(token);
      } else {
        directTokens.push(token);
      }
    }

    if (currentPrep && prepTokens.length > 0) {
      adverbials.push({
        relation: `${currentPrep}_relation`,
        value: prepTokens.join(" "),
      });
    }

    let rawObject = directTokens.join(" ");

    // Attribute Extraction (e.g. "3 daughters aged 28, 14, and 6")
    const attributes: Record<string, any> = {};
    const ageMatch = rawObject.match(/(.+?)\s+aged?\s+([0-9,\s]+(?:\s*and\s*[0-9]+)?)/i);
    if (ageMatch) {
      rawObject = ageMatch[1].trim();
      const rawAges = ageMatch[2].match(/\b\d+\b/g);
      if (rawAges) {
        attributes["ages"] = rawAges.map(Number);
      }
    }

    // Number Quantifier extraction (e.g. "3 daughters", "two companies")
    const quantMatch = rawObject.match(/^(\d+|one|two|three|four|five)\s+([a-z\s]+)$/i);
    if (quantMatch) {
      attributes["quantity"] = quantMatch[1];
    }

    const cleanObject = rawObject.replace(/^(a|an|the)\s+/i, "").replace(/,$/, "").trim();

    // Determine Clause Type
    let clauseType = "SVO";
    if (this.COPULA_VERBS.has(verb.split(" ")[0])) {
      clauseType = isCompoundVerb ? "SVA" : "SVC";
    } else if (adverbials.length > 0 && !cleanObject) {
      clauseType = "SVA";
    }

    const triplets: ClausIEv2Triplet[] = [];

    // Main proposition
    triplets.push({
      subject,
      relation: verb,
      object: cleanObject || (adverbials.length > 0 ? adverbials[0].value : "unknown"),
      clauseType,
      attributes: Object.keys(attributes).length > 0 ? attributes : undefined,
      entityCategory,
    });

    // Adverbials
    for (const adv of adverbials) {
      triplets.push({
        subject,
        relation: adv.relation,
        object: adv.value.replace(/^(a|an|the)\s+/i, "").trim(),
        clauseType: "SVA_ADVERBIAL",
        entityCategory,
      });
    }

    return { subject, triplets };
  }
}
