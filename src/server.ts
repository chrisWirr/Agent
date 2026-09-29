import { callable, routeAgentRequest, type Schedule } from "agents";
import { getSchedulePrompt, scheduleSchema } from "agents/schedule";
import { AIChatAgent, type OnChatMessageOptions } from "@cloudflare/ai-chat";
import {
  convertToModelMessages,
  jsonSchema,
  pruneMessages,
  stepCountIs,
  streamText,
  tool
} from "ai";
import { z } from "zod";
import { createChatWorkersAI } from "./chat-model";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { Buffer } from "node:buffer";
import { createModelRunner } from "./autonomy/model";
import {
  compactStateSummary,
  DEFAULT_LIMITS,
  runRootMission,
  runStrategistReview
} from "./autonomy/orchestrator";
import { spawnSpecialist } from "./autonomy/runtime";
import { AutonomyStore } from "./autonomy/store";
import {
  readViaBridge,
  searchPublicWeb,
  searchViaBridge
} from "./autonomy/research";
import { directiveSchema, missionResultSchema } from "./autonomy/schemas";
import { ARTIST_BRIEF, MUSIC_PROGRAM_ID } from "./music/project";
import {
  auditSunoReturn,
  prepareSunoPackage,
  songText,
  sunoAuditStatus,
  sunoSubmissionSchema,
  type SunoHandoff
} from "./music/suno";
import {
  approvalBlockers,
  approvalSchema,
  distributionPacket,
  approveRelease,
  RELEASE_STRATEGY
} from "./music/release";
import {
  ensureReleases,
  releaseBridge,
  releaseSummary,
  runReleaseTick
} from "./music/pipeline";

function safeSunoError(error: unknown): string {
  if (error instanceof z.ZodError) return "MODEL_RESPONSE_SCHEMA_INVALID";
  if (error instanceof SyntaxError) return "MODEL_RESPONSE_JSON_INVALID";
  if (error instanceof Error) {
    if (error.message === "Model did not return a JSON object")
      return "MODEL_RESPONSE_JSON_MISSING";
    if (error.message === "MODEL_REQUEST_FAILED") return error.message;
    if (error.message === "AUDIO_TRANSCRIPT_REQUIRED") return error.message;
  }
  return "SUNO_AUDIT_FAILED";
}

async function selectModel(env: Env) {
  const workersai = createChatWorkersAI(env.AI);
  const requested =
    env.ROOT_MODEL || "@cf/meta/llama-3.3-70b-instruct-fp8-fast";
  const fallback = workersai("@cf/meta/llama-3.3-70b-instruct-fp8-fast");

  if (requested.startsWith("@cf/")) return workersai(requested);

  if (!env.OPENCLAW_BASE_URL || !env.OPENCLAW_GATEWAY_TOKEN) {
    return fallback;
  }

  try {
    const response = await fetch(`${env.OPENCLAW_BASE_URL}/v1/models`, {
      headers: {
        authorization: `Bearer ${env.OPENCLAW_GATEWAY_TOKEN}`
      },
      signal: AbortSignal.timeout(2500)
    });

    if (!response.ok) {
      console.warn(`OpenClaw health check failed with ${response.status}`);
      return fallback;
    }

    const openclaw = createOpenAICompatible({
      name: "openclaw",
      baseURL: `${env.OPENCLAW_BASE_URL}/v1`,
      apiKey: env.OPENCLAW_GATEWAY_TOKEN
    });

    return openclaw(requested);
  } catch {
    console.warn("OpenClaw is unavailable; using Workers AI");
    return fallback;
  }
}

export class ChatAgent extends AIChatAgent<Env> {
  maxPersistedMessages = 100;
  chatRecovery = true;
  waitForMcpConnections = true;

  async onStart() {
    const store = new AutonomyStore(this.sql.bind(this));
    store.initialize();
    const configuredMinutes = Number(this.env.STRATEGIST_REVIEW_MINUTES || 360);
    const minutes = Number.isFinite(configuredMinutes)
      ? Math.max(60, Math.min(1440, configuredMinutes))
      : 360;
    await this.scheduleEvery(minutes * 60, "scheduledStrategistReview");
    await this.scheduleEvery(60, "scheduledReleaseTick");
    await this.queueSunoPreparation();
    if (store.recentDirectives().length === 0) {
      const failedBefore = Boolean(
        store.latestEvent("MUSIC_STRATEGIST_REVIEW_FAILED")
      );
      await this.schedule(
        failedBefore ? 180 : 10,
        "scheduledStrategistReview",
        "first-review",
        { idempotent: true }
      );
    }
    this.mcp.configureOAuthCallback({
      customHandler: (result) => {
        if (result.authSuccess) {
          return new Response("<script>window.close();</script>", {
            headers: { "content-type": "text/html" },
            status: 200
          });
        }

        return new Response(
          `Authentication Failed: ${result.authError || "Unknown error"}`,
          {
            headers: { "content-type": "text/plain" },
            status: 400
          }
        );
      }
    });
  }

  @callable()
  async addServer(name: string, url: string) {
    return await this.addMcpServer(name, url);
  }

  @callable()
  async removeServer(serverId: string) {
    await this.removeMcpServer(serverId);
  }

  getAutonomyStatus() {
    const store = new AutonomyStore(this.sql.bind(this));
    store.initialize();
    const directives = store.recentDirectives();
    const missions = store.recentMissions();
    return {
      programId: MUSIC_PROGRAM_ID,
      releases: store.recentReleases().map(releaseSummary),
      lastDecision: directives[0]?.decision ?? "NONE",
      currentMission: store.currentMission(),
      lastMission: missions[0]
        ? {
            status: missions[0].status,
            summary: missions[0].summary,
            specialistsUsed: missions[0].specialistsUsed,
            modelCalls: missions[0].modelCalls,
            toolCalls: missions[0].toolCalls,
            actualCostUsd: missions[0].actualCostUsd,
            providerFailures: missions[0].providerFailures,
            routes: missions[0].routes,
            evidenceCount: missions[0].evidence.length,
            evidence: missions[0].evidence.slice(0, 5),
            humanGates: missions[0].humanGates,
            agentRuns: missions[0].agentRuns.map((run) => ({
              role: run.role,
              task: run.task,
              status: run.status,
              limitations: run.limitations,
              modelCalls: run.modelCalls,
              toolCalls: run.toolCalls,
              route: run.route
            }))
          }
        : null,
      recentEvents: store.recentMusicEvents(),
      musicDrafts: store
        .recentMusicArtifacts()
        .slice(0, 5)
        .map((item) => ({
          id: item.id,
          kind: item.kind,
          title: item.title,
          status: item.status
        })),
      sunoHandoffs: store
        .recentSunoHandoffs()
        .slice(0, 3)
        .map((handoff) => ({
          id: handoff.id,
          title: handoff.title,
          status: handoff.status,
          stylePrompt:
            handoff.status === "READY_FOR_SUNO"
              ? handoff.preparation?.stylePrompt
              : undefined,
          lyrics:
            handoff.status === "READY_FOR_SUNO" ? handoff.lyrics : undefined,
          auditDecision: handoff.audit?.decision
        }))
    };
  }

