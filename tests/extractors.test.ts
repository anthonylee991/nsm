import { describe, expect, it } from "bun:test";
import { ClausIEv2Extractor } from "../src/extractors/clausie_v2.js";
import { SVOHearstExtractor } from "../src/extractors/svo_hearst.js";
import { extractTriplets } from "../src/extractors/index.js";

describe("Zero-LLM OpenIE Extractors", () => {
  it("extracts atomic SVO and SVC propositions", () => {
    const text = "I work at TechCorp as a principal engineer";
    const triplets = ClausIEv2Extractor.extract(text);

    expect(triplets.length).toBeGreaterThanOrEqual(2);
    const workTrip = triplets.find((t) => t.relation === "work");
    expect(workTrip).toBeDefined();
    expect(workTrip?.object).toContain("TechCorp");
  });

  it("handles verb-gated clausal conjunctions without splitting noun lists", () => {
    // 1. Clausal conjunction (contains active verb after 'and') -> should split into two propositions
    const clauseText = "I live in Denver and work remotely";
    const clauseTriplets = ClausIEv2Extractor.extract(clauseText);
    expect(clauseTriplets.length).toBeGreaterThanOrEqual(2);

    // 2. Noun enumeration list -> should NOT split on 'and'
    const listText = "I invest in stocks, real estate, and index funds";
    const listTriplets = ClausIEv2Extractor.extract(listText);
    expect(listTriplets.length).toBeGreaterThanOrEqual(1);
    expect(listTriplets[0].object).toContain("index funds");
  });

  it("extracts numerical attributes and quantifiers", () => {
    const text = "I manage 3 servers aged 24, 12, and 6";
    const triplets = ClausIEv2Extractor.extract(text);

    expect(triplets.length).toBeGreaterThan(0);
    const mainTrip = triplets[0];
    expect(mainTrip.attributes).toBeDefined();
    expect(mainTrip.attributes?.ages).toEqual([24, 12, 6]);
  });

  it("extracts Hearst taxonomic and employment patterns", () => {
    const text = "I graduated from MIT";
    const triplets = SVOHearstExtractor.extract(text);

    expect(triplets.length).toBe(1);
    expect(triplets[0].relation).toBe("alumni_of");
    expect(triplets[0].object).toBe("MIT");
  });

  it("runs unified extractTriplets helper", () => {
    const text = "I live in Seattle";
    const res = extractTriplets(text);
    expect(res.length).toBeGreaterThan(0);
  });
});
