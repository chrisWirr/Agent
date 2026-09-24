import assert from "node:assert/strict";
import { test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { AutonomyStore } from "./store";
import {
  parseRootPlan,
  runRootMission,
  runStrategistReview,
  DEFAULT_LIMITS
} from "./orchestrator";
import { readViaBridge, searchPublicWeb, searchViaBridge } from "./research";
import { spawnSpecialist, type ModelRunner } from "./runtime";
import {
  directiveSchema,
  missionResultSchema,
  specialistResultSchema,
  type Directive,
  type Route
} from "./schemas";

test("ROOT plan normalization accepts verbose model output without widening permissions", () => {
  const plan = parseRootPlan(
    JSON.stringify({
      approach: { summary: "Verify with public sources" },
      specialists: [
        {
          role: "RESEARCHER",
          task: "x".repeat(1400),
          reasonForDelegation: "Needs retrieval",
          expectedValueOfDelegation: "Public evidence",
          allowedTools: ["webSearch"]
        }
      ],
      directFindings: Array.from({ length: 8 }, () => ({ unverified: true })),
      humanGates: ["Never contact people"]
    })
  );
  assert.equal(plan.specialists[0].task.length, 1200);
  assert.equal(plan.directFindings.length, 6);
  assert.deepEqual(plan.humanGates, []);
  assert.throws(() =>
    parseRootPlan(
      JSON.stringify({
        approach: "Unsafe tool",
        specialists: [
          {
            role: "RESEARCHER",
            task: "Try",
            reasonForDelegation: "Test",
            expectedValueOfDelegation: "Test",
            allowedTools: ["email"]
          }
        ],
        directFindings: [],
        humanGates: []
      })
    )
  );
});

const unknownRoute: Route = {
  requestedModel: "openclaw/default",
  actualModel: "UNKNOWN",
  provider: "openclaw",
  route: "linux-openclaw-bridge",
  fallbackUsed: false,
  fallbackReason: null
};

const directive: Directive = directiveSchema.parse({
  directiveId: "d1",
  decision: "NEW_MISSION",
  objective: "Find evidence for a narrow German B2B information service",
  reason: "Demand is unknown",
  successCriteria: ["Public demand evidence"],
  constraints: ["No contact"],
  priority: 2,
  maxBudgetUsd: 0,
  timeLimitMinutes: 5,
  requiredEvidence: ["Public source"],
  deliverable: "Evidence summary",
  createdAt: new Date().toISOString()
});

test("directive, specialist and mission results reject invalid input", () => {
  assert.equal(
    directiveSchema.safeParse({ ...directive, maxBudgetUsd: -1 }).success,
    false
  );
  assert.equal(
    specialistResultSchema.safeParse({ role: "RESEARCHER" }).success,
    false
  );
  assert.equal(
    missionResultSchema.safeParse({ missionId: "x" }).success,
    false
  );
});

test("Strategist can choose WAIT without creating a mission", async () => {
  const runner: ModelRunner = async () => ({
    text: JSON.stringify({
      decision: "WAIT",
      objective: "",
      reason: "No new evidence",
      successCriteria: [],
      constraints: [],
      priority: 0,
      maxBudgetUsd: 0,
      timeLimitMinutes: 5,
      requiredEvidence: [],
      deliverable: ""
    }),
    route: unknownRoute
  });
  const result = await runStrategistReview("{}", runner);
  assert.equal(result.directive.decision, "WAIT");
});

test("RESEARCHER uses only allowed tools and preserves real source URLs", async () => {
  let searches = 0;
  const result = await spawnSpecialist(
    {
      agentId: "a1",
      role: "RESEARCHER",
      objective: "Assess demand",
      task: "German HVAC subsidy alerts",
      context: "",
      allowedTools: ["webSearch"],
      maxModelCalls: 1,
      maxToolCalls: 1,
      timeoutMs: 5000,
      maxBudgetUsd: 0,
      parentMissionId: "m1",
      delegationDepth: 2,
      reasonForDelegation: "Need public sources",
      expectedValueOfDelegation: "Evidence"
    },
    {
      search: async () => {
        searches++;
        return [
          {
            sourceUrl: "https://example.org/source",
            title: "Source",
            observation: "Observed",
            retrievedAt: new Date().toISOString()
          }
        ];
      },
      runModel: async () => ({
        text: JSON.stringify({
          summary: "One source found",
          inferences: ["Maybe demand"],
          assumptions: [],
          unknowns: [],
          recommendedNextAction: "Validate",
          limitations: []
        }),
        route: unknownRoute
      })
    }
  );
  assert.equal(searches, 1);
  assert.equal(result.toolCalls, 1);
  assert.equal(result.modelCalls, 1);
  assert.equal(
    result.observedEvidence[0].sourceUrl,
    "https://example.org/source"
  );
  assert.equal(result.route.actualModel, "UNKNOWN");
});

test("invalid role permissions and delegation depth fail safely", async () => {
  const base = {
    agentId: "a1",
    role: "AUDITOR",
    objective: "Audit",
    task: "Review",
    context: "",
    allowedTools: ["webSearch"] as ["webSearch"],
    maxModelCalls: 1,
    maxToolCalls: 1,
    timeoutMs: 5000,
    maxBudgetUsd: 0,
    parentMissionId: "m1",
    delegationDepth: 2 as const,
    reasonForDelegation: "Independent review",
    expectedValueOfDelegation: "Error detection"
  };
  await assert.rejects(() =>
    spawnSpecialist(base, {
      runModel: async () => {
        throw new Error("must not run");
      }
    })
  );
  await assert.rejects(() =>
    spawnSpecialist(
      { ...base, role: "RESEARCHER", delegationDepth: 3 as 2 },
      {
        runModel: async () => {
          throw new Error("must not run");
        }
      }
    )
  );
});

test("specialist failure is structured and does not leak secrets", async () => {
  const secret = "sk-this-must-not-appear-anywhere";
  const result = await spawnSpecialist(
    {
      agentId: "a1",
      role: "RESEARCHER",
      objective: "Research",
      task: "Research",
      context: "",
      allowedTools: ["webSearch"],
      maxModelCalls: 1,
      maxToolCalls: 1,
      timeoutMs: 5000,
      maxBudgetUsd: 0,
      parentMissionId: "m1",
      delegationDepth: 2,
      reasonForDelegation: "Evidence",
      expectedValueOfDelegation: "Evidence"
    },
    {
      search: async () => [],
      runModel: async () => {
        throw new Error(secret);
      }
    }
  );
  assert.equal(result.status, "FAILED");
  assert.equal(JSON.stringify(result).includes(secret), false);
});

test("ROOT can spawn RESEARCHER and consolidate observed evidence", async () => {
  const runner: ModelRunner = async (role) => ({
    text:
      role === "ROOT"
        ? JSON.stringify({
            approach: "Check public sources",
            specialists: [
              {
                role: "RESEARCHER",
                task: "German HVAC subsidy alerts",
                reasonForDelegation: "Needs public evidence",
                expectedValueOfDelegation: "Demand signal",
                allowedTools: ["webSearch"]
              }
            ],
            directFindings: [],
            humanGates: []
          })
        : JSON.stringify({
            summary: "One source found",
            inferences: [],
            assumptions: [],
            unknowns: [],
            recommendedNextAction: "Compare competitors",
            limitations: []
          }),
    route: unknownRoute
  });
  const result = await runRootMission(directive, {
    runModel: runner,
    search: async () => [
      {
        sourceUrl: "https://example.org/source",
        title: "Source",
        observation: "Public evidence",
        retrievedAt: new Date().toISOString()
      }
    ]
  });
  assert.equal(result.status, "COMPLETED");
  assert.deepEqual(result.specialistsUsed, ["RESEARCHER"]);
  assert.equal(result.evidence.length, 1);
  assert.equal(result.modelCalls, 2);
  assert.equal(result.actualCostUsd, null);
});

test("ROOT retries one malformed plan without an unbounded loop", async () => {
  let calls = 0;
  const result = await runRootMission(directive, {
    runModel: async () => ({
      text:
        ++calls === 1
          ? "I will research first."
          : JSON.stringify({
              approach: "Wait for evidence",
              specialists: [],
              directFindings: [],
              humanGates: []
            }),
      route: unknownRoute
    })
  });
  assert.equal(calls, 2);
  assert.equal(result.modelCalls, 2);
  assert.equal(result.status, "PARTIAL");
});

test("ROOT specialist cap, failure handling and human gates", async () => {
  const overLimit = await runRootMission(
    directive,
    {
      runModel: async () => ({
        text: JSON.stringify({
          approach: "Too many",
          specialists: Array.from({ length: 3 }, () => ({
            role: "RESEARCHER",
            task: "Search",
            reasonForDelegation: "Need evidence",
            expectedValueOfDelegation: "Evidence",
            allowedTools: ["webSearch"]
          })),
          directFindings: [],
          humanGates: []
        }),
        route: unknownRoute
      })
    },
    DEFAULT_LIMITS
  );
  assert.equal(overLimit.status, "FAILED");
  const gated = await runRootMission(directive, {
    runModel: async () => ({
      text: JSON.stringify({
        approach: "Need external contact",
        specialists: [],
        directFindings: [],
        humanGates: [
          {
            proposedAction: "Contact customers",
            reason: "Validate demand",
            expectedBenefit: "Evidence",
            risk: "Unwanted outreach",
            exactApprovalNeeded: "Approve specific message and recipients"
          }
        ]
      }),
      route: unknownRoute
    })
  });
  assert.equal(gated.status, "HUMAN_GATE_REQUIRED");
});

test("mission execution is idempotent in Durable Object SQL", () => {
  const db = new DatabaseSync(":memory:");
  const sql = <T>(
    strings: TemplateStringsArray,
    ...values: (string | number | boolean | null)[]
  ) => {
    const query = strings.reduce(
      (output, part, index) =>
        output + part + (index < values.length ? "?" : ""),
      ""
    );
    return db
      .prepare(query)
      .all(
        ...values.map((value) =>
          typeof value === "boolean" ? Number(value) : value
        )
      ) as T[];
  };
  const store = new AutonomyStore(sql);
  store.initialize();
  assert.equal(store.tryStartMission("d1"), true);
  assert.equal(store.tryStartMission("d1"), false);
  assert.equal(store.tryAcquireReview(), true);
  assert.equal(store.tryAcquireReview(), false);
  store.releaseReview();
  db.close();
});

test("public search creates evidence only from retrieved search results", async () => {
  const hits = await searchPublicWeb(
    "test",
    async () =>
      new Response(
        '<a href="https://example.org/source"><div>Example</div></a>'
      )
  );
  assert.equal(hits.length, 1);
  assert.equal(hits[0].sourceUrl, "https://example.org/source");
  assert.equal(hits[0].observation.includes("test"), true);
});

test("public search falls back when primary search is blocked", async () => {
  let calls = 0;
  const hits = await searchPublicWeb("test", async () => {
    calls++;
    return calls === 1
      ? new Response("blocked", { status: 429 })
      : new Response(
          '<a rel="nofollow" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.org%2Fsource" class="result-link">Example</a><td class="result-snippet">Public finding</td>'
        );
  });
  assert.equal(calls, 2);
  assert.equal(hits[0].sourceUrl, "https://example.org/source");
});

test("authenticated bridge search and page reading preserve retrieved evidence", async () => {
  const evidence = {
    sourceUrl: "https://example.org/source",
    title: "Example",
    observation: "Public finding",
    retrievedAt: new Date().toISOString()
  };
  const seen: string[] = [];
  const fetcher = async (input: RequestInfo | URL, options?: RequestInit) => {
    seen.push(String(input));
    assert.equal(options?.headers && "authorization" in options.headers, true);
    return Response.json(
      String(input).includes("/research/search") ? [evidence] : evidence
    );
  };
  const hits = await searchViaBridge(
    "test",
    "https://bridge.example.org",
    "secret",
    fetcher
  );
  const page = await readViaBridge(
    evidence.sourceUrl,
    "https://bridge.example.org",
    "secret",
    fetcher
  );
  assert.equal(hits[0].sourceUrl, evidence.sourceUrl);
  assert.equal(page?.observation, evidence.observation);
  assert.equal(seen.length, 2);
});