  getMusicWorkspace() {
    const store = new AutonomyStore(this.sql.bind(this));
    store.initialize();
    ensureReleases(store);
    return {
      programId: MUSIC_PROGRAM_ID,
      releaseStrategy: RELEASE_STRATEGY,
      releases: store.recentReleases().map((release) => {
        const handoff = store.getSunoHandoff(release.handoffId)!;
        const hasAudio = store.hasAudio(release.audioHash);
        return {
          ...release,
          distributionPacket: distributionPacket(release, handoff),
          hasAudio,
          blockers: approvalBlockers(release, handoff, hasAudio)
        };
      }),
      artistBrief: ARTIST_BRIEF,
      drafts: store.recentMusicArtifacts(),
      sunoHandoffs: store.recentSunoHandoffs(),
      lastDirective: store.recentDirectives()[0] ?? null,
      lastMission: store.recentMissions()[0] ?? null
    };
  }

  async scheduledReleaseTick() {
    const store = new AutonomyStore(this.sql.bind(this));
    store.initialize();
    const failedAudit = store
      .recentSunoHandoffs()
      .find(
        (handoff) =>
          handoff.status === "FAILED" &&
          handoff.submission?.audioEvidence?.transcript
      );
    if (failedAudit) await this.retrySunoAudit(failedAudit.id);
    await runReleaseTick(store, this.env);
  }

  async approveMusicRelease(input: unknown) {
    const store = new AutonomyStore(this.sql.bind(this));
    store.initialize();
    ensureReleases(store);
    const parsed = approvalSchema.parse(input);
    const id = parsed.handoffId;
    const capabilities = z
      .object({
        rendererReady: z.boolean(),
        youtubeConfigured: z.boolean(),
        channelId: z.string().nullable()
      })
      .parse(await releaseBridge(this.env, "/music/capabilities"));
    if (
      !capabilities.rendererReady ||
      !capabilities.youtubeConfigured ||
      capabilities.channelId !== parsed.channelId
    )
      return { accepted: false, reason: "CHANNEL_NOT_CONNECTED_OR_CHANGED" };
    const release = store.getRelease(`release:${id}`);
    const handoff = store.getSunoHandoff(id);
    if (!release || !handoff)
      return { accepted: false, reason: "HANDOFF_NOT_FOUND" };
    const approved = await approveRelease(
      release,
      handoff,
      store.hasAudio(release.audioHash),
      input
    );
    // Recheck after hashing (an async boundary) so duplicate approvals cannot reset jobs.
    if (store.getRelease(release.id)?.approvedAt)
      return { accepted: false, reason: "ALREADY_APPROVED" };
    store.saveRelease(approved);
    store.recordEvent("MUSIC_RELEASE_APPROVED", { releaseId: release.id });
    await this.schedule(1, "scheduledReleaseTick");
    return { accepted: true };
  }

  setReleasePaused(id: string, paused: boolean) {
    const store = new AutonomyStore(this.sql.bind(this));
    store.initialize();
    const release = store.getRelease(id);
    if (!release) return { accepted: false, reason: "RELEASE_NOT_FOUND" };
    store.saveRelease({
      ...release,
      paused,
      updatedAt: new Date().toISOString()
    });
    return { accepted: true };
  }

  async retainReleaseAudio(handoffId: string, base64: string) {
    if (base64.length > 8_000_000) throw new Error("AUDIO_TOO_LARGE");
    const store = new AutonomyStore(this.sql.bind(this));
    store.initialize();
    const handoff = store.getSunoHandoff(handoffId);
    if (!handoff?.submission?.audioEvidence)
      throw new Error("AUDIO_NOT_AUDITED");
    const hash = Buffer.from(
      await crypto.subtle.digest("SHA-256", Buffer.from(base64, "base64"))
    ).toString("hex");
    if (hash !== handoff.submission.audioEvidence.sha256)
      throw new Error("AUDIO_HASH_MISMATCH");
    store.saveAudio(hash, base64);
    ensureReleases(store);
    return { accepted: true };
  }

  async queueSunoPreparation() {
    const store = new AutonomyStore(this.sql.bind(this));
    store.initialize();
    const drafts = store.recentMusicArtifacts();
    const revision = drafts.find((item) => item.kind === "SONG_REVISION");
    if (!revision) return { queued: false, reason: "NO_REVISED_SONG" };
    const review = drafts.find(
      (item) =>
        item.kind === "LYRIC_REVIEW" && item.mission_id === revision.mission_id
    );
    if (!review) return { queued: false, reason: "LYRIC_REVIEW_MISSING" };
    const id = `suno:${revision.id}`;
    const existing = store.getSunoHandoff(id);
    if (existing) {
      if (existing.status !== "FAILED" || existing.preparation)
        return { queued: false, reason: "ALREADY_PREPARED", handoffId: id };
      if (
        store.countEventsSince(
          "MUSIC_SUNO_PREPARATION_FAILED",
          Date.now() - 24 * 60 * 60 * 1000
        ) >= 2
      )
        return {
          queued: false,
          reason: "PREPARATION_RETRY_LIMIT",
          handoffId: id
        };
      store.saveSunoHandoff({
        ...existing,
        status: "PREPARING",
        updatedAt: new Date().toISOString()
      });
      await this.schedule(10, "scheduledPrepareSuno", id, {
        idempotent: true
      });
      return { queued: true, handoffId: id, retry: true };
    }
    const song = songText(revision.content);
    const now = new Date().toISOString();
    const handoff: SunoHandoff = {
      id,
      sourceArtifactId: revision.id,
      sourceMissionId: revision.mission_id,
      title: song.title,
      lyrics: song.lyrics,
      preparation: null,
      status: "PREPARING",
      submission: null,
      audit: null,
      createdAt: now,
      updatedAt: now
    };
    store.saveSunoHandoff(handoff);
    store.recordEvent("MUSIC_SUNO_PREPARATION_QUEUED", {
      handoffId: id,
      sourceArtifactId: revision.id
    });
    await this.schedule(10, "scheduledPrepareSuno", id, {
      idempotent: true
    });
    return { queued: true, handoffId: id };
  }

