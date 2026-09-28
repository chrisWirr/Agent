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
import { MUSIC_PROGRAM_ID } from "../src/music/project";

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
    model: provider("openclaw/main"),
    prompt,
    maxOutputTokens: 1500,
    maxRetries: 0,
    abortSignal: signal
  });
  return {
    text: response.text,
    route: {
      requestedModel: "openclaw/main",
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
  recentEvents: [],
  musicArtifacts: []
});
const strategistResult =
  process.env.SMOKE_USE_FIXTURE === "1"
    ? null
    : await runStrategistReview(summary, runModel);
const directive = strategistResult?.directive;
if (directive)
  console.log(
    JSON.stringify({
      decision: directive.decision,
      objective: directive.objective
    })
  );
const useFixture =
  !directive || directive.decision === "WAIT" || directive.decision === "KILL";
const missionDirective = useFixture
  ? directiveSchema.parse({
      directiveId: crypto.randomUUID(),
      programId: MUSIC_PROGRAM_ID,
      createdAt: new Date().toISOString(),
      decision: "NEW_MISSION",
      objective: "Draft the singer's first original song concept and chorus.",
      reason: "Safe text-only fixture for the music project",
      successCriteria: ["Original lyric draft", "Chorus works with piano"],
      constraints: ["No imitation", "No spending", "No publication"],
      priority: 2,
      maxBudgetUsd: 0,
      timeLimitMinutes: 20,
      requiredEvidence: [],
      deliverable: "Text-only lyric and topline draft"
    })
  : directive;
const result = await runRootMission(missionDirective, { runModel });
console.log(
  JSON.stringify({
    missionFixtureUsed: useFixture,
    status: result.status,
    specialistsUsed: result.specialistsUsed,
    evidenceCount: result.evidence.length,
    draftCount: result.agentRuns.flatMap((run) => run.artifacts).length,
    specialists: result.agentRuns.map((run) => ({
      role: run.role,
      status: run.status,
      limitations: run.limitations
    })),
    humanGates: result.humanGates.map((gate) => gate.proposedAction),
    sources: result.evidence.map((item) => item.sourceUrl).slice(0, 6),
    modelCalls: result.modelCalls,
    toolCalls: result.toolCalls,
    actualCostUsd: result.actualCostUsd,
    providerFailures: result.providerFailures
  })
);
