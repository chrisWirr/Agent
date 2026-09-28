import type { Directive, MissionResult } from "./schemas";
import { MUSIC_PROGRAM_ID, musicArtifactKind } from "../music/project";

type Sql = <T = Record<string, string | number | boolean | null>>(
  strings: TemplateStringsArray,
  ...values: (string | number | boolean | null)[]
) => T[];

type EntryRow = {
  id: string;
  payload: string;
  created_at: number;
  status: string;
};
type EventRow = { kind: string; payload: string; created_at: number };
export type MusicArtifact = {
  id: string;
  mission_id: string;
  kind: string;
  title: string;
  content: string;
  status: "DRAFT";
  created_at: number;
};

export class AutonomyStore {
  constructor(private readonly sql: Sql) {}

  initialize() {
    this.sql`CREATE TABLE IF NOT EXISTS autonomy_entries (
      id TEXT PRIMARY KEY,
      kind TEXT NOT NULL,
      status TEXT NOT NULL,
      payload TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )`;
    this.sql`CREATE TABLE IF NOT EXISTS autonomy_events (
      id TEXT PRIMARY KEY,
      kind TEXT NOT NULL,
      payload TEXT NOT NULL,
      created_at INTEGER NOT NULL
    )`;
    this.sql`CREATE TABLE IF NOT EXISTS music_artifacts (
      id TEXT PRIMARY KEY,
      mission_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      title TEXT NOT NULL,
      content TEXT NOT NULL,
      status TEXT NOT NULL,
      created_at INTEGER NOT NULL
    )`;
    this
      .sql`CREATE INDEX IF NOT EXISTS autonomy_entries_kind_time ON autonomy_entries(kind, created_at DESC)`;
    this
      .sql`CREATE INDEX IF NOT EXISTS autonomy_events_time ON autonomy_events(created_at DESC)`;
  }

  recordEvent(kind: string, payload: object = {}) {
    const id = crypto.randomUUID();
    const now = Date.now();
    this.sql`INSERT INTO autonomy_events (id, kind, payload, created_at)
      VALUES (${id}, ${kind}, ${JSON.stringify(payload)}, ${now})`;
    this.sql`DELETE FROM autonomy_events WHERE id NOT IN
      (SELECT id FROM autonomy_events ORDER BY created_at DESC LIMIT 200)`;
    console.log(
      JSON.stringify({
        type: "autonomy",
        event: kind,
        at: new Date(now).toISOString()
      })
    );
  }

  countEventsSince(kind: string, since: number): number {
    return (
      this.sql<{ count: number }>`SELECT COUNT(*) AS count FROM autonomy_events
      WHERE kind = ${kind} AND created_at >= ${since}`[0]?.count ?? 0
    );
  }

  latestEvent(kind: string): EventRow | undefined {
    return this
      .sql<EventRow>`SELECT kind, payload, created_at FROM autonomy_events
      WHERE kind = ${kind} ORDER BY created_at DESC LIMIT 1`[0];
  }

  eventsAfter(timestamp: number): EventRow[] {
    return this
      .sql<EventRow>`SELECT kind, payload, created_at FROM autonomy_events
      WHERE created_at > ${timestamp} ORDER BY created_at DESC LIMIT 10`;
  }

  recentEvents(): string[] {
    return this
      .sql<EventRow>`SELECT kind, payload, created_at FROM autonomy_events
      ORDER BY created_at DESC LIMIT 10`.map((row) => row.kind);
  }

  recentMusicEvents(): string[] {
    return this
      .sql<EventRow>`SELECT kind, payload, created_at FROM autonomy_events
      ORDER BY created_at DESC LIMIT 100`
      .filter((row) => {
        if (row.kind.startsWith("MUSIC_")) return true;
        try {
          const payload: unknown = JSON.parse(row.payload);
          return (
            payload !== null &&
            typeof payload === "object" &&
            "programId" in payload &&
            payload.programId === MUSIC_PROGRAM_ID
          );
        } catch {
          return false;
        }
      })
      .slice(0, 10)
      .map((row) => row.kind);
  }

  tryAcquireReview(): boolean {
    const staleBefore = Date.now() - 30 * 60 * 1000;
    this
      .sql`DELETE FROM autonomy_entries WHERE id = 'review-lock' AND updated_at < ${staleBefore}`;
    const now = Date.now();
    this.sql`INSERT OR IGNORE INTO autonomy_entries
      (id, kind, status, payload, created_at, updated_at)
      VALUES ('review-lock', 'lock', 'RUNNING', '{}', ${now}, ${now})`;
    return (
      (this.sql<{ count: number }>`SELECT changes() AS count`[0]?.count ??
        0) === 1
    );
  }

  releaseReview() {
    this.sql`DELETE FROM autonomy_entries WHERE id = 'review-lock'`;
  }

  saveDirective(directive: Directive) {
    const now = Date.now();
    this
      .sql`INSERT INTO autonomy_entries (id, kind, status, payload, created_at, updated_at)
      VALUES (${directive.directiveId}, 'directive', ${directive.decision}, ${JSON.stringify(directive)}, ${now}, ${now})`;
    this.recordEvent("DIRECTIVE_CREATED", {
      directiveId: directive.directiveId,
      decision: directive.decision,
      programId: directive.programId
    });
  }

  getDirective(directiveId: string): Directive | null {
    const row = this
      .sql<EntryRow>`SELECT id, payload, created_at, status FROM autonomy_entries
      WHERE id = ${directiveId} AND kind = 'directive' LIMIT 1`[0];
    return row ? (JSON.parse(row.payload) as Directive) : null;
  }