  async scheduledPrepareSuno(handoffId: string) {
    const store = new AutonomyStore(this.sql.bind(this));
    store.initialize();
    const handoff = store.getSunoHandoff(handoffId);
    if (!handoff || handoff.status !== "PREPARING") return;
    const revision = store.getMusicArtifact(handoff.sourceArtifactId);
    const drafts = store.recentMusicArtifacts();
    const review = drafts.find(
      (item) =>
        item.kind === "LYRIC_REVIEW" &&
        item.mission_id === handoff.sourceMissionId
    );
    if (!revision || revision.kind !== "SONG_REVISION" || !review) {
      store.saveSunoHandoff({
        ...handoff,
        status: "FAILED",
        updatedAt: new Date().toISOString()
      });
      store.recordEvent("MUSIC_SUNO_PREPARATION_FAILED", { handoffId });
      return;
    }
    const production = drafts.find((item) => item.kind === "PRODUCTION_BRIEF");
    try {
      const preparation = await prepareSunoPackage(
        {
          title: handoff.title,
          lyrics: handoff.lyrics,
          lyricReview: songText(review.content).lyrics,
          productionBrief: production?.content ?? ""
        },
        createModelRunner(this.env)
      );
      store.saveSunoHandoff({
        ...handoff,
        preparation,
        status:
          preparation.decision === "READY"
            ? "READY_FOR_SUNO"
            : "NEEDS_REVISION",
        updatedAt: new Date().toISOString()
      });
      store.recordEvent("MUSIC_SUNO_PREPARATION_COMPLETED", {
        handoffId,
        decision: preparation.decision
      });
    } catch {
      store.saveSunoHandoff({
        ...handoff,
        status: "FAILED",
        updatedAt: new Date().toISOString()
      });
      store.recordEvent("MUSIC_SUNO_PREPARATION_FAILED", { handoffId });
    }
  }

  async submitSunoResult(input: unknown, audioBase64?: string) {
    const submission = sunoSubmissionSchema.parse(input);
    const store = new AutonomyStore(this.sql.bind(this));
    store.initialize();
    const handoff = store.getSunoHandoff(submission.handoffId);
    if (!handoff) return { accepted: false, reason: "HANDOFF_NOT_FOUND" };
    if (!["READY_FOR_SUNO", "AWAITING_AUDIO"].includes(handoff.status))
      return { accepted: false, reason: "HANDOFF_NOT_READY" };
    const readyForAudit = Boolean(submission.audioEvidence?.transcript.trim());
    store.saveSunoHandoff({
      ...handoff,
      submission,
      status: readyForAudit ? "AUDITING" : "AWAITING_AUDIO",
      updatedAt: new Date().toISOString()
    });
    store.recordEvent("MUSIC_SUNO_RESULT_RECEIVED", {
      handoffId: handoff.id,
      hasTranscript: readyForAudit
    });
    if (audioBase64) await this.retainReleaseAudio(handoff.id, audioBase64);
    if (readyForAudit)
      await this.schedule(10, "scheduledAuditSuno", handoff.id, {
        idempotent: true
      });
    return {
      accepted: true,
      handoffId: handoff.id,
      status: readyForAudit ? "AUDITING" : "AWAITING_AUDIO"
    };
  }

  async scheduledAuditSuno(handoffId: string) {
    const store = new AutonomyStore(this.sql.bind(this));
    store.initialize();
    const handoff = store.getSunoHandoff(handoffId);
    if (!handoff || handoff.status !== "AUDITING") return;
    try {
      const audit = await auditSunoReturn(handoff, createModelRunner(this.env));
      const status = sunoAuditStatus(
        audit.decision,
        handoff.submission?.rightsBasis ?? "UNKNOWN"
      );
      store.saveSunoHandoff({
        ...handoff,
        audit,
        status,
        lastError: undefined,
        updatedAt: new Date().toISOString()
      });
      store.recordEvent("MUSIC_SUNO_AUDIT_COMPLETED", {
        handoffId,
        decision: audit.decision,
        status
      });
    } catch (error) {
      const code = safeSunoError(error);
      store.saveSunoHandoff({
        ...handoff,
        status: "FAILED",
        lastError: code,
        updatedAt: new Date().toISOString()
      });
      store.recordEvent("MUSIC_SUNO_AUDIT_FAILED", { handoffId, code });
    }
  }

  async retrySunoAudit(handoffId: string) {
    const store = new AutonomyStore(this.sql.bind(this));
    store.initialize();
    const handoff = store.getSunoHandoff(handoffId);
    if (
      !handoff ||
      handoff.status !== "FAILED" ||
      !handoff.submission?.audioEvidence?.transcript.trim()
    )
      return { queued: false, reason: "NO_FAILED_AUDIT" };
    if (
      store.countEventsSince(
        "MUSIC_SUNO_AUDIT_FAILED",
        Date.now() - 24 * 60 * 60 * 1000
      ) >= 2
    )
      return { queued: false, reason: "AUDIT_RETRY_LIMIT" };
    store.saveSunoHandoff({
      ...handoff,
      status: "AUDITING",
      lastError: undefined,
      updatedAt: new Date().toISOString()
    });
    await this.schedule(10, "scheduledAuditSuno", handoffId, {
      idempotent: true
    });
    return { queued: true, handoffId };
  }

  async queueLyricsReview() {
    const store = new AutonomyStore(this.sql.bind(this));
    store.initialize();
    const song = store
      .recentMusicArtifacts()
      .find((artifact) => artifact.kind === "SONG_DRAFT");
    if (!song) return { queued: false, reason: "NO_SONG_DRAFT" };
    const baseDirectiveId = `lyrics-review:${song.id}`;
    let directiveId = baseDirectiveId;
    for (const suffix of [":retry", ":retry-2"]) {
      if (!store.getDirective(directiveId)) break;
      const prior = store
        .recentMissions()
        .find((mission) => mission.directiveId === directiveId);
      if (prior?.status !== "FAILED" && prior?.status !== "PARTIAL")
        return { queued: false, reason: "ALREADY_REVIEWED_OR_QUEUED" };
      directiveId = `${baseDirectiveId}${suffix}`;
    }
    if (store.getDirective(directiveId))
      return { queued: false, reason: "REVIEW_ATTEMPTS_EXHAUSTED" };
    const directive = directiveSchema.parse({
      directiveId,
      programId: MUSIC_PROGRAM_ID,
      decision: "ITERATE",
      objective: "Independently review and revise the existing song lyrics",
      reason: "The first song needs a dedicated English-language lyric editor.",
      successCriteria: [
        "Line-specific critique",
        "Complete revised original lyrics"
      ],
      constraints: ["No external publication or contact"],
      priority: 2,
      maxBudgetUsd: 0,
      timeLimitMinutes: 5,
      requiredEvidence: [],
      deliverable: "Lyric review and full song revision",
      createdAt: new Date().toISOString()
    });
    store.saveDirective(directive);
    store.recordEvent("MUSIC_LYRICS_REVIEW_QUEUED", {
      directiveId,
      sourceArtifactId: song.id
    });
    await this.schedule(10, "scheduledLyricsReview", directiveId, {
      idempotent: true
    });
    return { queued: true, directiveId };
  }

