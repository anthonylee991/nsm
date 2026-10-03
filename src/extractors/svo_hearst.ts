export interface ExtractedTriplet {
  subject: string;
  relation: string;
  object: string;
  clauseType?: string;
  attributes?: Record<string, any>;
}

export class SVOHearstExtractor {
  // Regex rules for Hearst taxonomical and affiliation patterns
  private static HEARST_PATTERNS = [
    // X graduated from Y / went to Y / attended Y
    {
      regex: /\b(i|my [a-z]+|[a-z]+)\s+(?:graduated from|went to|attended|studied at)\s+([a-z\s]+)/i,
      relation: "alumni_of",
    },
    // X is/are [a/an] Y
    {
      regex: /\b(i am|my [a-z]+ are|my [a-z]+ is|[a-z]+ is|[a-z]+ are)\s+(?:a|an|the)?\s*([a-z\s]+)/i,
      relation: "is_a",
    },
    // X works at / for Y as Z
    {
      regex: /\b(i|my [a-z]+)\s+(?:work at|work for|works at|works for)\s+([a-z\s]+?)\s+as\s+(?:a|an)?\s*([a-z\s]+)/i,
      relation: "employed_at",
    },
    // X has / have Y
    {
      regex: /\b(i have|i own|my [a-z]+ have|my [a-z]+ own)\s+([a-z0-9\s]+)/i,
      relation: "possesses",
    },
  ];

  public static extract(text: string): ExtractedTriplet[] {
    const triplets: ExtractedTriplet[] = [];
    const cleanText = text.trim();

    // 1. Try Hearst / Template Regex
    for (const pattern of this.HEARST_PATTERNS) {
      const match = cleanText.match(pattern.regex);
      if (match) {
        if (pattern.relation === "employed_at" && match[3]) {
          triplets.push({
            subject: match[1].trim(),
            relation: "employed_at",
            object: match[2].trim(),
            clauseType: "HEARST_SVO",
          });
          triplets.push({
            subject: match[1].trim(),
            relation: "has_role",
            object: match[3].trim(),
            clauseType: "HEARST_SVC",
          });
          return triplets;
        }

        triplets.push({
          subject: match[1].trim(),
          relation: pattern.relation,
          object: match[2].trim(),
          clauseType: "HEARST_PATTERN",
        });
        return triplets;
      }
    }

    // 2. Generic SVO Fallback (split by auxiliary verbs)
    const verbSplit = cleanText.match(/^(i|my [a-z]+|[a-z]+)\s+(are|is|went|attended|live in|lives in|have|has|owns|own)\s+(.+)$/i);
    if (verbSplit) {
      triplets.push({
        subject: verbSplit[1].trim(),
        relation: verbSplit[2].toLowerCase().replace(/\s+/g, "_"),
        object: verbSplit[3].trim(),
        clauseType: "NAIVE_SVO",
      });
    }

    return triplets;
  }
}
