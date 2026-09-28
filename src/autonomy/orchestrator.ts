import {
  directiveSchema,
  missionResultSchema,
  rootPlanSchema,
  strategistDecisionSchema,
  type Directive,
  type MissionResult,
  type RootPlan,
  type SpecialistResult
} from "./schemas";
import { z } from "zod";
import { ARTIST_BRIEF, MUSIC_PROGRAM_ID } from "../music/project";
import {
  parseModelJson,
  spawnSpecialist,
  type ModelRunner,
  type SpecialistDependencies
} from "./runtime";

export type AutonomyLimits = {
  maxSpecialistsPerMission: number;
  maxModelCallsPerSpecialist: number;
  maxToolCallsPerSpecialist: number;
  maxStrategistCallsPerDay: number;
  maxMissionsPerDay: number;
  reviewCooldownMinutes: number;
};

export const DEFAULT_LIMITS: AutonomyLimits = {
  maxSpecialistsPerMission: 3,
  maxModelCallsPerSpecialist: 1,
  maxToolCallsPerSpecialist: 4,
  maxStrategistCallsPerDay: 2,
  maxMissionsPerDay: 1,
  reviewCooldownMinutes: 60
};

const MAX_PLANNED_SPECIALISTS = 2;

function boundedText(value: unknown, maxLength: number): string {
  const text =
    typeof value === "string"
      ? value
      : value && typeof value === "object"
        ? JSON.stringify(value)
        : "";
  return text.slice(0, maxLength);
}

function boundedItems(value: unknown, maxItems: number, maxLength: number) {
  return Array.isArray(value)
    ? value.slice(0, maxItems).map((item) => boundedText(item, maxLength))
    : [];
}

export function parseRootPlan(text: string): RootPlan {
  const raw = parseModelJson(text, z.record(z.string(), z.unknown()));
  const specialistItems = Array.isArray(raw.specialists) ? raw.specialists : [];
  if (specialistItems.length > MAX_PLANNED_SPECIALISTS) {
    throw new Error("SPECIALIST_LIMIT_REACHED");
  }
  return rootPlanSchema.parse({
    approach: boundedText(raw.approach, 1000),
    specialists: specialistItems.map((item) => {
      if (!item || typeof item !== "object" || Array.isArray(item)) return item;
      const spec = item as Record<string, unknown>;
      const searchQuery = Array.isArray(spec.searchQuery)
        ? spec.searchQuery.find(
            (query) => typeof query === "string" && query.trim().length >= 3
          )
        : spec.searchQuery;
      return {
        ...spec,
        task: boundedText(spec.task, 1200),
        searchQuery:
          typeof searchQuery === "string" && searchQuery.trim().length >= 3
            ? boundedText(searchQuery, 160)
            : undefined,
        reasonForDelegation: boundedText(spec.reasonForDelegation, 500),
        expectedValueOfDelegation: boundedText(
          spec.expectedValueOfDelegation,
          500
        )
      };
    }),
    directFindings: Array.isArray(raw.directFindings)
      ? raw.directFindings.slice(0, 6).map((item) => boundedText(item, 600))
      : [],
    // Free-form policy reminders are not approval requests. Only typed gates
    // can block a mission or be presented to a human for action.
    humanGates: Array.isArray(raw.humanGates)
      ? raw.humanGates
          .filter(
            (item) => item && typeof item === "object" && !Array.isArray(item)
          )
          .slice(0, 4)
      : []
  });
}