  async scheduledLyricsReview() {
    const store = new AutonomyStore(this.sql.bind(this));
    store.initialize();
    store.expireStaleMissions(35 * 60 * 1000);
    const event = store.latestEvent("MUSIC_LYRICS_REVIEW_QUEUED");
    if (!event) return;
    const payload = JSON.parse(event.payload) as {
      directiveId: string;
      sourceArtifactId: string;
    };
    const directive = store.getDirective(payload.directiveId);
    const song = store
      .recentMusicArtifacts()
      .find((artifact) => artifact.id === payload.sourceArtifactId);
    if (!directive || !song || song.kind !== "SONG_DRAFT") return;
    if (store.currentMission() || !store.tryAcquireReview()) {
      await this.schedule(120, "scheduledLyricsReview", payload.directiveId, {
        idempotent: true
      });
      return;
    }
    let started = false;
    try {
      if (!store.tryStartMission(payload.directiveId)) return;
      started = true;
      const missionId = crypto.randomUUID();
      const startTime = Date.now();
      store.recordEvent("AGENT_SPAWNED", {
        missionId,
        role: "LYRICS_EXPERT"
      });
      const run = await spawnSpecialist(
        {
          agentId: crypto.randomUUID(),
          role: "LYRICS_EXPERT",
          objective: directive.objective,
          task: "Give a candid, line-specific lyric critique and a complete revised version of the supplied song.",
          context: JSON.stringify({
            artistBrief: ARTIST_BRIEF,
            sourceArtifact: { id: song.id, content: song.content }
          }).slice(0, 11000),
          allowedTools: [],
          maxModelCalls: 1,
          maxToolCalls: 0,
          timeoutMs: 120000,
          maxBudgetUsd: 0,
          parentMissionId: missionId,
          delegationDepth: 2,
          reasonForDelegation:
            "The existing song needs an independent lyric craft review.",
          expectedValueOfDelegation:
            "Actionable critique and a singable second draft."
        },
        { runModel: createModelRunner(this.env) }
      );
      store.recordEvent(
        run.status === "FAILED" ? "AGENT_FAILED" : "AGENT_COMPLETED",
        { missionId, role: run.role, status: run.status }
      );
      store.saveMission(
        missionResultSchema.parse({
          missionId,
          directiveId: payload.directiveId,
          status: run.status,
          decisionRecommendation: "ITERATE",
          summary: run.summary,
          evidence: [],
          contradictingEvidence: [],
          assumptions: run.assumptions,
          unknowns: run.unknowns,
          specialistsUsed: [run.role],
          agentRuns: [run],
          modelCalls: run.modelCalls,
          toolCalls: run.toolCalls,
          actualCostUsd: null,
          elapsedMs: Date.now() - startTime,
          providerFailures:
            run.status === "FAILED" ? ["LYRICS_EXPERT_FAILED"] : [],
          humanGates: [],
          recommendedNextAction: run.recommendedNextAction,
          routes: [run.route]
        })
      );
      started = false;
      await this.queueSunoPreparation();
    } catch {
      if (started) store.failMission(payload.directiveId);
      store.recordEvent("MUSIC_LYRICS_REVIEW_FAILED", {
        directiveId: payload.directiveId
      });
    } finally {
      store.releaseReview();
    }
  }

  async queueExternalDirective(input: unknown) {
    const directive = directiveSchema.parse(input);
    if (directive.programId !== MUSIC_PROGRAM_ID)
      return { queued: false, reason: "WRONG_PROGRAM" };
    if (directive.decision === "WAIT" || directive.decision === "KILL")
      return { queued: false, reason: "NO_MISSION_REQUESTED" };
    const store = new AutonomyStore(this.sql.bind(this));
    store.initialize();
    if (store.getDirective(directive.directiveId))
      return { queued: false, reason: "DUPLICATE_DIRECTIVE" };
    if (store.currentMission())
      return { queued: false, reason: "MISSION_IN_PROGRESS" };
    if (
      store.countEventsSince(
        "EXTERNAL_DIRECTIVE_QUEUED",
        Date.now() - 24 * 60 * 60 * 1000
      ) >= 1
    )
      return { queued: false, reason: "EXTERNAL_DIRECTIVE_LIMIT_REACHED" };
    store.saveDirective(directive);
    store.recordEvent("EXTERNAL_DIRECTIVE_QUEUED", {
      directiveId: directive.directiveId
    });
    await this.schedule(
      10,
      "scheduledExternalDirective",
      directive.directiveId,
      {
        idempotent: true
      }
    );
    return { queued: true, directiveId: directive.directiveId };
  }

  async scheduledExternalDirective() {
    const store = new AutonomyStore(this.sql.bind(this));
    store.initialize();
    store.expireStaleMissions(35 * 60 * 1000);
    const event = store.latestEvent("EXTERNAL_DIRECTIVE_QUEUED");
    if (!event) return;
    let directiveId: string;
    try {
      const payload: unknown = JSON.parse(event.payload);
      if (
        !payload ||
        typeof payload !== "object" ||
        !("directiveId" in payload) ||
        typeof payload.directiveId !== "string"
      )
        return;
      directiveId = payload.directiveId;
    } catch {
      return;
    }
    const directive = store.getDirective(directiveId);
    if (!directive || directive.programId !== MUSIC_PROGRAM_ID) return;
    if (store.currentMission() || !store.tryAcquireReview()) {
      await this.schedule(120, "scheduledExternalDirective", directiveId, {
        idempotent: true
      });
      return;
    }
    let activeDirectiveId: string | null = null;
    try {
      if (!store.tryStartMission(directiveId)) return;
      activeDirectiveId = directiveId;
      const result = await runRootMission(
        directive,
        {
          runModel: createModelRunner(this.env),
          search: (query) =>
            searchViaBridge(
              query,
              this.env.OPENCLAW_BASE_URL,
              this.env.OPENCLAW_GATEWAY_TOKEN
            ),
          readPage: (url) =>
            readViaBridge(
              url,
              this.env.OPENCLAW_BASE_URL,
              this.env.OPENCLAW_GATEWAY_TOKEN
            )
        },
        DEFAULT_LIMITS,
        (name, payload) => store.recordEvent(name, payload)
      );
      store.saveMission(result);
      activeDirectiveId = null;
      await this.queueSunoPreparation();
      for (const route of result.routes) {
        if (route.fallbackUsed)
          store.recordEvent("FALLBACK_USED", {
            role: "MISSION",
            reason: route.fallbackReason
          });
      }
    } catch {
      if (activeDirectiveId) store.failMission(activeDirectiveId);
      store.recordEvent("EXTERNAL_DIRECTIVE_FAILED", { directiveId });
    } finally {
      store.releaseReview();
    }
  }

