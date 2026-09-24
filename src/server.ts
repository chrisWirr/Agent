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

    return openclaw("openclaw/default");
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
            evidence: missions[0].evidence.slice(0, 5),
            humanGates: missions[0].humanGates
          }
        : null,
      recentEvents: store.recentEvents()
    };
  }

  async scheduledStrategistReview() {
    const store = new AutonomyStore(this.sql.bind(this));
    store.initialize();
    store.expireStaleMissions(35 * 60 * 1000);
    const now = Date.now();
    const dayAgo = now - 24 * 60 * 60 * 1000;
    const lastReview = store.latestEvent("STRATEGIST_REVIEW");
    if (store.currentMission()) return;
    if (
      store.countEventsSince("STRATEGIST_REVIEW", dayAgo) >=
      DEFAULT_LIMITS.maxStrategistCallsPerDay
    )
      return;
    if (
      lastReview &&
      now - lastReview.created_at <
        DEFAULT_LIMITS.reviewCooldownMinutes * 60 * 1000
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
        { runModel: runner },
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
    } catch {
      if (activeDirectiveId) store.failMission(activeDirectiveId);
      store.recordEvent("STRATEGIST_REVIEW_FAILED");
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
    return (
      (await routeAgentRequest(request, env)) ||
      new Response("Not found", {
        status: 404
      })
    );
  }
} satisfies ExportedHandler<Env>;
