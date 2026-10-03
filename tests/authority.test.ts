import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { NeuroSwarmMesh } from "../src/mesh.js";
import { rmSync, existsSync } from "node:fs";

describe("Epistemic Authority Hierarchy & Directed Supersession", () => {
  let mesh: NeuroSwarmMesh;

  beforeEach(() => {
    mesh = new NeuroSwarmMesh({ dbPath: ":memory:" });
  });

  afterEach(() => {
    mesh.close();
  });

  it("automatically supersedes conflicting lower-authority social claim when direct user fact is added", () => {
    // 1. Ingest social node claiming City A (authority 0.60)
    mesh.ingestNode(
      {
        id: "social-profile-user42",
        nodeType: "profile",
        label: "Public Profile @user42",
        source: "social_feed",
        authority: 0.60,
        entityCategory: "person",
        payload: {
          publicLocationClaim: "City A",
          summary: "Developer profile located in City A.",
        },
        createdAt: Date.now(),
        updatedAt: Date.now(),
      },
      "Developer profile located in City A"
    );

    // 2. Ingest authoritative verified user fact stating residence in City B (authority 1.0)
    mesh.ingestNode(
      {
        id: "fact-user-residence",
        nodeType: "profile",
        label: "I live in City B",
        source: "user_fact",
        authority: 1.0,
        entityCategory: "person",
        payload: {
          text: "I live in City B",
        },
        createdAt: Date.now(),
        updatedAt: Date.now(),
      },
      "I live in City B"
    );

    // 3. Verify :SUPERSEDES edge was injected
    const edges = mesh.getStorage().getAllEdges();
    const supersedesEdge = edges.find(
      (e) =>
        e.sourceId === "fact-user-residence" &&
        e.targetId === "social-profile-user42" &&
        e.relation === ":SUPERSEDES"
    );
    expect(supersedesEdge).toBeDefined();

    // 4. Test retrieval query
    const result = mesh.query("Where do I live?");
    const salientIds = result.salientNodes.map((s) => s.node.id);

    expect(salientIds).toContain("fact-user-residence");
    expect(salientIds).not.toContain("social-profile-user42"); // Conflicting unverified claim must be inhibited
  });

  it("allows personal residence and company office location to coexist across entity categories", () => {
    // 1. Personal residence (person)
    mesh.ingestNode({
      id: "fact-residence",
      nodeType: "profile",
      label: "I live in City B",
      source: "user_fact",
      authority: 1.0,
      entityCategory: "person",
      payload: { text: "I live in City B" },
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });

    // 2. Organization headquarters (organization)
    mesh.ingestNode({
      id: "org-acme-corp",
      nodeType: "organization",
      label: "Acme Corporation",
      source: "public_scraper",
      authority: 0.70,
      entityCategory: "organization",
      payload: { orgName: "Acme Corporation", officeLocation: "City A" },
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });

    const edges = mesh.getStorage().getAllEdges();
    const supersedesEdge = edges.find(
      (e) => e.sourceId === "fact-residence" && e.targetId === "org-acme-corp"
    );
    // Should NOT supersede because organization office != person residence
    expect(supersedesEdge).toBeUndefined();
  });
});