  async retryExternalDirective() {
    const store = new AutonomyStore(this.sql.bind(this));
    store.initialize();
    if (store.currentMission())
      return { queued: false, reason: "MISSION_IN_PROGRESS" };
    if (
      store.countEventsSince(
        "EXTERNAL_DIRECTIVE_RETRIED",
        Date.now() - 24 * 60 * 60 * 1000
      ) >= 5
    )
      return { queued: false, reason: "RETRY_LIMIT_REACHED" };
    const event = store.latestEvent("EXTERNAL_DIRECTIVE_QUEUED");
    const previous = store.recentMissions()[0];
    if (
      !event ||
      !previous ||
      !["FAILED", "HUMAN_GATE_REQUIRED"].includes(previous.status)
    )
      return { queued: false, reason: "NO_FAILED_EXTERNAL_MISSION" };
    let originalId: string;
    try {
      const payload: unknown = JSON.parse(event.payload);
      if (
        !payload ||
        typeof payload !== "object" ||
        !("directiveId" in payload) ||
        typeof payload.directiveId !== "string"
      )
        return { queued: false, reason: "INVALID_QUEUED_DIRECTIVE" };
      originalId = payload.directiveId;
    } catch {
      return { queued: false, reason: "INVALID_QUEUED_DIRECTIVE" };
    }
    if (
      previous.directiveId !== originalId ||
      (previous.status === "FAILED" && previous.evidence.length > 0)
    )
      return { queued: false, reason: "NO_FAILED_EXTERNAL_MISSION" };
    const original = store.getDirective(originalId);
    if (!original || original.programId !== MUSIC_PROGRAM_ID)
      return { queued: false, reason: "DIRECTIVE_NOT_FOUND" };
    const directive = directiveSchema.parse({
      ...original,
      directiveId: crypto.randomUUID(),
      reason:
        `${original.reason} Reprüfung nach Korrektur der Originalseiten-Auswertung.`.slice(
          0,
          1200
        ),
      createdAt: new Date().toISOString()
    });
    store.saveDirective(directive);
    store.recordEvent("EXTERNAL_DIRECTIVE_RETRIED", {
      originalId,
      directiveId: directive.directiveId
    });
    store.recordEvent("EXTERNAL_DIRECTIVE_QUEUED", {
      directiveId: directive.directiveId
    });
    await this.schedule(
      10,
      "scheduledExternalDirective",
      directive.directiveId,
      { idempotent: true }
    );
    return { queued: true, directiveId: directive.directiveId };
  }

  async retryFailedResearchMission() {
    const store = new AutonomyStore(this.sql.bind(this));
    store.initialize();
    const previous = store.recentMissions()[0];
    const eligible =
      previous &&
      previous.evidence.length === 0 &&
      previous.agentRuns.length > 0 &&
      previous.agentRuns.every((run) =>
        ["FAILED", "PARTIAL"].includes(run.status)
      );
    if (!eligible || store.currentMission())
      return { started: false, reason: "NO_ELIGIBLE_FAILED_MISSION" };
    if (
      store.countEventsSince(
        "MANUAL_RETRY",
        Date.now() - 24 * 60 * 60 * 1000
      ) >= 3
    )
      return { started: false, reason: "RETRY_LIMIT_REACHED" };
    if (!store.tryAcquireReview())
      return { started: false, reason: "REVIEW_IN_PROGRESS" };

    let activeDirectiveId: string | null = null;
    try {
      const original = store
        .recentDirectives()
        .find((directive) => directive.directiveId === previous.directiveId);
      if (!original) return { started: false, reason: "DIRECTIVE_NOT_FOUND" };
      const directive = directiveSchema.parse({
        ...original,
        directiveId: crypto.randomUUID(),
        decision: "ITERATE",
        reason: "Technical retry of music-project research",
        createdAt: new Date().toISOString()
      });
      store.saveDirective(directive);
      if (!store.tryStartMission(directive.directiveId))
        return { started: false, reason: "DUPLICATE_MISSION" };
      activeDirectiveId = directive.directiveId;
      store.recordEvent("MANUAL_RETRY", { directiveId: directive.directiveId });
      const result = await runRootMission(
        directive,
        {
          runModel: createModelRunner(this.env),
          search: (query) =>
            searchViaBridge(
              query,
              this.env.OPENCLAW_BASE_URL,
              this.env.OPENCLAW_GATEWAY_TOKEN
            ),
          readPage: (url) =>
            readViaBridge(
              url,
              this.env.OPENCLAW_BASE_URL,
              this.env.OPENCLAW_GATEWAY_TOKEN
            )
        },
        DEFAULT_LIMITS,
        (event, payload) => store.recordEvent(event, payload)
      );
      store.saveMission(result);
      activeDirectiveId = null;
      await this.queueSunoPreparation();
      return {
        started: true,
        status: result.status,
        evidenceCount: result.evidence.length,
        specialistsUsed: result.specialistsUsed
      };
    } catch {
      if (activeDirectiveId) store.failMission(activeDirectiveId);
      store.recordEvent("MANUAL_RETRY_FAILED");
      return { started: false, reason: "RETRY_FAILED" };
    } finally {
      store.releaseReview();
    }
  }