export function compactStateSummary(input: {
  recentDirectives: Directive[];
  recentMissions: MissionResult[];
  pendingHumanGates: number;
  recentEvents: string[];
  musicArtifacts?: {
    kind: string;
    title: string;
    status: string;
    content: string;
  }[];
}): string {
  return JSON.stringify({
    programId: MUSIC_PROGRAM_ID,
    objective:
      "Develop an original English-language singer and a coherent catalog of excellent songs",
    artistBrief: ARTIST_BRIEF,
    currentStage:
      (input.musicArtifacts ?? []).length === 0
        ? "Establish the artist identity and draft the first song"
        : "Improve drafts through review, production planning and iteration",
    musicArtifacts: (input.musicArtifacts ?? []).slice(0, 8).map((item) => ({
      kind: item.kind,
      title: item.title,
      status: item.status,
      excerpt: item.content.slice(0, 900)
    })),
    recentDirectives: input.recentDirectives.slice(0, 3),
    recentMissions: input.recentMissions.slice(0, 3).map((mission) => ({
      status: mission.status,
      summary: mission.summary,
      evidence: mission.evidence.slice(0, 5),
      unknowns: mission.unknowns,
      recommendation: mission.decisionRecommendation,
      artifacts: mission.agentRuns.flatMap((run) => run.artifacts).length
    })),
    pendingHumanGates: input.pendingHumanGates,
    recentEvents: input.recentEvents.slice(0, 8)
  }).slice(0, 18000);
}

export async function runStrategistReview(
  stateSummary: string,
  runModel: ModelRunner,
  now = new Date()
): Promise<{
  directive: Directive;
  route: Awaited<ReturnType<ModelRunner>>["route"];
}> {
  const reply = await runModel(
    "STRATEGIST",
    `You are the strategic director of an original English-language singer project. Decide WHAT small creative step matters next and WHY; ROOT handles execution. The artistic direction is alternative soul with a rough-edged, powerful emotional female voice, concrete and sometimes sharp lyrics, and hip-hop/trap rhythm. Build a coherent artist identity and song catalog through this sequence: identity and song brief -> original song/lyrics/topline draft -> production and vocal direction -> independent artistic review -> release proposal -> audience feedback. Begin with identity and a first song draft if no music artifacts exist. Prefer a concrete artifact and quality criterion over activity. External music market research is optional; do not mistake web snippets for verified facts. Treat named artists only as high-level references, never as voices, melodies or lyrics to copy. A valid choice is WAIT when a decision truly requires input. No spending, distribution, external contact, publication, account creation or secret changes. Return ONLY JSON: {"decision":"NEW_MISSION|CONTINUE|ITERATE|SCALE|KILL|WAIT","objective":"...","reason":"...","successCriteria":[],"constraints":[],"priority":0,"maxBudgetUsd":0,"timeLimitMinutes":20,"requiredEvidence":[],"deliverable":"..."}. For WAIT set objective and deliverable to empty strings. Set maxBudgetUsd to 0 unless a cost is specifically justified, and keep the mission small.\nSTATE: ${stateSummary}`
  );
  const raw = parseModelJson(reply.text, z.record(z.string(), z.unknown()));
  const decision = strategistDecisionSchema.parse({
    ...raw,
    objective: boundedText(raw.objective, 1200),
    reason: boundedText(raw.reason, 1200),
    successCriteria: boundedItems(raw.successCriteria, 6, 300),
    constraints: boundedItems(raw.constraints, 12, 300),
    priority: Math.max(0, Math.min(5, Math.round(Number(raw.priority ?? 0)))),
    maxBudgetUsd: Math.max(0, Math.min(5, Number(raw.maxBudgetUsd ?? 0))),
    timeLimitMinutes: Math.max(
      1,
      Math.min(30, Math.round(Number(raw.timeLimitMinutes ?? 20)))
    ),
    requiredEvidence: boundedItems(raw.requiredEvidence, 8, 300),
    deliverable: boundedText(raw.deliverable, 500)
  });
  return {
    directive: directiveSchema.parse({
      ...decision,
      directiveId: crypto.randomUUID(),
      programId: MUSIC_PROGRAM_ID,
      createdAt: now.toISOString()
    }),
    route: reply.route
  };
}

