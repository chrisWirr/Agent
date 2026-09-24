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
  maxSpecialistsPerMission: 2,
  maxModelCallsPerSpecialist: 1,
  maxToolCallsPerSpecialist: 3,
  maxStrategistCallsPerDay: 2,
  maxMissionsPerDay: 1,
  reviewCooldownMinutes: 60
};

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
  if (specialistItems.length > DEFAULT_LIMITS.maxSpecialistsPerMission) {
    throw new Error("SPECIALIST_LIMIT_REACHED");
  }
  return rootPlanSchema.parse({
    approach: boundedText(raw.approach, 1000),
    specialists: specialistItems.map((item) => {
      if (!item || typeof item !== "object" || Array.isArray(item)) return item;
      const spec = item as Record<string, unknown>;
      return {
        ...spec,
        task: boundedText(spec.task, 1200),
        searchQuery:
          typeof spec.searchQuery === "string" &&
          spec.searchQuery.trim().length >= 3
            ? boundedText(spec.searchQuery, 160)
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
  openOpportunities?: string[];
}): string {
  return JSON.stringify({
    objective: "Find lawful opportunities for sustainable realized net profit",
    realizedRevenueUsd: null,
    actualCostUsd: null,
    openOpportunities: (input.openOpportunities ?? []).slice(0, 6),
    recentDirectives: input.recentDirectives.slice(0, 3),
    recentMissions: input.recentMissions.slice(0, 3).map((mission) => ({
      status: mission.status,
      summary: mission.summary,
      evidence: mission.evidence.slice(0, 5),
      unknowns: mission.unknowns,
      recommendation: mission.decisionRecommendation,
      actualCostUsd: mission.actualCostUsd
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
    `You are STRATEGIST. Decide WHAT deserves attention and WHY. Do no operational work. A valid choice is WAIT. Seek external economic evidence, question assumptions, and avoid creating busywork. If no opportunity is validated and public evidence is missing, consider a small comparative research mission; WAIT only when a new review cannot improve the decision. Never prescribe the conclusion. No spending, external contact, publication, account creation, or secret changes. Return ONLY JSON: {"decision":"NEW_MISSION|CONTINUE|ITERATE|SCALE|KILL|WAIT","objective":"...","reason":"...","successCriteria":[],"constraints":[],"priority":0,"maxBudgetUsd":0,"timeLimitMinutes":20,"requiredEvidence":[],"deliverable":"..."}. For WAIT set objective and deliverable to empty strings. Monetary costs may be unknown; keep the mission small.\nSTATE: ${stateSummary}`
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
      `You are ROOT. Choose HOW to execute this STRATEGIST directive. Delegate only if valuable. At most ${limits.maxSpecialistsPerMission} temporary specialists. RESEARCHER may use webSearch and readPage; other roles have no external tools in V1. Never spend, contact, publish, create accounts, destroy, or change secrets; put a specific needed action in humanGates. Return ONLY one concise JSON object with: approach (string, max 500 chars), specialists (array; each has role, task max 500 chars, searchQuery (3-8 relevant search terms), reasonForDelegation, expectedValueOfDelegation, allowedTools), directFindings (array of strings; empty if no verified facts), humanGates (array of objects with proposedAction, reason, expectedBenefit, risk, exactApprovalNeeded; empty if none). No prose before or after JSON.\nDIRECTIVE: ${JSON.stringify(validDirective)}`
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
        `Return ONLY valid compact JSON for this directive. Keys: approach:string, specialists:array of at most ${limits.maxSpecialistsPerMission} objects with role,task,searchQuery,reasonForDelegation,expectedValueOfDelegation,allowedTools; directFindings:array of strings; humanGates:array of objects with proposedAction,reason,expectedBenefit,risk,exactApprovalNeeded. Use empty arrays when none. Keep every string short. No markdown or explanation. Directive: ${JSON.stringify(validDirective)}`
      );
      rootRoute = repair.route;
      rootRoutes.push(repair.route);
      plan = parseRootPlan(repair.text);
    }
    if (plan.specialists.length > limits.maxSpecialistsPerMission) {
      throw new Error("SPECIALIST_LIMIT_REACHED");
    }
    const specs = plan.specialists.map((item) => ({
      agentId: crypto.randomUUID(),
      role: item.role,
      objective: validDirective.objective.slice(0, 800),
      task: item.task,
      searchQuery: item.searchQuery,
      context: JSON.stringify({
        directive: validDirective,
        approach: plan.approach
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
    const settled = await Promise.allSettled(
      specs.map((spec) => spawnSpecialist(spec, deps))
    );
    const specialists: SpecialistResult[] = settled.map((outcome, index) => {
      if (outcome.status === "fulfilled") return outcome.value;
      providerFailures.push("SPECIALIST_EXECUTION_FAILED");
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
        limitations: ["Execution failed"],
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
    const unknowns = specialists.flatMap((result) => result.unknowns);
    const status =
      plan.humanGates.length > 0
        ? "HUMAN_GATE_REQUIRED"
        : (evidence.length === 0 &&
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
      humanGates: plan.humanGates,
      recommendedNextAction: specialists
        .map((result) => result.recommendedNextAction)
        .join("; "),
      routes: [...rootRoutes, ...specialists.map((result) => result.route)]
    });
  } catch {
    providerFailures.push("ROOT_PLAN_FAILED");
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