  async scheduledStrategistReview() {
    const store = new AutonomyStore(this.sql.bind(this));
    store.initialize();
    store.expireStaleMissions(35 * 60 * 1000);
    const now = Date.now();
    const dayAgo = now - 24 * 60 * 60 * 1000;
    const lastReview = store.latestEvent("MUSIC_STRATEGIST_REVIEW");
    const lastFailure = store.latestEvent("MUSIC_STRATEGIST_REVIEW_FAILED");
    if (store.currentMission()) return;
    if (
      store.countEventsSince("MUSIC_STRATEGIST_REVIEW_SUCCEEDED", dayAgo) >=
        DEFAULT_LIMITS.maxStrategistCallsPerDay ||
      store.countEventsSince("MUSIC_STRATEGIST_REVIEW", dayAgo) >= 6
    )
      return;
    if (
      lastReview &&
      now - lastReview.created_at <
        (lastFailure && lastFailure.created_at >= lastReview.created_at
          ? 2
          : DEFAULT_LIMITS.reviewCooldownMinutes) *
          60 *
          1000
    )
      return;
    if (!store.tryAcquireReview()) return;

    let activeDirectiveId: string | null = null;
    try {
      store.recordEvent("MUSIC_STRATEGIST_REVIEW", {
        programId: MUSIC_PROGRAM_ID
      });
      const previousMissions = store.recentMissions();
      const summary = compactStateSummary({
        recentDirectives: store.recentDirectives(),
        recentMissions: previousMissions,
        musicArtifacts: store.recentMusicArtifacts(),
        releaseProgress: store.recentReleases().map(releaseSummary),
        sunoHandoffs: store.recentSunoHandoffs().map((handoff) => ({
          title: handoff.title,
          status: handoff.status,
          auditDecision: handoff.audit?.decision
        })),
        pendingHumanGates: previousMissions.reduce(
          (sum, mission) => sum + mission.humanGates.length,
          0
        ),
        recentEvents: store.recentMusicEvents()
      });
      const runner = createModelRunner(this.env);
      const { directive, route } = await runStrategistReview(summary, runner);
      store.recordEvent("MUSIC_STRATEGIST_REVIEW_SUCCEEDED", {
        programId: MUSIC_PROGRAM_ID
      });
      store.saveDirective(directive);
      if (route.fallbackUsed)
        store.recordEvent("FALLBACK_USED", {
          role: "STRATEGIST",
          reason: route.fallbackReason
        });
      if (directive.decision === "WAIT" || directive.decision === "KILL")
        return;
      if (
        store.countEventsSince("MUSIC_MISSION_STARTED", dayAgo) >=
        DEFAULT_LIMITS.maxMissionsPerDay
      ) {
        store.recordEvent("BUDGET_LIMIT_REACHED", {
          limit: "missions-per-day"
        });
        return;
      }
      if (!store.tryStartMission(directive.directiveId)) return;
      activeDirectiveId = directive.directiveId;
      const result = await runRootMission(
        directive,
        {
          runModel: runner,
          search: (query) =>
            searchViaBridge(
              query,
              this.env.OPENCLAW_BASE_URL,
              this.env.OPENCLAW_GATEWAY_TOKEN
            ),
          readPage: (url) =>
            readViaBridge(
              url,
              this.env.OPENCLAW_BASE_URL,
              this.env.OPENCLAW_GATEWAY_TOKEN
            )
        },
        DEFAULT_LIMITS,
        (event, payload) => store.recordEvent(event, payload)
      );
      store.saveMission(result);
      activeDirectiveId = null;
      await this.queueSunoPreparation();
      for (const usedRoute of result.routes) {
        if (usedRoute.fallbackUsed)
          store.recordEvent("FALLBACK_USED", {
            role: "MISSION",
            reason: usedRoute.fallbackReason
          });
      }
      await this.schedule(
        DEFAULT_LIMITS.reviewCooldownMinutes * 60,
        "scheduledStrategistReview",
        "mission-completed",
        { idempotent: true }
      );
    } catch (error) {
      if (activeDirectiveId) store.failMission(activeDirectiveId);
      const failureType =
        error instanceof z.ZodError
          ? `SCHEMA:${error.issues.map((issue) => issue.path.join(".")).join(",")}`
          : error instanceof SyntaxError
            ? "INVALID_JSON"
            : error instanceof Error &&
                [
                  "MODEL_REQUEST_FAILED",
                  "Model did not return a JSON object"
                ].includes(error.message)
              ? error.message
              : "UNKNOWN";
      console.warn(`Strategist review failed: ${failureType}`);
      store.recordEvent("MUSIC_STRATEGIST_REVIEW_FAILED", {
        failureType,
        programId: MUSIC_PROGRAM_ID
      });
      await this.schedule(120, "scheduledStrategistReview", "failed-review", {
        idempotent: true
      });
    } finally {
      store.releaseReview();
    }
  }

  async onChatMessage(_onFinish: unknown, options?: OnChatMessageOptions) {
    const mcpTools = this.mcp.getAITools();

    const result = streamText({
      model: await selectModel(this.env),

      system: `
You are ROOT, the coordinator of an original English-language singer project. STRATEGIST chooses the next artistic priority; you turn it into reviewable work by specialist agents. The direction is alternative soul with a warm, rough-edged and emotionally powerful female voice, candid writing, and hip-hop/trap rhythms.
Keep the artist's identity coherent across songs. Every song needs a clear emotional statement, a distinctive original line and a chorus that works with piano or guitar alone. Treat references as qualities to learn from, never as a real artist to impersonate, a voice to clone, or lyrics or melody to copy.
Separate drafted lyrics, production plans and artwork briefs from actual recordings or finished artwork. Never claim to have listened to audio or completed a release without evidence. Preserve versions, review findings and open questions in the music workspace. Do not spend money, contact people, publish, upload, distribute, create external accounts, change credentials or make destructive changes without a specific human gate.
Autonomous missions run in the separate mission runtime. This chat remains available for conversation and existing tools.
Artist brief: ${JSON.stringify(ARTIST_BRIEF)}

${getSchedulePrompt({ date: new Date() })}

Use scheduleTask only when the user explicitly requests a future time, delay or recurring schedule. Writing or planning a song is not a scheduling request. If no time was requested, answer conversationally. If a tool fails, explain the failure in plain language; do not repeat the same call.
`,

      messages: pruneMessages({
        messages: await convertToModelMessages(this.messages),
        toolCalls: "before-last-2-messages",
        reasoning: "before-last-message"
      }),

      tools: {
        ...mcpTools,

        scheduleTask: tool({
          description: "Schedule a task to execute later.",

          inputSchema: scheduleSchema,

          execute: async ({ when, description }) => {
            if (when.type === "no-schedule") {
              return "Not a valid schedule input";
            }

            const input =
              when.type === "scheduled"
                ? when.date
                : when.type === "delayed"
                  ? when.delayInSeconds
                  : when.type === "cron"
                    ? when.cron
                    : null;

            if (!input) {
              return "Invalid schedule type";
            }

            try {
              await this.schedule(input, "executeTask", description, {
                idempotent: true
              });

              return `Task scheduled: "${description}"`;
            } catch (error) {
              return `Error scheduling task: ${error}`;
            }
          }
        }),

        getScheduledTasks: tool({
          description: "List all scheduled tasks.",

          inputSchema: jsonSchema<Record<string, never>>({
            type: "object",
            properties: {},
            required: [],
            additionalProperties: false
          }),

          execute: async () => {
            const tasks = this.getSchedules();

            return tasks.length > 0 ? tasks : "No scheduled tasks found.";
          }
        }),

        cancelScheduledTask: tool({
          description: "Cancel a scheduled task.",

          inputSchema: z.object({
            taskId: z.string()
          }),

          execute: async ({ taskId }) => {
            try {
              this.cancelSchedule(taskId);

              return `Task ${taskId} cancelled.`;
            } catch (error) {
              return `Error cancelling task: ${error}`;
            }
          }
        })
      },

      // Always reserve a final step for a conversational answer rather than
      // allowing repeated malformed tool calls to consume twenty model turns.
      prepareStep: ({ stepNumber }) =>
        stepNumber >= 1 ? { toolChoice: "none" as const } : {},
      stopWhen: stepCountIs(2),

      abortSignal: options?.abortSignal
    });

    return result.toUIMessageStreamResponse();
  }