export async function runRootMission(
  directive: Directive,
  deps: SpecialistDependencies,
  limits: AutonomyLimits = DEFAULT_LIMITS,
  onTransition?: (event: string, payload: object) => void
): Promise<MissionResult> {
  const validDirective = directiveSchema.parse(directive);
  const missionId = crypto.randomUUID();
  const started = Date.now();
  let rootRoute: Awaited<ReturnType<ModelRunner>>["route"] | null = null;
  const rootRoutes: Awaited<ReturnType<ModelRunner>>["route"][] = [];
  let modelCalls = 0;
  const providerFailures: string[] = [];
  try {
    modelCalls++;
    const planReply = await deps.runModel(
      "ROOT",
      `You are ROOT, the production coordinator for an original English-language singer. Turn the STRATEGIST directive into a small, reviewable creative mission. You have no direct audio-generation, listening, image-generation or web tools. Plan at most ${MAX_PLANNED_SPECIALISTS} temporary specialists from SONGWRITER, PRODUCER, VOCAL_DIRECTOR, A_AND_R, ART_DIRECTOR, RELEASE_PLANNER, RESEARCHER and AUDITOR. A LYRICS_EXPERT is automatically added after every SONGWRITER draft, so do not plan that role yourself. Assign at least one creative specialist when a draft is needed. Creative specialists make text drafts with no external tools; only RESEARCHER may use webSearch and readPage when public evidence is genuinely needed. A song draft needs an emotional statement, a distinctive original line, and a chorus that works with only piano or guitar. Do not claim a text draft is a finished recording. Do not imitate or clone a real artist. Never spend, contact, publish, upload, distribute, create accounts, destroy or change secrets; put an external action in a humanGate only when it is required for this current mission. Future registration, recording and publication are later stages, not gates for a text draft. A provisional artist name does not block drafting. Return ONLY one compact JSON object, under 500 words, with: approach (string), specialists (array; each has role, task, optional searchQuery as one string, reasonForDelegation, expectedValueOfDelegation, allowedTools), directFindings (empty unless verified), humanGates (array with proposedAction, reason, expectedBenefit, risk, exactApprovalNeeded). No prose before or after JSON.\nARTIST BRIEF: ${JSON.stringify(ARTIST_BRIEF)}\nDIRECTIVE: ${JSON.stringify(validDirective)}`
    );
    rootRoute = planReply.route;
    rootRoutes.push(planReply.route);
    let plan: RootPlan;
    try {
      plan = parseRootPlan(planReply.text);
    } catch (error) {
      if (
        error instanceof Error &&
        error.message === "SPECIALIST_LIMIT_REACHED"
      )
        throw error;
      modelCalls++;
      const repair = await deps.runModel(
        "ROOT",
        `Return ONLY valid compact JSON under 400 words for this original singer project. ROOT has no direct audio, image or web tools. Delegate drafts to SONGWRITER, PRODUCER, VOCAL_DIRECTOR, A_AND_R, ART_DIRECTOR or RELEASE_PLANNER with allowedTools []; RESEARCHER alone may use ["webSearch","readPage"] if public evidence is needed. LYRICS_EXPERT is added automatically after SONGWRITER; do not include it. Keys: approach:string, specialists:array of at most ${MAX_PLANNED_SPECIALISTS} objects with role,task,optional searchQuery (one string),reasonForDelegation,expectedValueOfDelegation,allowedTools; directFindings:array of strings; humanGates:array of objects with proposedAction,reason,expectedBenefit,risk,exactApprovalNeeded. No markdown or explanation. Directive: ${JSON.stringify(validDirective)}`
      );
      rootRoute = repair.route;
      rootRoutes.push(repair.route);
      plan = parseRootPlan(repair.text);
    }
    if (plan.specialists.length > MAX_PLANNED_SPECIALISTS) {
      throw new Error("SPECIALIST_LIMIT_REACHED");
    }
    const planned = plan.specialists.filter(
      (item) => item.role !== "LYRICS_EXPERT"
    );
    if (planned.length !== plan.specialists.length)
      throw new Error("LYRICS_EXPERT_IS_AUTOMATIC");
    const assignments: RootPlan["specialists"] = planned.some(
      (item) => item.role === "SONGWRITER"
    )
      ? [
          ...planned,
          {
            role: "LYRICS_EXPERT",
            task: "Review the songwriter's complete English lyrics line by line and deliver a candid lyric review plus a complete revised song draft.",
            reasonForDelegation:
              "Every new song needs an independent lyric craft review.",
            expectedValueOfDelegation:
              "Specific edits and a stronger, singable second draft.",
            allowedTools: []
          }
        ]
      : planned;
    if (assignments.length > limits.maxSpecialistsPerMission)
      throw new Error("SPECIALIST_LIMIT_REACHED");
    const specs = assignments.map((item) => ({
      agentId: crypto.randomUUID(),
      role: item.role,
      objective: validDirective.objective.slice(0, 800),
      task: item.task,
      searchQuery: item.searchQuery,
      context: JSON.stringify({
        directive: validDirective,
        approach: plan.approach,
        artistBrief: ARTIST_BRIEF
      }).slice(0, 3000),
      allowedTools: item.allowedTools,
      maxModelCalls: limits.maxModelCallsPerSpecialist,
      maxToolCalls: limits.maxToolCallsPerSpecialist,
      timeoutMs: Math.min(validDirective.timeLimitMinutes * 60000, 120000),
      maxBudgetUsd: Math.min(validDirective.maxBudgetUsd, 2),
      parentMissionId: missionId,
      delegationDepth: 2 as const,
      reasonForDelegation: item.reasonForDelegation,
      expectedValueOfDelegation: item.expectedValueOfDelegation
    }));
    for (const spec of specs)
      onTransition?.("AGENT_SPAWNED", {
        missionId,
        role: spec.role,
        reason: spec.reasonForDelegation
      });
    const settled: PromiseSettledResult<SpecialistResult>[] = [];
    for (const spec of specs) {
      const priorResults = settled
        .filter(
          (item): item is PromiseFulfilledResult<SpecialistResult> =>
            item.status === "fulfilled"
        )
        .map((item) => item.value);
      const priorArtifacts = (
        spec.role === "LYRICS_EXPERT"
          ? priorResults.filter((item) => item.role === "SONGWRITER")
          : priorResults
      )
        .flatMap((item) => item.artifacts)
        .slice(0, 2)
        .map((artifact) => artifact.slice(0, 8000));
      const context = priorArtifacts.length
        ? JSON.stringify({
            priorArtifacts,
            objective: validDirective.objective,
            artistBrief: ARTIST_BRIEF
          }).slice(0, 11000)
        : spec.context;
      const [outcome] = await Promise.allSettled([
        spec.role === "LYRICS_EXPERT" && priorArtifacts.length === 0
          ? Promise.reject(new Error("SONG_DRAFT_MISSING"))
          : spawnSpecialist({ ...spec, context }, deps)
      ]);
      settled.push(outcome);
    }
    const specialists: SpecialistResult[] = settled.map((outcome, index) => {
      if (outcome.status === "fulfilled") return outcome.value;
      providerFailures.push("SPECIALIST_EXECUTION_FAILED");
      const failureType =
        outcome.reason instanceof z.ZodError
          ? `INVALID_SPEC:${outcome.reason.issues.map((issue) => issue.path.join(".")).join(",")}`
          : "EXECUTION_ERROR";
      return {
        agentId: specs[index].agentId,
        role: specs[index].role,
        missionId,
        task: specs[index].task,
        status: "FAILED",
        summary: "Specialist failed unexpectedly",
        observedEvidence: [],
        inferences: [],
        contradictingEvidence: [],
        assumptions: [],
        unknowns: ["Task remains unresolved"],
        artifacts: [],
        recommendedNextAction: "Retry later",
        limitations: [failureType],
        route: {
          requestedModel: "UNKNOWN",
          actualModel: "UNKNOWN",
          provider: "UNKNOWN",
          route: "UNKNOWN",
          fallbackUsed: false,
          fallbackReason: null
        },
        modelCalls: 0,
        toolCalls: 0,
        approximateCostUsd: null
      };
    });
    if (specialists.some((result) => result.status === "FAILED"))
      providerFailures.push("SPECIALIST_FAILED");
    specialists.forEach((result) =>
      onTransition?.(
        result.status === "FAILED" ? "AGENT_FAILED" : "AGENT_COMPLETED",
        { missionId, role: result.role, status: result.status }
      )
    );
    const evidence = specialists.flatMap((result) => result.observedEvidence);
    const artifacts = specialists.flatMap((result) => result.artifacts);
    const unknowns = specialists.flatMap((result) => result.unknowns);
    // These missions produce text drafts only. Proposed later-stage approvals
    // must not block or reclassify a successfully completed draft.
    const humanGates =
      validDirective.programId === MUSIC_PROGRAM_ID &&
      validDirective.requiredEvidence.length === 0
        ? []
        : plan.humanGates;
    const status =
      humanGates.length > 0
        ? "HUMAN_GATE_REQUIRED"
        : (validDirective.programId === MUSIC_PROGRAM_ID &&
              validDirective.requiredEvidence.length === 0 &&
              artifacts.length === 0) ||
            (evidence.length === 0 &&
              validDirective.requiredEvidence.length > 0) ||
            specialists.some(
              (result) =>
                result.status === "FAILED" || result.status === "PARTIAL"
            )
          ? "PARTIAL"
          : "COMPLETED";
    return missionResultSchema.parse({
      missionId,
      directiveId: validDirective.directiveId,
      status,
      decisionRecommendation: "UNKNOWN",
      summary:
        `${plan.approach} ${specialists.map((result) => result.summary).join(" ")}`.slice(
          0,
          3000
        ),
      evidence,
      contradictingEvidence: specialists.flatMap(
        (result) => result.contradictingEvidence
      ),
      assumptions: specialists.flatMap((result) => result.assumptions),
      unknowns,
      specialistsUsed: specialists.map((result) => result.role),
      agentRuns: specialists,
      modelCalls:
        modelCalls +
        specialists.reduce((sum, result) => sum + result.modelCalls, 0),
      toolCalls: specialists.reduce((sum, result) => sum + result.toolCalls, 0),
      actualCostUsd: null,
      elapsedMs: Date.now() - started,
      providerFailures,
      humanGates,
      recommendedNextAction: specialists
        .map((result) => result.recommendedNextAction)
        .join("; "),
      routes: [...rootRoutes, ...specialists.map((result) => result.route)]
    });
  } catch (error) {
    const failureType =
      error instanceof z.ZodError
        ? `ROOT_PLAN_SCHEMA:${error.issues.map((issue) => issue.path.join(".")).join(",")}`
        : error instanceof SyntaxError
          ? "ROOT_PLAN_INVALID_JSON"
          : error instanceof Error && error.message === "MODEL_REQUEST_FAILED"
            ? "ROOT_MODEL_REQUEST_FAILED"
            : "ROOT_PLAN_FAILED";
    providerFailures.push(failureType);
    return missionResultSchema.parse({
      missionId,
      directiveId: validDirective.directiveId,
      status: "FAILED",
      decisionRecommendation: "UNKNOWN",
      summary: "ROOT could not complete mission planning",
      evidence: [],
      contradictingEvidence: [],
      assumptions: [],
      unknowns: ["Mission could not be planned"],
      specialistsUsed: [],
      agentRuns: [],
      modelCalls,
      toolCalls: 0,
      actualCostUsd: null,
      elapsedMs: Date.now() - started,
      providerFailures,
      humanGates: [],
      recommendedNextAction: "Review model availability and retry later",
      routes: rootRoutes.length > 0 ? rootRoutes : rootRoute ? [rootRoute] : []
    });
  }
}
