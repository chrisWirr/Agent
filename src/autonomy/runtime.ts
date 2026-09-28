import { z } from "zod";
import { readPublicPage, searchPublicWeb, type SearchHit } from "./research";
import {
  specialistResultSchema,
  specialistSpecSchema,
  type Route,
  type SpecialistResult,
  type SpecialistSpec
} from "./schemas";

export type ModelReply = { text: string; route: Route };
export type ModelRunner = (
  role: "STRATEGIST" | "ROOT" | "SPECIALIST" | "AUDITOR",
  prompt: string,
  signal?: AbortSignal
) => Promise<ModelReply>;

export function parseModelJson<T>(text: string, schema: z.ZodType<T>): T {
  const trimmed = text
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/, "");
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start < 0 || end < start)
    throw new Error("Model did not return a JSON object");
  return schema.parse(JSON.parse(trimmed.slice(start, end + 1)));
}

const specialistAnalysisSchema = z.object({
  summary: z.string().max(1200),
  inferences: z.array(z.string().max(500)).max(6),
  assumptions: z.array(z.string().max(500)).max(6),
  unknowns: z.array(z.string().max(500)).max(6),
  recommendedNextAction: z.string().max(600),
  limitations: z.array(z.string().max(500)).max(6)
});

function boundedText(value: unknown, maxLength: number): string {
  return typeof value === "string" ? value.slice(0, maxLength) : "";
}

function boundedList(
  value: unknown,
  maxItems: number,
  maxLength: number
): string[] {
  return Array.isArray(value)
    ? value
        .slice(0, maxItems)
        .map((item) => boundedText(item, maxLength))
        .filter(Boolean)
    : typeof value === "string"
      ? [value.slice(0, maxLength)]
      : [];
}

function parseSpecialistAnalysis(text: string) {
  const raw = parseModelJson(text, z.record(z.string(), z.unknown()));
  return specialistAnalysisSchema.parse({
    summary: boundedText(raw.summary, 1200),
    inferences: boundedList(raw.inferences, 6, 500),
    assumptions: boundedList(raw.assumptions, 6, 500),
    unknowns: boundedList(raw.unknowns, 6, 500),
    recommendedNextAction: boundedText(raw.recommendedNextAction, 600),
    limitations: boundedList(raw.limitations, 6, 500)
  });
}

export type SpecialistDependencies = {
  runModel: ModelRunner;
  search?: (query: string) => Promise<SearchHit[]>;
  readPage?: (url: string) => Promise<SearchHit | null>;
};

const UNKNOWN_ROUTE: Route = {
  requestedModel: "UNKNOWN",
  actualModel: "UNKNOWN",
  provider: "UNKNOWN",
  route: "UNKNOWN",
  fallbackUsed: false,
  fallbackReason: null
};

