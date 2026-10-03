import type { MemoryNode } from "../../core/types.js";
import type { IntegrationProvider, IntegrationConfigField, ConnectionStatus } from "../types.js";

export interface RoutineBlock {
  day: string; // "Monday", "Tuesday", etc.
  startTime: string; // "09:00"
  endTime: string; // "17:00"
  title: string;
  isProtected?: boolean;
}

export class CalendarFeedIntegration implements IntegrationProvider {
  public id = "calendar_feed";
  public name = "Calendar & Horizon Routine";
  public category = "calendar" as const;
  public description = "Syncs temporal horizon commitments, recurring routines, and protected schedule blocks";
  public icon = "🗓️";
  public status: ConnectionStatus = "disconnected";
  public lastSyncedAt?: number;
  public errorMessage?: string;

  public configFields: IntegrationConfigField[] = [
    {
      key: "feedUrl",
      label: "iCal Feed URL (Optional)",
      type: "url",
      placeholder: "https://calendar.google.com/calendar/ical/.../basic.ics",
      required: false,
      description: "Public or secret iCal (.ics) feed URL",
    },
    {
      key: "routineBlocksJson",
      label: "Routine Schedule Blocks (JSON Array)",
      type: "text",
      placeholder: '[{"day":"Saturday","title":"Protected Family Block","isProtected":true}]',
      required: false,
      description: "JSON array of recurring schedule blocks",
    },
  ];

  private feedUrl: string = "";
  private routineBlocks: RoutineBlock[] = [];

  public async connect(config: Record<string, any>): Promise<void> {
    this.feedUrl = (config.feedUrl || "").trim();

    if (config.routineBlocksJson) {
      try {
        const parsed = JSON.parse(config.routineBlocksJson);
        if (Array.isArray(parsed)) {
          this.routineBlocks = parsed;
        }
      } catch (err: any) {
        throw new Error(`Invalid routineBlocksJson format: ${err.message}`);
      }
    }

    this.status = "connected";
    this.errorMessage = undefined;
  }

  public async disconnect(): Promise<void> {
    this.feedUrl = "";
    this.routineBlocks = [];
    this.status = "disconnected";
    this.errorMessage = undefined;
  }

  public async sync(): Promise<MemoryNode[]> {
    this.status = "syncing";
    const nodes: MemoryNode[] = [];

    try {
      // 1. Process custom recurring routine blocks
      for (let i = 0; i < this.routineBlocks.length; i++) {
        const block = this.routineBlocks[i];
        const day = block.day || "Anyday";
        const isProtected = Boolean(block.isProtected);
        const nodeId = `cal-routine-${day.toLowerCase()}-${i}`;

        nodes.push({
          id: nodeId,
          nodeType: isProtected ? "invariant" : "event",
          label: `${day}: ${block.title}`,
          source: "calendar",
          authority: isProtected ? 1.0 : 0.90,
          entityCategory: "event",
          payload: {
            day,
            startTime: block.startTime,
            endTime: block.endTime,
            summary: block.title,
            isProtected,
            conflict: isProtected,
          },
          createdAt: Date.now(),
          updatedAt: Date.now(),
        });
      }

      // 2. Fetch iCal feed if configured
      if (this.feedUrl) {
        const res = await fetch(this.feedUrl, { signal: AbortSignal.timeout(8000) });
        if (res.ok) {
          const icsText = await res.text();
          const icsEvents = this.parseSimpleICS(icsText);
          for (const ev of icsEvents) {
            nodes.push({
              id: `cal-ics-${Buffer.from(ev.summary + ev.dtstart).toString("base64url").substring(0, 16)}`,
              nodeType: "event",
              label: ev.summary,
              source: "calendar",
              authority: 0.90,
              entityCategory: "event",
              payload: {
                summary: ev.summary,
                date: ev.dtstart,
                location: ev.location,
              },
              createdAt: Date.now(),
              updatedAt: Date.now(),
            });
          }
        }
      }

      this.status = "connected";
      this.lastSyncedAt = Date.now();
      return nodes;
    } catch (err: any) {
      this.status = "error";
      this.errorMessage = err.message;
      throw err;
    }
  }

  private parseSimpleICS(icsText: string): Array<{ summary: string; dtstart: string; location?: string }> {
    const events: Array<{ summary: string; dtstart: string; location?: string }> = [];
    const lines = icsText.split(/\r?\n/);
    let inEvent = false;
    let currSummary = "";
    let currDt = "";
    let currLoc = "";

    for (const line of lines) {
      if (line.startsWith("BEGIN:VEVENT")) {
        inEvent = true;
        currSummary = "";
        currDt = "";
        currLoc = "";
      } else if (line.startsWith("END:VEVENT")) {
        if (inEvent && currSummary) {
          events.push({ summary: currSummary, dtstart: currDt, location: currLoc || undefined });
        }
        inEvent = false;
      } else if (inEvent) {
        if (line.startsWith("SUMMARY:")) currSummary = line.substring(8).trim();
        else if (line.startsWith("DTSTART")) {
          const parts = line.split(":");
          currDt = parts.slice(1).join(":").trim();
        } else if (line.startsWith("LOCATION:")) currLoc = line.substring(9).trim();
      }
    }

    return events.slice(0, 50);
  }
}
