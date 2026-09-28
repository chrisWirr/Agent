import assert from "node:assert/strict";
import { test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { AutonomyStore } from "./store";
import {
  compactStateSummary,
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
import { ARTIST_BRIEF, MUSIC_PROGRAM_ID } from "../music/project";

test("ROOT plan normalization accepts verbose model output without widening permissions", () => {
  const plan = parseRootPlan(
    JSON.stringify({
      approach: { summary: "Verify with public sources" },
      specialists: [
        {
          role: "RESEARCHER",
          task: "x".repeat(1400),
          searchQuery: [
            "site:reddit.com/r/soul original singer discussion",
            "alternative soul audience discussion"
          ],
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
  assert.equal(
    plan.specialists[0].searchQuery,
    "site:reddit.com/r/soul original singer discussion"
  );
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
  requestedModel: "openclaw/main",
  actualModel: "UNKNOWN",
  provider: "openclaw",
  route: "linux-openclaw-bridge",
  fallbackUsed: false,
  fallbackReason: null
};

const directive: Directive = directiveSchema.parse({
  directiveId: "d1",
  programId: MUSIC_PROGRAM_ID,
  decision: "NEW_MISSION",
  objective:
    "Explore how alternative-soul listeners describe memorable choruses",
  reason: "The artist's first song needs an audience-informed reference point",
  successCriteria: ["Public discussion evidence"],
  constraints: ["No contact"],
  priority: 2,
  maxBudgetUsd: 0,
  timeLimitMinutes: 5,
  requiredEvidence: ["Public listener discussion"],
  deliverable: "Listening and writing brief",
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
  assert.equal(result.directive.programId, MUSIC_PROGRAM_ID);
});

test("RESEARCHER uses only allowed tools and preserves real source URLs", async () => {
  let searches = 0;
  const result = await spawnSpecialist(
    {
      agentId: "a1",
      role: "RESEARCHER",
      objective: "Research independent soul audiences",
      task: "Find public listener discussions",
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

test("RESEARCHER counts read pages as evidence, not search leads", async () => {
  const result = await spawnSpecialist(
    {
      agentId: "reader",
      role: "RESEARCHER",
      objective: "Verify public listener feedback",
      task: "Read original sources",
      searchQuery: "site:example.org soul discussion",
      context: "",
      allowedTools: ["webSearch", "readPage"],
      maxModelCalls: 1,
      maxToolCalls: 3,
      timeoutMs: 5000,
      maxBudgetUsd: 0,
      parentMissionId: "m1",
      delegationDepth: 2,
      reasonForDelegation: "Need original pages",
      expectedValueOfDelegation: "Verified evidence"
    },
    {
      search: async () => [
        {
          sourceUrl: "https://example.org/lead",
          title: "Search result",
          observation: "Unverified snippet",
          retrievedAt: new Date().toISOString()
        }
      ],
      readPage: async () => null,
      runModel: async () => ({
        text: JSON.stringify({
          summary: "Original page unavailable",
          inferences: [],
          assumptions: [],
          unknowns: ["Demand unverified"],
          recommendedNextAction: "Try another source",
          limitations: []
        }),
        route: unknownRoute
      })
    }
  );
  assert.equal(result.status, "PARTIAL");
  assert.deepEqual(result.observedEvidence, []);
});

test("invalid role permissions and delegation depth fail safely", async () => {
  const base = {
    agentId: "a1",
    role: "AUDITOR" as const,
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
                task: "Find listener discussions about memorable choruses",
                reasonForDelegation: "Needs public evidence",
                expectedValueOfDelegation: "Demand signal",
                allowedTools: ["webSearch"]
              }
            ],
            directFindings: [],
            humanGates: []
          })
        : JSON.stringify({
            summary: "One listener discussion found",
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

test("music mission produces a draft and keeps legacy missions out of the new workspace", async () => {
  const musicDirective = directiveSchema.parse({
    ...directive,
    directiveId: "music-first-song",
    objective: "Draft an original first song for the singer",
    requiredEvidence: [],
    deliverable: "Lyric and topline draft"
  });
  const lyric =
    "Verse: I left the porch light on for who I used to be.\nChorus: I can be broken and still be free.\nTopline: sparse verse, rising minor-key chorus.";
  const runModel: ModelRunner = async (role) => ({
    text:
      role === "ROOT"
        ? JSON.stringify({
            approach: "Make a first text draft for review",
            specialists: [
              {
                role: "SONGWRITER",
                task: "Write an original first-song lyric and topline note",
                reasonForDelegation: "Needs a concrete creative draft",
                expectedValueOfDelegation: "A reviewable song concept",
                allowedTools: []
              }
            ],
            directFindings: [],
            humanGates: [
              {
                proposedAction: "Publish this draft",
                reason: "A future release step",
                expectedBenefit: "Audience feedback",
                risk: "Premature release",
                exactApprovalNeeded: "Approve publication"
              }
            ]
          })
        : JSON.stringify({
            summary: "A first song draft is ready for artistic review",
            artifacts: [lyric],
            inferences: [],
            assumptions: [],
            unknowns: ["No recording or listening test exists"],
            recommendedNextAction: "Review the chorus with piano",
            limitations: ["Text draft only"]
          }),
    route: unknownRoute
  });
  const result = await runRootMission(musicDirective, { runModel });
  assert.equal(result.status, "COMPLETED");
  assert.deepEqual(result.humanGates, []);
  assert.equal(result.agentRuns[0].artifacts[0], lyric);
  assert.equal(result.evidence.length, 0);

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
  store.saveDirective({
    ...musicDirective,
    directiveId: "old-business",
    programId: undefined
  });
  assert.equal(store.tryStartMission("old-business"), true);
  store.saveMission({
    ...result,
    missionId: "old-mission",
    directiveId: "old-business"
  });
  store.saveDirective(musicDirective);
  assert.deepEqual(
    store.recentDirectives().map((item) => item.directiveId),
    [musicDirective.directiveId]
  );
  assert.equal(store.tryStartMission(musicDirective.directiveId), true);
  store.saveMission(result);
  store.saveMission(result);
  const artifacts = store.recentMusicArtifacts();
  assert.equal(artifacts.length, 1);
  assert.equal(artifacts[0].kind, "SONG_DRAFT");
  assert.equal(artifacts[0].status, "DRAFT");
  assert.equal(artifacts[0].content, lyric);
  assert.equal(store.recentMissions().length, 1);
  const summary = compactStateSummary({
    recentDirectives: store.recentDirectives(),
    recentMissions: store.recentMissions(),
    pendingHumanGates: 0,
    recentEvents: store.recentMusicEvents(),
    musicArtifacts: artifacts
  });
  assert.match(summary, /Alternative soul/);
  assert.match(summary, /SONG_DRAFT/);
  assert.doesNotMatch(summary, /old-business|realized net profit/i);
  assert.equal(ARTIST_BRIEF.language, "English");
  db.close();
});

test("artistic reviewer receives the songwriter draft in the same mission", async () => {
  const musicDirective = directiveSchema.parse({
    ...directive,
    directiveId: "music-review-chain",
    objective: "Draft and review a first chorus",
    requiredEvidence: []
  });
  let reviewerSawDraft = false;
  const result = await runRootMission(musicDirective, {
    runModel: async (role, prompt) => {
      if (role === "ROOT")
        return {
          text: JSON.stringify({
            approach: "Draft then review",
            specialists: [
              {
                role: "SONGWRITER",
                task: "Write the chorus",
                reasonForDelegation: "Original writing",
                expectedValueOfDelegation: "Draft",
                allowedTools: []
              },
              {
                role: "AUDITOR",
                task: "Review the chorus",
                reasonForDelegation: "Independent review",
                expectedValueOfDelegation: "Review",
                allowedTools: []
              }
            ],
            directFindings: [],
            humanGates: []
          }),
          route: unknownRoute
        };
      if (role === "AUDITOR")
        reviewerSawDraft = prompt.includes("Original chorus");
      return {
        text: JSON.stringify({
          summary: "Draft reviewed",
          artifacts: [
            role === "AUDITOR"
              ? "Review: chorus is specific"
              : "Original chorus"
          ],
          inferences: [],
          assumptions: [],
          unknowns: [],
          recommendedNextAction: "Continue",
          limitations: []
        }),
        route: unknownRoute
      };
    }
  });
  assert.equal(reviewerSawDraft, true);
  assert.equal(result.status, "COMPLETED");
  assert.equal(result.agentRuns.length, 2);
});

test("music creation cannot complete from research evidence alone", async () => {
  const creativeDirective = directiveSchema.parse({
    ...directive,
    directiveId: "creative-without-draft",
    objective: "Write a first song draft",
    requiredEvidence: []
  });
  const result = await runRootMission(creativeDirective, {
    runModel: async (role) => ({
      text:
        role === "ROOT"
          ? JSON.stringify({
              approach: "Read public context first",
              specialists: [
                {
                  role: "RESEARCHER",
                  task: "Find a public soul discussion",
                  reasonForDelegation: "Gather context",
                  expectedValueOfDelegation: "One source",
                  allowedTools: ["webSearch"]
                }
              ],
              directFindings: [],
              humanGates: []
            })
          : JSON.stringify({
              summary: "Found a discussion",
              artifacts: [],
              inferences: [],
              assumptions: [],
              unknowns: [],
              recommendedNextAction: "Draft a chorus",
              limitations: []
            }),
      route: unknownRoute
    }),
    search: async () => [
      {
        sourceUrl: "https://example.org/soul-discussion",
        title: "Public discussion",
        observation: "Listeners discuss emotional choruses",
        retrievedAt: new Date().toISOString()
      }
    ]
  });
  assert.equal(result.evidence.length, 1);
  assert.equal(result.status, "PARTIAL");
});

test("a creative summary without a draft remains partial", async () => {
  const result = await spawnSpecialist(
    {
      agentId: "songwriter-1",
      role: "SONGWRITER",
      objective: "Draft first song",
      task: "Write an original chorus",
      context: "",
      allowedTools: [],
      maxModelCalls: 1,
      maxToolCalls: 0,
      timeoutMs: 5000,
      maxBudgetUsd: 0,
      parentMissionId: "m1",
      delegationDepth: 2,
      reasonForDelegation: "Need a draft",
      expectedValueOfDelegation: "Reviewable chorus"
    },
    {
      runModel: async () => ({
        text: JSON.stringify({
          summary: "A chorus could work",
          artifacts: [],
          inferences: [],
          assumptions: [],
          unknowns: [],
          recommendedNextAction: "Write it",
          limitations: []
        }),
        route: unknownRoute
      })
    }
  );
  assert.equal(result.status, "PARTIAL");
});

test("structured creative drafts are retained as artifacts", async () => {
  const result = await spawnSpecialist(
    {
      agentId: "songwriter-structured",
      role: "SONGWRITER",
      objective: "Draft first song",
      task: "Write an original chorus",
      context: "",
      allowedTools: [],
      maxModelCalls: 1,
      maxToolCalls: 0,
      timeoutMs: 5000,
      maxBudgetUsd: 0,
      parentMissionId: "m1",
      delegationDepth: 2,
      reasonForDelegation: "Need a draft",
      expectedValueOfDelegation: "Reviewable chorus"
    },
    {
      runModel: async () => ({
        text: JSON.stringify({
          summary: "Original chorus drafted",
          artifacts: [{ title: "First Song", chorus: "An original lyric" }],
          inferences: [],
          assumptions: [],
          unknowns: [],
          recommendedNextAction: "Review draft",
          limitations: []
        }),
        route: unknownRoute
      })
    }
  );
  assert.equal(result.status, "COMPLETED");
  assert.match(result.artifacts[0], /An original lyric/);
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
            proposedAction: "Publish a song teaser",
            reason: "Get real audience feedback",
            expectedBenefit: "Listener response",
            risk: "Unreviewed public release",
            exactApprovalNeeded: "Approve the exact recording, artwork and post"
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
