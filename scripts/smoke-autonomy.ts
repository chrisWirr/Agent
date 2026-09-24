import { readFileSync } from "node:fs";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { generateText } from "ai";
import {
  compactStateSummary,
  runRootMission,
  runStrategistReview
} from "../src/autonomy/orchestrator";
import type { ModelRunner } from "../src/autonomy/runtime";
import { directiveSchema } from "../src/autonomy/schemas";

const token =
  process.env.OPENCLAW_GATEWAY_TOKEN ||
  (process.env.OPENCLAW_GATEWAY_TOKEN_FILE
    ? readFileSync(process.env.OPENCLAW_GATEWAY_TOKEN_FILE, "utf8").trim()
    : undefined);
if (!token)
  throw new Error("Set OPENCLAW_GATEWAY_TOKEN or OPENCLAW_GATEWAY_TOKEN_FILE");
const baseURL = process.env.OPENCLAW_BASE_URL || "http://127.0.0.1:18789";
const provider = createOpenAICompatible({
  name: "openclaw",
  baseURL: `${baseURL.replace(/\/$/, "")}/v1`,
  apiKey: token
});
const runModel: ModelRunner = async (_role, prompt, signal) => {
  const response = await generateText({
    model: provider("openclaw/default"),
    prompt,
    maxOutputTokens: 1500,
    maxRetries: 0,
    abortSignal: signal
  });
  return {
    text: response.text,
    route: {
      requestedModel: "openclaw/default",
      actualModel: "UNKNOWN",
      provider: "openclaw",
      route: "linux-openclaw-bridge",
      fallbackUsed: false,
      fallbackReason: null
    }
  };
};

const summary = compactStateSummary({
  recentDirectives: [],
  recentMissions: [],
  pendingHumanGates: 0,
  recentEvents: [
    "NO_VALIDATED_OPPORTUNITY",
    "NO_REVENUE",
    "WEB_EVIDENCE_MISSING"
  ],
  openOpportunities: [
    "German HVAC subsidy and tender monitoring",
    "German B2B regulatory change alerts",
    "German small business automation services"
  ]
});
const { directive } = await runStrategistReview(summary, runModel);
console.log(
  JSON.stringify({
    decision: directive.decision,
    objective: directive.objective
  })
);
const useFixture =
  directive.decision === "WAIT" || directive.decision === "KILL";
const missionDirective = useFixture
  ? directiveSchema.parse({
      directiveId: crypto.randomUUID(),
      createdAt: new Date().toISOString(),
      decision: "NEW_MISSION",
      objective:
        "Compare public evidence of demand and willingness to pay for German small-business regulatory change alerts and HVAC subsidy monitoring.",
      reason: "Safe test fixture; no opportunity has been validated",
      successCriteria: [
        "Find public demand signals",
        "Find competitors or public pricing"
      ],
      constraints: ["No contact", "No spending", "No publication"],
      priority: 2,
      maxBudgetUsd: 1,
      timeLimitMinutes: 20,
      requiredEvidence: ["Public URLs supporting or contradicting demand"],
      deliverable: "Evidence-based comparison and unknowns"
    })
  : directive;
const result = await runRootMission(missionDirective, { runModel });
console.log(
  JSON.stringify({
    missionFixtureUsed: useFixture,
    status: result.status,
    specialistsUsed: result.specialistsUsed,
    evidenceCount: result.evidence.length,
    sources: result.evidence.map((item) => item.sourceUrl).slice(0, 6),
    modelCalls: result.modelCalls,
    toolCalls: result.toolCalls,
    actualCostUsd: result.actualCostUsd,
    providerFailures: result.providerFailures
  })
);
