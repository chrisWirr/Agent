import { z } from "zod";

export const decisionSchema = z.enum([
  "NEW_MISSION",
  "CONTINUE",
  "ITERATE",
  "SCALE",
  "KILL",
  "WAIT"
]);

export const directiveSchema = z.object({
  directiveId: z.string().min(1),
  decision: decisionSchema,
  objective: z.string().max(1200),
  reason: z.string().max(1200),
  successCriteria: z.array(z.string().max(300)).max(6),
  constraints: z.array(z.string().max(300)).max(12),
  priority: z.number().int().min(0).max(5),
  maxBudgetUsd: z.number().min(0).max(5),
  timeLimitMinutes: z.number().int().min(1).max(30),
  requiredEvidence: z.array(z.string().max(300)).max(8),
  deliverable: z.string().max(500),
  createdAt: z.string().datetime()
});
export type Directive = z.infer<typeof directiveSchema>;

export const evidenceSchema = z.object({
  sourceUrl: z.string().url(),
  title: z.string().max(300),
  observation: z.string().max(1600),
  retrievedAt: z.string().datetime()
});
export type Evidence = z.infer<typeof evidenceSchema>;

export const routeSchema = z.object({
  requestedModel: z.string(),
  actualModel: z.string(),
  provider: z.string(),
  route: z.string(),
  fallbackUsed: z.boolean(),
  fallbackReason: z.string().nullable()
});
export type Route = z.infer<typeof routeSchema>;

export const specialistStatusSchema = z.enum([
  "COMPLETED",
  "PARTIAL",
  "FAILED",
  "HUMAN_GATE_REQUIRED"
]);

export const specialistResultSchema = z.object({
  agentId: z.string(),
  role: z.string(),
  missionId: z.string(),
  task: z.string(),
  status: specialistStatusSchema,
  summary: z.string(),
  observedEvidence: z.array(evidenceSchema),
  inferences: z.array(z.string()),
  contradictingEvidence: z.array(evidenceSchema),
  assumptions: z.array(z.string()),
  unknowns: z.array(z.string()),
  artifacts: z.array(z.string()),
  recommendedNextAction: z.string(),
  limitations: z.array(z.string()),
  route: routeSchema,
  modelCalls: z.number().int().nonnegative(),
  toolCalls: z.number().int().nonnegative(),
  approximateCostUsd: z.number().nonnegative().nullable()
});
export type SpecialistResult = z.infer<typeof specialistResultSchema>;

export const humanGateSchema = z.object({
  proposedAction: z.string(),
  reason: z.string(),
  expectedBenefit: z.string(),
  risk: z.string(),
  exactApprovalNeeded: z.string()
});

export const missionResultSchema = z.object({
  missionId: z.string(),
  directiveId: z.string(),
  status: specialistStatusSchema,
  decisionRecommendation: z.enum([
    "KILL",
    "CONTINUE",
    "ITERATE",
    "SCALE",
    "UNKNOWN"
  ]),
  summary: z.string(),
  evidence: z.array(evidenceSchema),
  contradictingEvidence: z.array(evidenceSchema),
  assumptions: z.array(z.string()),
  unknowns: z.array(z.string()),
  specialistsUsed: z.array(z.string()),
  agentRuns: z.array(specialistResultSchema),
  modelCalls: z.number().int().nonnegative(),
  toolCalls: z.number().int().nonnegative(),
  actualCostUsd: z.number().nonnegative().nullable(),
  elapsedMs: z.number().nonnegative(),
  providerFailures: z.array(z.string()),
  humanGates: z.array(humanGateSchema),
  recommendedNextAction: z.string(),
  routes: z.array(routeSchema)
});
export type MissionResult = z.infer<typeof missionResultSchema>;

export const specialistSpecSchema = z.object({
  agentId: z.string().min(1).max(80),
  role: z.string().regex(/^[A-Z][A-Z0-9_]{1,39}$/),
  objective: z.string().min(1).max(800),
  task: z.string().min(1).max(1200),
  searchQuery: z.string().min(3).max(160).optional(),
  context: z.string().max(3000),
  allowedTools: z.array(z.enum(["webSearch", "readPage"])).max(2),
  preferredModel: z.string().max(120).optional(),
  maxModelCalls: z.number().int().min(1).max(2),
  maxToolCalls: z.number().int().min(0).max(4),
  timeoutMs: z.number().int().min(1000).max(120000),
  maxBudgetUsd: z.number().min(0).max(2),
  parentMissionId: z.string().min(1),
  delegationDepth: z.literal(2),
  reasonForDelegation: z.string().min(1).max(500),
  expectedValueOfDelegation: z.string().min(1).max(500)
});
export type SpecialistSpec = z.infer<typeof specialistSpecSchema>;

export const rootPlanSchema = z.object({
  approach: z.string().max(1000),
  specialists: z
    .array(
      z.object({
        role: specialistSpecSchema.shape.role,
        task: z.string().min(1).max(1200),
        searchQuery: z.string().min(3).max(160).optional(),
        reasonForDelegation: z.string().min(1).max(500),
        expectedValueOfDelegation: z.string().min(1).max(500),
        allowedTools: specialistSpecSchema.shape.allowedTools
      })
    )
    .max(2),
  directFindings: z.array(z.string().max(600)).max(6),
  humanGates: z.array(humanGateSchema).max(4)
});
export type RootPlan = z.infer<typeof rootPlanSchema>;

export const strategistDecisionSchema = z.object({
  decision: decisionSchema,
  objective: z.string().max(1200),
  reason: z.string().max(1200),
  successCriteria: z.array(z.string().max(300)).max(6),
  constraints: z.array(z.string().max(300)).max(12),
  priority: z.number().int().min(0).max(5),
  maxBudgetUsd: z.number().min(0).max(5),
  timeLimitMinutes: z.number().int().min(1).max(30),
  requiredEvidence: z.array(z.string().max(300)).max(8),
  deliverable: z.string().max(500)
});