  tryStartMission(directiveId: string): boolean {
    const id = `mission:${directiveId}`;
    const now = Date.now();
    this
      .sql`INSERT OR IGNORE INTO autonomy_entries (id, kind, status, payload, created_at, updated_at)
      VALUES (${id}, 'mission', 'RUNNING', '{}', ${now}, ${now})`;
    const created =
      (this.sql<{ count: number }>`SELECT changes() AS count`[0]?.count ??
        0) === 1;
    if (created) {
      const programId = this.getDirective(directiveId)?.programId;
      this.recordEvent("MISSION_STARTED", { directiveId, programId });
      if (programId === MUSIC_PROGRAM_ID)
        this.recordEvent("MUSIC_MISSION_STARTED", { directiveId, programId });
    }
    return created;
  }

  saveMission(result: MissionResult) {
    const id = `mission:${result.directiveId}`;
    const now = Date.now();
    const programId = this.getDirective(result.directiveId)?.programId;
    this.sql`UPDATE autonomy_entries SET status = ${result.status},
      payload = ${JSON.stringify(result)}, updated_at = ${now} WHERE id = ${id}`;
    this.recordEvent(
      result.status === "FAILED" ? "MISSION_FAILED" : "MISSION_COMPLETED",
      {
        directiveId: result.directiveId,
        missionId: result.missionId,
        status: result.status,
        programId
      }
    );
    if (result.humanGates.length > 0) {
      this.recordEvent("HUMAN_GATE_CREATED", {
        missionId: result.missionId,
        count: result.humanGates.length,
        programId
      });
    }
    if (programId === MUSIC_PROGRAM_ID) {
      for (const run of result.agentRuns) {
        if (run.status === "FAILED") continue;
        run.artifacts.slice(0, 2).forEach((content, index) => {
          const kind = musicArtifactKind(run.role, content);
          if (!kind) return;
          const artifactId = `${result.missionId}:${run.agentId}:${index}`;
          this.sql`INSERT OR IGNORE INTO music_artifacts
            (id, mission_id, kind, title, content, status, created_at)
            VALUES (${artifactId}, ${result.missionId}, ${kind}, ${run.task.slice(0, 160)}, ${content.slice(0, 8000)}, 'DRAFT', ${now})`;
        });
      }
    }
  }

  recentMusicArtifacts(): MusicArtifact[] {
    return this
      .sql<MusicArtifact>`SELECT id, mission_id, kind, title, content, status, created_at
      FROM music_artifacts ORDER BY created_at DESC LIMIT 20`.map((item) => ({
      ...item,
      kind: musicArtifactKind("", item.content) ?? item.kind
    }));
  }

  recentDirectives(): Directive[] {
    return this
      .sql<EntryRow>`SELECT id, payload, created_at, status FROM autonomy_entries
      WHERE kind = 'directive' ORDER BY created_at DESC LIMIT 100`
      .map((row) => JSON.parse(row.payload) as Directive)
      .filter((directive) => directive.programId === MUSIC_PROGRAM_ID)
      .slice(0, 5);
  }

  recentMissions(): MissionResult[] {
    return this
      .sql<EntryRow>`SELECT id, payload, created_at, status FROM autonomy_entries
      WHERE kind = 'mission' AND status != 'RUNNING' ORDER BY created_at DESC LIMIT 100`
      .map((row) => JSON.parse(row.payload) as MissionResult)
      .filter(
        (mission) =>
          this.getDirective(mission.directiveId)?.programId === MUSIC_PROGRAM_ID
      )
      .slice(0, 5);
  }

  currentMission(): { directiveId: string; status: string } | null {
    const row = this
      .sql<EntryRow>`SELECT id, payload, created_at, status FROM autonomy_entries
      WHERE kind = 'mission' AND status = 'RUNNING' ORDER BY created_at DESC LIMIT 1`[0];
    return row ? { directiveId: row.id.slice(8), status: row.status } : null;
  }

  failMission(
    directiveId: string,
    reason = "Mission execution was interrupted"
  ) {
    const id = `mission:${directiveId}`;
    const row = this
      .sql<EntryRow>`SELECT id, payload, created_at, status FROM autonomy_entries
      WHERE id = ${id} AND status = 'RUNNING' LIMIT 1`[0];
    if (!row) return;
    this.saveMission({
      missionId: crypto.randomUUID(),
      directiveId,
      status: "FAILED",
      decisionRecommendation: "UNKNOWN",
      summary: reason,
      evidence: [],
      contradictingEvidence: [],
      assumptions: [],
      unknowns: [reason],
      specialistsUsed: [],
      agentRuns: [],
      modelCalls: 0,
      toolCalls: 0,
      actualCostUsd: null,
      elapsedMs: Date.now() - row.created_at,
      providerFailures: ["MISSION_INTERRUPTED"],
      humanGates: [],
      recommendedNextAction: "Review the failed run before retrying",
      routes: []
    });
  }

  expireStaleMissions(maxAgeMs: number) {
    const staleBefore = Date.now() - maxAgeMs;
    const rows = this
      .sql<EntryRow>`SELECT id, payload, created_at, status FROM autonomy_entries
      WHERE kind = 'mission' AND status = 'RUNNING' AND created_at < ${staleBefore}`;
    for (const row of rows)
      this.failMission(
        row.id.slice(8),
        "Mission exceeded its wall-clock limit"
      );
  }
}