  async executeTask(description: string, _task: Schedule<string>) {
    console.log(`Executing scheduled task: ${description}`);

    this.broadcast(
      JSON.stringify({
        type: "scheduled-task",
        description,
        timestamp: new Date().toISOString()
      })
    );
  }
}

export default {
  async fetch(request: Request, env: Env) {
    const pathname = new URL(request.url).pathname;
    if (pathname.startsWith("/admin/")) {
      const token = request.headers
        .get("authorization")
        ?.replace(/^Bearer /i, "");
      if (
        !(
          (request.method === "GET" &&
            [
              "/admin/autonomy",
              "/admin/music",
              "/admin/release-system",
              "/admin/bridge-health",
              "/admin/search-diagnostics"
            ].includes(pathname)) ||
          (request.method === "POST" &&
            [
              "/admin/retry-research",
              "/admin/review-lyrics",
              "/admin/suno/prepare",
              "/admin/suno/submit",
              "/admin/suno/retry-audit",
              "/admin/release/approve",
              "/admin/release/pause",
              "/admin/release/audio"
            ].includes(pathname)) ||
          (request.method === "POST" &&
            [
              "/admin/external-directive",
              "/admin/retry-external-directive"
            ].includes(pathname))
        ) ||
        !env.AUTONOMY_ADMIN_TOKEN ||
        token !== env.AUTONOMY_ADMIN_TOKEN
      ) {
        return new Response("Not found", { status: 404 });
      }
      if (pathname === "/admin/autonomy") {
        const stub = env.ChatAgent.get(env.ChatAgent.idFromName("default"));
        const status = await stub.getAutonomyStatus();
        return Response.json(status, {
          headers: { "cache-control": "no-store" }
        });
      }
      if (pathname === "/admin/music") {
        const stub = env.ChatAgent.get(env.ChatAgent.idFromName("default"));
        return Response.json(await stub.getMusicWorkspace(), {
          headers: { "cache-control": "no-store" }
        });
      }
      if (pathname === "/admin/release-system") {
        try {
          return Response.json(
            await releaseBridge(env, "/music/capabilities"),
            { headers: { "cache-control": "no-store" } }
          );
        } catch {
          return Response.json(
            {
              rendererReady: false,
              youtubeConfigured: false,
              spotifyConfigured: false,
              error: "BRIDGE_UNAVAILABLE"
            },
            { headers: { "cache-control": "no-store" } }
          );
        }
      }
      if (
        pathname === "/admin/release/approve" ||
        pathname === "/admin/release/pause"
      ) {
        try {
          const body = await request.text();
          if (body.length > 4000)
            return Response.json(
              { error: "PAYLOAD_TOO_LARGE" },
              { status: 413 }
            );
          const input: unknown = JSON.parse(body);
          const stub = env.ChatAgent.get(env.ChatAgent.idFromName("default"));
          if (pathname.endsWith("/approve"))
            return Response.json(await stub.approveMusicRelease(input));
          const parsed = z
            .object({ id: z.string().max(300), paused: z.boolean() })
            .parse(input);
          return Response.json(
            await stub.setReleasePaused(parsed.id, parsed.paused)
          );
        } catch {
          return Response.json(
            { error: "RELEASE_NOT_READY_OR_INPUT_INVALID" },
            { status: 400 }
          );
        }
      }
      if (pathname === "/admin/release/audio") {
        try {
          if (Number(request.headers.get("content-length") ?? 0) > 7_000_000)
            return Response.json(
              { error: "UPLOAD_TOO_LARGE" },
              { status: 413 }
            );
          const form = await request.formData();
          const file = form.get("audio");
          const id = z.string().min(1).max(250).parse(form.get("handoffId"));
          if (
            !(file instanceof File) ||
            file.size > 6_000_000 ||
            !file.name.toLowerCase().endsWith(".mp3")
          )
            throw new Error("INVALID_AUDIO");
          const stub = env.ChatAgent.get(env.ChatAgent.idFromName("default"));
          return Response.json(
            await stub.retainReleaseAudio(
              id,
              Buffer.from(await file.arrayBuffer()).toString("base64")
            )
          );
        } catch {
          return Response.json(
            { error: "ORIGINAL_AUDITED_MP3_REQUIRED_MAX_6MB" },
            { status: 400 }
          );
        }
      }
      if (pathname === "/admin/bridge-health") {
        if (!env.OPENCLAW_BASE_URL || !env.OPENCLAW_GATEWAY_TOKEN)
          return Response.json({ configured: false });
        const started = Date.now();
        try {
          const response = await fetch(`${env.OPENCLAW_BASE_URL}/v1/models`, {
            headers: {
              authorization: `Bearer ${env.OPENCLAW_GATEWAY_TOKEN}`
            },
            signal: AbortSignal.timeout(5000)
          });
          return Response.json({
            configured: true,
            reachable: response.ok,
            status: response.status,
            elapsedMs: Date.now() - started
          });
        } catch (error) {
          return Response.json({
            configured: true,
            reachable: false,
            error: error instanceof Error ? error.name : "UNKNOWN",
            elapsedMs: Date.now() - started
          });
        }
      }
      if (pathname === "/admin/retry-research") {
        const stub = env.ChatAgent.get(env.ChatAgent.idFromName("default"));
        const result = await stub.retryFailedResearchMission();
        return Response.json(result, {
          headers: { "cache-control": "no-store" }
        });
      }
      if (pathname === "/admin/review-lyrics") {
        const stub = env.ChatAgent.get(env.ChatAgent.idFromName("default"));
        return Response.json(await stub.queueLyricsReview(), {
          headers: { "cache-control": "no-store" }
        });
      }
      if (pathname === "/admin/suno/prepare") {
        const stub = env.ChatAgent.get(env.ChatAgent.idFromName("default"));
        return Response.json(await stub.queueSunoPreparation(), {
          headers: { "cache-control": "no-store" }
        });
      }
      if (pathname === "/admin/suno/retry-audit") {
        let handoffId: string;
        try {
          const body = await request.text();
          if (body.length > 500)
            return Response.json(
              { error: "PAYLOAD_TOO_LARGE" },
              { status: 413 }
            );
          handoffId = z
            .object({ handoffId: z.string().min(1).max(250) })
            .parse(JSON.parse(body)).handoffId;
        } catch {
          return Response.json({ error: "INVALID_HANDOFF" }, { status: 400 });
        }
        const stub = env.ChatAgent.get(env.ChatAgent.idFromName("default"));
        return Response.json(await stub.retrySunoAudit(handoffId), {
          headers: { "cache-control": "no-store" }
        });
      }
      if (pathname === "/admin/suno/submit") {
        const size = Number(request.headers.get("content-length") ?? 0);
        if (size > 10_000_000)
          return Response.json({ error: "UPLOAD_TOO_LARGE" }, { status: 413 });
        let submission: unknown;
        let retainedAudio: string | undefined;
        let transcriptionError = false;
        try {
          const form = await request.formData();
          const audio = form.get("audio");
          let audioEvidence: {
            filename: string;
            byteLength: number;
            sha256: string;
            transcript: string;
          } | null = null;
          if (audio instanceof File && audio.size > 0) {
            if (audio.size > 6_000_000 || !/\.mp3$/i.test(audio.name))
              return Response.json(
                { error: "MP3_REQUIRED_MAX_6MB" },
                { status: 400 }
              );
            const bytes = await audio.arrayBuffer();
            retainedAudio = Buffer.from(bytes).toString("base64");
            const digest = await crypto.subtle.digest("SHA-256", bytes);
            const sha256 = [...new Uint8Array(digest)]
              .map((value) => value.toString(16).padStart(2, "0"))
              .join("");
            let transcript = "";
            try {
              const result = await env.AI.run(
                "@cf/openai/whisper-large-v3-turbo",
                {
                  audio: Buffer.from(bytes).toString("base64"),
                  task: "transcribe",
                  language: "en"
                }
              );
              transcript = result.text?.slice(0, 12000) ?? "";
              if (!transcript.trim()) transcriptionError = true;
            } catch {
              transcriptionError = true;
            }
            audioEvidence = {
              filename: audio.name.slice(0, 160),
              byteLength: audio.size,
              sha256,
              transcript
            };
          }
          submission = sunoSubmissionSchema.parse({
            handoffId: form.get("handoffId"),
            sunoUrl: form.get("sunoUrl"),
            listeningNotes: form.get("listeningNotes"),
            rightsBasis: form.get("rightsBasis"),
            audioEvidence
          });
        } catch {
          return Response.json(
            { error: "INVALID_SUNO_RESULT" },
            { status: 400 }
          );
        }
        const stub = env.ChatAgent.get(env.ChatAgent.idFromName("default"));
        return Response.json(
          {
            ...(await stub.submitSunoResult(submission, retainedAudio)),
            transcriptionError
          },
          { headers: { "cache-control": "no-store" } }
        );
      }
      if (pathname === "/admin/external-directive") {
        let payload: unknown;
        try {
          const body = await request.text();
          if (body.length > 12000)
            return Response.json(
              { error: "PAYLOAD_TOO_LARGE" },
              { status: 413 }
            );
          payload = directiveSchema.parse(JSON.parse(body));
        } catch {
          return Response.json({ error: "INVALID_DIRECTIVE" }, { status: 400 });
        }
        const stub = env.ChatAgent.get(env.ChatAgent.idFromName("default"));
        return Response.json(await stub.queueExternalDirective(payload), {
          headers: { "cache-control": "no-store" }
        });
      }
      if (pathname === "/admin/retry-external-directive") {
        const stub = env.ChatAgent.get(env.ChatAgent.idFromName("default"));
        return Response.json(await stub.retryExternalDirective(), {
          headers: { "cache-control": "no-store" }
        });
      }
      if (pathname === "/admin/search-diagnostics") {
        const query =
          new URL(request.url).searchParams.get("q")?.slice(0, 160) ||
          "independent alternative soul music audience research";
        const targets = {
          ddg: `https://lite.duckduckgo.com/lite/?q=${encodeURIComponent(query)}`,
          brave: `https://search.brave.com/search?q=${encodeURIComponent(query)}`,
          bing: `https://www.bing.com/search?format=rss&q=${encodeURIComponent(query)}`,
          google: `https://www.google.com/search?q=${encodeURIComponent(query)}`
        };
        const results = await Promise.all(
          Object.entries(targets).map(async ([name, url]) => {
            try {
              const response = await fetch(url, {
                headers: { "user-agent": "Mozilla/5.0" },
                signal: AbortSignal.timeout(8000)
              });
              const body = (await response.text()).slice(0, 120000);
              return {
                name,
                status: response.status,
                bytes: body.length,
                ddgResults: (body.match(/result-link/g) ?? []).length,
                bingResults: (body.match(/<item>/g) ?? []).length,
                title: body
                  .match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1]
                  ?.slice(0, 120),
                links:
                  name === "brave"
                    ? [...body.matchAll(/<a[^>]+href=["']([^"']+)["'][^>]*>/gi)]
                        .map((match) => match[1])
                        .filter((link) => link.startsWith("http"))
                        .slice(0, 12)
                    : undefined,
                resultMarkers:
                  name === "brave"
                    ? (
                        body.match(
                          /result-header|result-title|snippet-content|data-type="web"/g
                        ) ?? []
                      ).length
                    : undefined
              };
            } catch (error) {
              return {
                name,
                failure: error instanceof Error ? error.name : "UNKNOWN"
              };
            }
          })
        );
        const parsedHits = await searchPublicWeb(query).catch(() => []);
        return Response.json(
          {
            targets: results,
            parsedHits: parsedHits.map((hit) => ({
              title: hit.title,
              sourceUrl: hit.sourceUrl
            }))
          },
          {
            headers: { "cache-control": "no-store" }
          }
        );
      }
      return new Response("Not found", { status: 404 });
    }
    return (
      (await routeAgentRequest(request, env)) ||
      new Response("Not found", {
        status: 404
      })
    );
  }
} satisfies ExportedHandler<Env>;
