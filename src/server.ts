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
import { createWorkersAI } from "workers-ai-provider";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { createModelRunner } from "./autonomy/model";
import {
  compactStateSummary,
  DEFAULT_LIMITS,
  runRootMission,
  runStrategistReview
} from "./autonomy/orchestrator";
import { AutonomyStore } from "./autonomy/store";
import {
  readViaBridge,
  searchPublicWeb,
  searchViaBridge
} from "./autonomy/research";
import { directiveSchema } from "./autonomy/schemas";

async function selectModel(env: Env) {
  const workersai = createWorkersAI({ binding: env.AI });
  const fallback = workersai("@cf/zai-org/glm-4.7-flash");

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

    return openclaw("openclaw/main");
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
    if (store.recentDirectives().length === 0) {
      const failedBefore = Boolean(
        store.latestEvent("STRATEGIST_REVIEW_FAILED")
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
      recentEvents: store.recentEvents()
    };
  }

  async queueExternalDirective(input: unknown) {
    const directive = directiveSchema.parse(input);
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
    if (!directive) return;
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
    if (!original) return { queued: false, reason: "DIRECTIVE_NOT_FOUND" };
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
        reason: "Technical retry after repairing public search",
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
    const lastReview = store.latestEvent("STRATEGIST_REVIEW");
    const lastFailure = store.latestEvent("STRATEGIST_REVIEW_FAILED");
    if (store.currentMission()) return;
    if (
      store.countEventsSince("STRATEGIST_REVIEW", dayAgo) >=
      DEFAULT_LIMITS.maxStrategistCallsPerDay
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
    const lastDirective = store.recentDirectives()[0];
    if (
      lastDirective?.decision === "WAIT" &&
      !store
        .eventsAfter(lastReview?.created_at ?? 0)
        .some((event) =>
          [
            "MISSION_COMPLETED",
            "MISSION_FAILED",
            "HUMAN_GATE_RESOLVED",
            "EVIDENCE_RECORDED",
            "REVENUE_RECORDED",
            "PROVIDER_RECOVERED"
          ].includes(event.kind)
        )
    )
      return;
    if (!store.tryAcquireReview()) return;

    let activeDirectiveId: string | null = null;
    try {
      store.recordEvent("STRATEGIST_REVIEW");
      const previousMissions = store.recentMissions();
      const summary = compactStateSummary({
        recentDirectives: store.recentDirectives(),
        recentMissions: previousMissions,
        openOpportunities:
          previousMissions.length === 0
            ? [
                "German HVAC subsidy and tender monitoring",
                "German B2B regulatory change alerts",
                "German small business automation services"
              ]
            : [],
        pendingHumanGates: previousMissions.reduce(
          (sum, mission) => sum + mission.humanGates.length,
          0
        ),
        recentEvents: store.recentEvents()
      });
      const runner = createModelRunner(this.env);
      const { directive, route } = await runStrategistReview(summary, runner);
      store.saveDirective(directive);
      if (route.fallbackUsed)
        store.recordEvent("FALLBACK_USED", {
          role: "STRATEGIST",
          reason: route.fallbackReason
        });
      if (directive.decision === "WAIT" || directive.decision === "KILL")
        return;
      if (
        store.countEventsSince("MISSION_STARTED", dayAgo) >=
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
      store.recordEvent("STRATEGIST_REVIEW_FAILED", { failureType });
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
You are ROOT, the operational orchestrator for a bounded economic agent system.
STRATEGIST decides what matters and why. You decide how to execute a directive, which evidence is needed, whether a temporary specialist is worth its cost, and how to verify its result.
The goal is lawful sustainable REALIZED NET PROFIT: money received or contractually secured minus attributable costs. Do not count traffic, followers, activity, or estimated revenue as profit.
Prefer cheap falsifiable experiments, short feedback loops, reusable assets, and verified external evidence. Separate observations from inferences and never invent customers, prices, URLs, revenue, or tool results.
Do not spend money, contact people, publish, create external accounts, sign contracts, access sensitive data, change credentials, or make destructive changes without a human gate. State the proposed action and exact approval needed, then continue safe work where possible.
Your autonomous missions are executed by the separate mission runtime. This chat remains available for conversation and the existing tools.

${getSchedulePrompt({ date: new Date() })}

If the user asks to schedule a task, use the schedule tool.
`,

      messages: pruneMessages({
        messages: await convertToModelMessages(this.messages),
        toolCalls: "before-last-2-messages",
        reasoning: "before-last-message"
      }),

      tools: {
        ...mcpTools,

        getWeather: tool({
          description: "Get the current weather for a city",
          inputSchema: z.object({
            city: z.string().describe("City name")
          }),
          execute: async ({ city }) => {
            const conditions = ["sunny", "cloudy", "rainy", "snowy"];

            const temp = Math.floor(Math.random() * 30) + 5;

            return {
              city,
              temperature: temp,
              condition:
                conditions[Math.floor(Math.random() * conditions.length)],
              unit: "celsius"
            };
          }
        }),

        getUserTimezone: tool({
          description: "Get the user's timezone from their browser.",
          inputSchema: jsonSchema<Record<string, never>>({
            type: "object",
            properties: {},
            required: [],
            additionalProperties: false
          })
        }),

        calculate: tool({
          description: "Perform a math calculation with two numbers.",
          inputSchema: z.object({
            a: z.number(),
            b: z.number(),
            operator: z.enum(["+", "-", "*", "/", "%"])
          }),

          needsApproval: async ({ a, b }) =>
            Math.abs(a) > 1000 || Math.abs(b) > 1000,

          execute: async ({ a, b, operator }) => {
            const ops: Record<string, (x: number, y: number) => number> = {
              "+": (x, y) => x + y,
              "-": (x, y) => x - y,
              "*": (x, y) => x * y,
              "/": (x, y) => x / y,
              "%": (x, y) => x % y
            };

            if (operator === "/" && b === 0) {
              return {
                error: "Division by zero"
              };
            }

            return {
              expression: `${a} ${operator} ${b}`,
              result: ops[operator](a, b)
            };
          }
        }),

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
              this.schedule(input, "executeTask", description, {
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

      stopWhen: stepCountIs(20),

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
              "/admin/bridge-health",
              "/admin/search-diagnostics"
            ].includes(pathname)) ||
          (request.method === "POST" && pathname === "/admin/retry-research") ||
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
          "Fördermittel Monitoring Handwerker Software Preis";
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
