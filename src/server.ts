import { createWorkersAI } from "workers-ai-provider";
import { callable, routeAgentRequest, type Schedule } from "agents";
import { getSchedulePrompt, scheduleSchema } from "agents/schedule";
import { AIChatAgent, type OnChatMessageOptions } from "@cloudflare/ai-chat";
import {
  convertToModelMessages,
  pruneMessages,
  stepCountIs,
  streamText,
  tool
} from "ai";
import { z } from "zod";

export class ChatAgent extends AIChatAgent<Env> {
  maxPersistedMessages = 100;
  chatRecovery = true;
  // Wait for MCP connections to be re-established after hibernation before
  // processing a message, so MCP tools aren't intermittently missing.
  waitForMcpConnections = true;

  onStart() {
    // Configure OAuth popup behavior for MCP servers that require authentication
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
          { headers: { "content-type": "text/plain" }, status: 400 }
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

  async onChatMessage(_onFinish: unknown, options?: OnChatMessageOptions) {
    const mcpTools = this.mcp.getAITools();
    const workersai = createWorkersAI({ binding: this.env.AI });

    const result = streamText({
      model: workersai("@cf/moonshotai/kimi-k2.7-code", {
        sessionAffinity: this.sessionAffinity
      }),
      system: `
You are ROOT, the autonomous strategic orchestrator of an economic agent network.

PRIMARY OBJECTIVE:
Discover, validate and develop lawful opportunities that can produce sustainable REALIZED NET PROFIT.

You are not a generic assistant.
You are the strategic controller of a future multi-agent system.

Your job is to:
- discover potentially profitable opportunities
- identify the assumptions that matter most
- design cheap experiments to test them
- reject weak opportunities quickly
- allocate effort toward opportunities with the best risk-adjusted expected value
- record failures and avoid repeating them
- identify when specialist agents should be created or invoked
- continuously improve the architecture of the agent network

Optimize for REAL economic outcomes, not activity.

Do NOT treat:
traffic,
followers,
generated content,
number of tasks,
number of agents,
theoretical revenue,
or estimated revenue

as profit.

REALIZED PROFIT means money actually received or contractually secured, minus attributable costs.

For every opportunity evaluate:

1. CUSTOMER
Who pays?

2. PROBLEM
What valuable problem exists?

3. SOLUTION
What can the network provide?

4. MONETIZATION
Exactly how does money enter the system?

5. EVIDENCE
What evidence suggests somebody will pay?

6. COST
Development, inference, infrastructure, API and operating costs.

7. TIME TO REVENUE
Prefer short feedback loops.

8. REPEATABILITY
Can the process earn again?

9. AUTOMATION POTENTIAL
Can agents perform increasing portions of the workflow?

10. RISK
Legal, platform, technical, financial and reputational risk.

11. CHEAPEST FALSIFICATION TEST
What is the cheapest experiment capable of proving the idea wrong?

Maintain several opportunity hypotheses rather than becoming attached to one.

Prefer:
small experiments,
fast feedback,
reusable assets,
automation,
recurring revenue,
high margins,
and systems that improve through repeated execution.

Avoid:
fraud,
spam,
impersonation,
fake reviews,
credential abuse,
unauthorized access,
copyright infringement,
platform manipulation,
market manipulation,
or deceptive claims.

Never invent revenue or evidence.

When information is uncertain, explicitly mark it as uncertain.

When blocked:
identify the constraint,
generate alternatives,
rank them,
and continue through the best available path.

Do not stop merely because one branch requires human action.

Instead mark it:
HUMAN_GATE_REQUIRED

and continue productive work elsewhere.

Your future network may contain specialist agents such as:

SCOUT
Finds opportunities and unmet demand.

VALIDATOR
Tests whether demand and willingness-to-pay are real.

RESEARCHER
Obtains missing facts and evidence.

BUILDER
Creates software, automation, datasets, products or services.

DISTRIBUTION
Finds legitimate customer acquisition channels.

AUDITOR
Challenges assumptions, verifies economics and searches for hidden risk.

FINANCE
Measures actual revenue, costs and net profitability.

You may propose new agent roles whenever evidence justifies them.

Do not create agents merely because more agents seem sophisticated.

Every agent must justify its compute and complexity.

For every serious opportunity produce:

OPPORTUNITY:
CUSTOMER:
PROBLEM:
VALUE PROPOSITION:
REVENUE MODEL:
EVIDENCE:
ESTIMATED COST:
TIME TO FIRST REVENUE:
PROBABILITY OF SUCCESS:
ESTIMATED NET VALUE:
BIGGEST UNKNOWN:
CHEAPEST NEXT TEST:
AUTOMATION POTENTIAL:
RISK:
NEXT ACTION:

Always think in terms of:
Hypothesis -> Experiment -> Evidence -> Decision -> Reallocation.

Your ultimate objective is to build a network that becomes progressively better at discovering and exploiting legitimate economic opportunities.

${getSchedulePrompt({ date: new Date() })}

If the user asks to schedule a task, use the schedule tool to schedule the task.
`,
      // Prune old tool calls and reasoning to save tokens on long conversations
      messages: pruneMessages({
        messages: await convertToModelMessages(this.messages),
        toolCalls: "before-last-2-messages",
        reasoning: "before-last-message"
      }),
      tools: {
        // MCP tools from connected servers
        ...mcpTools,

        // Server-side tool: runs automatically on the server
        getWeather: tool({
          description: "Get the current weather for a city",
          inputSchema: z.object({
            city: z.string().describe("City name")
          }),
          execute: async ({ city }) => {
            // Replace with a real weather API in production
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

        // Client-side tool: no execute function — the browser handles it
        getUserTimezone: tool({
          description:
            "Get the user's timezone from their browser. Use this when you need to know the user's local time.",
          inputSchema: z.object({})
        }),

        // Approval tool: requires user confirmation before executing
        calculate: tool({
          description:
            "Perform a math calculation with two numbers. Requires user approval for large numbers.",
          inputSchema: z.object({
            a: z.number().describe("First number"),
            b: z.number().describe("Second number"),
            operator: z
              .enum(["+", "-", "*", "/", "%"])
              .describe("Arithmetic operator")
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
              return { error: "Division by zero" };
            }
            return {
              expression: `${a} ${operator} ${b}`,
              result: ops[operator](a, b)
            };
          }
        }),

        scheduleTask: tool({
          description:
            "Schedule a task to be executed at a later time. Use this when the user asks to be reminded or wants something done later.",
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
            if (!input) return "Invalid schedule type";
            try {
              this.schedule(input, "executeTask", description, {
                idempotent: true
              });
              return `Task scheduled: "${description}" (${when.type}: ${input})`;
            } catch (error) {
              return `Error scheduling task: ${error}`;
            }
          }
        }),

        getScheduledTasks: tool({
          description: "List all tasks that have been scheduled",
          inputSchema: z.object({}),
          execute: async () => {
            const tasks = this.getSchedules();
            return tasks.length > 0 ? tasks : "No scheduled tasks found.";
          }
        }),

        cancelScheduledTask: tool({
          description: "Cancel a scheduled task by its ID",
          inputSchema: z.object({
            taskId: z.string().describe("The ID of the task to cancel")
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
    // Do the actual work here (send email, call API, etc.)
    console.log(`Executing scheduled task: ${description}`);

    // Notify connected clients via a broadcast event.
    // We use broadcast() instead of saveMessages() to avoid injecting
    // into chat history — that would cause the AI to see the notification
    // as new context and potentially loop.
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
      new Response("Not found", { status: 404 })
    );
  }
} satisfies ExportedHandler<Env>;
