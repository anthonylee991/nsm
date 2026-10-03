import type { MemoryNode } from "../../core/types.js";
import type { IntegrationProvider, IntegrationConfigField, ConnectionStatus } from "../types.js";

export class SocialSignalIntegration implements IntegrationProvider {
  public id = "social_signal";
  public name = "Public Profile & Social Signal";
  public category = "social" as const;
  public description = "Syncs public affiliations, unverified profile claims, and community graph context";
  public icon = "🌐";
  public status: ConnectionStatus = "disconnected";
  public lastSyncedAt?: number;
  public errorMessage?: string;

  public configFields: IntegrationConfigField[] = [
    {
      key: "handle",
      label: "Username or Handle",
      type: "text",
      placeholder: "e.g. octocat or user123",
      required: true,
      description: "Public user identifier",
    },
    {
      key: "claimsJson",
      label: "Public Claims & Metadata (JSON Object)",
      type: "text",
      placeholder: '{"bio":"Developer","locationClaim":"City, Country"}',
      required: false,
      description: "Arbitrary public claims attached to this social signal",
    },
  ];

  private handle: string = "";
  private claims: Record<string, any> = {};

  public async connect(config: Record<string, any>): Promise<void> {
    const handle = (config.handle || "").trim();
    if (!handle) throw new Error("Handle is required");
    this.handle = handle;

    if (config.claimsJson) {
      try {
        this.claims = JSON.parse(config.claimsJson);
      } catch (err: any) {
        throw new Error(`Invalid claimsJson: ${err.message}`);
      }
    }

    this.status = "connected";
    this.errorMessage = undefined;
  }

  public async disconnect(): Promise<void> {
    this.handle = "";
    this.claims = {};
    this.status = "disconnected";
    this.errorMessage = undefined;
  }

  public async sync(): Promise<MemoryNode[]> {
    if (!this.handle) return [];
    this.status = "syncing";

    const nodeId = `social-${this.handle.toLowerCase()}`;
    const locationClaim = this.claims.locationClaim || this.claims.location;

    const node: MemoryNode = {
      id: nodeId,
      nodeType: "profile",
      label: `Public Profile: @${this.handle}`,
      source: "social_feed",
      authority: 0.60, // Lower epistemic authority than direct user assertions
      entityCategory: "person",
      payload: {
        handle: this.handle,
        publicLocationClaim: locationClaim,
        summary: this.claims.bio || `Public profile for @${this.handle}`,
        ...this.claims,
      },
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };

    this.status = "connected";
    this.lastSyncedAt = Date.now();
    return [node];
  }
}