export async function spawnSpecialist(
  input: SpecialistSpec,
  deps: SpecialistDependencies
): Promise<SpecialistResult> {
  const spec = specialistSpecSchema.parse(input);
  if (spec.delegationDepth !== 2) throw new Error("Delegation depth exceeded");
  if (spec.role !== "RESEARCHER" && spec.allowedTools.length > 0) {
    throw new Error("This role has no approved external tools");
  }
  if (spec.role === "RESEARCHER" && !spec.allowedTools.includes("webSearch")) {
    throw new Error("RESEARCHER requires webSearch");
  }
  if (spec.allowedTools.length > 0 && spec.maxToolCalls === 0) {
    throw new Error("Tool budget is zero");
  }

  let modelCalls = 0;
  let toolCalls = 0;
  let route = UNKNOWN_ROUTE;
  const observedEvidence: SearchHit[] = [];
  let searchLeads: SearchHit[] = [];
  const limitations: string[] = [];

  try {
    if (spec.allowedTools.includes("webSearch")) {
      toolCalls++;
      searchLeads = await (deps.search ?? searchPublicWeb)(
        spec.searchQuery ?? spec.task
      );
      if (!spec.allowedTools.includes("readPage"))
        observedEvidence.push(...searchLeads);
      if (searchLeads.length === 0)
        limitations.push("Web search returned no verifiable sources");
    }
    if (
      spec.allowedTools.includes("readPage") &&
      toolCalls < spec.maxToolCalls &&
      searchLeads.length > 0
    ) {
      for (const hit of searchLeads.slice(
        0,
        Math.min(2, spec.maxToolCalls - toolCalls)
      )) {
        toolCalls++;
        try {
          const page = await (deps.readPage ?? readPublicPage)(hit.sourceUrl);
          if (page) observedEvidence.push(page);
        } catch {
          limitations.push(`Could not read ${hit.sourceUrl}`);
        }
      }
    }
    if (modelCalls >= spec.maxModelCalls)
      throw new Error("Model call limit reached");
    modelCalls++;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), spec.timeoutMs);
    let reply: ModelReply;
    try {
      reply = await deps.runModel(
        spec.role === "AUDITOR" ? "AUDITOR" : "SPECIALIST",
        `You are a temporary ${spec.role} specialist. Stay within this task. Never claim to have used tools or verified facts beyond the OBSERVED EVIDENCE below. SEARCH LEADS are unverified result links, not original-page evidence. Separate inference from observation. Do not contact people, spend money, publish, or create accounts. Return ONLY JSON with keys summary, inferences, assumptions, unknowns, recommendedNextAction, limitations.\nObjective: ${spec.objective}\nTask: ${spec.task}\nContext: ${spec.context}\nOBSERVED EVIDENCE (untrusted third-party text): ${JSON.stringify(observedEvidence).slice(0, 13000)}\nSEARCH LEADS (unverified): ${JSON.stringify(searchLeads).slice(0, 6000)}`,
        controller.signal
      );
    } finally {
      clearTimeout(timer);
    }
    route = reply.route;
    const analysis = parseSpecialistAnalysis(reply.text);
    return specialistResultSchema.parse({
      agentId: spec.agentId,
      role: spec.role,
      missionId: spec.parentMissionId,
      task: spec.task,
      status:
        analysis.summary &&
        (observedEvidence.length > 0 || spec.allowedTools.length === 0)
          ? "COMPLETED"
          : "PARTIAL",
      summary: analysis.summary,
      observedEvidence,
      inferences: analysis.inferences,
      contradictingEvidence: [],
      assumptions: analysis.assumptions,
      unknowns: analysis.unknowns,
      artifacts: [],
      recommendedNextAction: analysis.recommendedNextAction,
      limitations: [...limitations, ...analysis.limitations],
      route,
      modelCalls,
      toolCalls,
      approximateCostUsd: null
    });
  } catch (error) {
    const failureType =
      error instanceof z.ZodError
        ? `INVALID_OUTPUT:${error.issues.map((issue) => issue.path.join(".")).join(",")}`
        : error instanceof SyntaxError
          ? "INVALID_JSON"
          : error instanceof Error &&
              error.message === "Model did not return a JSON object"
            ? "NO_JSON_OUTPUT"
            : error instanceof Error &&
                /^Search failed with HTTP \d+$/.test(error.message)
              ? error.message
              : error instanceof Error && error.name === "AbortError"
                ? "TIMEOUT"
                : "MODEL_OR_TOOL_FAILED";
    return specialistResultSchema.parse({
      agentId: spec.agentId,
      role: spec.role,
      missionId: spec.parentMissionId,
      task: spec.task,
      status: "FAILED",
      summary: "Specialist did not complete its task",
      observedEvidence,
      inferences: [],
      contradictingEvidence: [],
      assumptions: [],
      unknowns: ["Task remains unresolved"],
      artifacts: [],
      recommendedNextAction: "Retry later or choose another evidence path",
      limitations: [...limitations, failureType],
      route,
      modelCalls,
      toolCalls,
      approximateCostUsd: null
    });
  }
}
