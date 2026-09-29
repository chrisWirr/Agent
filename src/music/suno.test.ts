import assert from "node:assert/strict";
import { test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { AutonomyStore } from "../autonomy/store";
import type { ModelRunner } from "../autonomy/runtime";
import type { Route } from "../autonomy/schemas";
import {
  auditSunoReturn,
  parseSunoAudit,
  prepareSunoPackage,
  songText,
  sunoAuditStatus,
  sunoSubmissionSchema,
  type SunoHandoff
} from "./suno";

const route: Route = {
  requestedModel: "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
  actualModel: "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
  provider: "workers-ai",
  route: "cloudflare-binding",
  fallbackUsed: false,
  fallbackReason: null
};

test("Suno package uses only lyrics, not the editor change log", async () => {
  const song = songText(
    JSON.stringify({
      kind: "song_revision",
      title: "Revised Lyrics",
      body: "TITLE: I Practiced Leaving\n\nVERSE 1\nI waited.\n\nCHORUS\nI stay.\n\nChange Log: Cut a line."
    })
  );
  assert.equal(song.title, "I Practiced Leaving");
  assert.equal(song.lyrics.includes("Change Log"), false);
  assert.equal(song.lyrics.includes("[CHORUS]"), true);
  const runner: ModelRunner = async (role, prompt) => {
    assert.equal(role, "SUNO_PREPARER");
    assert.match(prompt, /I Practiced Leaving/);
    assert.doesNotMatch(prompt, /Cut a line/);
    return {
      text: JSON.stringify({
        decision: "READY",
        reason:
          "The concrete chorus and emotional turn are strong enough for a demo.",
        stylePrompt:
          "Alternative soul, intimate rough-edged female lead, restrained 808 groove, dry guitar and warm bass, sparse verses building into a powerful piano-led chorus.",
        qualityChecks: ["Clear vocal diction", "Chorus survives with piano"]
      }),
      route
    };
  };
  const packageResult = await prepareSunoPackage(
    {
      ...song,
      lyricReview: "The refrain is specific and singable.",
      productionBrief: "Leave space around the first verse."
    },
    runner
  );
  assert.equal(packageResult.decision, "READY");
  assert.match(packageResult.stylePrompt, /Alternative soul/);
});

test("Suno return accepts only Suno HTTPS links and keeps release rights gated", async () => {
  const base = {
    handoffId: "suno:1",
    sunoUrl: "https://suno.com/song/abc",
    listeningNotes:
      "The chorus feels powerful but the last verse is difficult to understand.",
    rightsBasis: "UNKNOWN",
    audioEvidence: null
  };
  assert.equal(sunoSubmissionSchema.safeParse(base).success, true);
  assert.equal(
    sunoSubmissionSchema.safeParse({
      ...base,
      sunoUrl: "https://evil.example/song/abc"
    }).success,
    false
  );
  assert.equal(
    sunoSubmissionSchema.safeParse({
      ...base,
      sunoUrl: "http://suno.com/song/abc"
    }).success,
    false
  );
  assert.equal(
    sunoAuditStatus("RELEASE_CANDIDATE", "UNKNOWN"),
    "RIGHTS_CHECK_REQUIRED"
  );
  assert.equal(
    sunoAuditStatus("RELEASE_CANDIDATE", "PAID_AT_CREATION"),
    "RELEASE_PROPOSED"
  );
  assert.equal(
    sunoAuditStatus("INSUFFICIENT_EVIDENCE", "PAID_AT_CREATION"),
    "AUDIT_INCONCLUSIVE"
  );
});

test("returned recording audit requires audio transcript and states its limits", async () => {
  const handoff: SunoHandoff = {
    id: "suno:1",
    sourceArtifactId: "song:1",
    sourceMissionId: "mission:1",
    title: "I Practiced Leaving",
    lyrics: "VERSE 1\nI waited.\nCHORUS\nI stay.",
    preparation: {
      decision: "READY",
      reason: "The song has a distinctive chorus and a clear emotional turn.",
      stylePrompt: "Alternative soul with a sparse verse and warm bass.",
      qualityChecks: ["Diction", "Chorus"]
    },
    status: "AUDITING",
    submission: {
      handoffId: "suno:1",
      sunoUrl: "https://suno.com/song/abc",
      listeningNotes:
        "The lead voice sounded warm and the chorus worked, though the last word was blurred.",
      rightsBasis: "PAID_AT_CREATION",
      audioEvidence: null
    },
    audit: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };
  await assert.rejects(
    () =>
      auditSunoReturn(handoff, async () => {
        throw new Error("should not run");
      }),
    /AUDIO_TRANSCRIPT_REQUIRED/
  );
  handoff.submission!.audioEvidence = {
    filename: "demo.mp3",
    byteLength: 1000,
    sha256: "a".repeat(64),
    transcript: "I waited, I stay"
  };
  const runner: ModelRunner = async (role, prompt) => {
    assert.equal(role, "SUNO_AUDITOR");
    assert.match(prompt, /never claim you listened/i);
    return {
      text: JSON.stringify({
        decision: "REVISE",
        summary:
          "The selected recording needs another pass before a release proposal.",
        lyricFidelity:
          "The automated transcript misses a line; human verification is needed.",
        strengths: ["Reported chorus impact"],
        issues: ["Blurred final word"],
        uncertainties: ["No independent timbre assessment"],
        releaseProposal: "Hold distribution and revise the outro."
      }),
      route
    };
  };
  const audit = await auditSunoReturn(handoff, runner);
  assert.equal(audit.decision, "REVISE");
});

test("Suno audit normalizes verbose model fields without inventing approval", () => {
  const audit = parseSunoAudit(
    JSON.stringify({
      decision: "RELEASE_CANDIDATE",
      summary: "short",
      lyric_fidelity: "unclear",
      strengths: "The reported chorus is memorable",
      issues: ["The last word is blurred"],
      uncertainties: ["No direct listening evidence"]
    })
  );
  assert.equal(audit.decision, "INSUFFICIENT_EVIDENCE");
  assert.deepEqual(audit.strengths, ["The reported chorus is memorable"]);
  assert.equal(audit.releaseProposal, "");
});

test("Suno handoff versions persist independently in Durable Object SQLite", () => {
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
  const handoff: SunoHandoff = {
    id: "suno:song:1",
    sourceArtifactId: "song:1",
    sourceMissionId: "mission:1",
    title: "First song",
    lyrics: "VERSE\nI stay",
    preparation: null,
    status: "PREPARING",
    submission: null,
    audit: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };
  store.saveSunoHandoff(handoff);
  store.saveSunoHandoff({ ...handoff, status: "READY_FOR_SUNO" });
  assert.equal(store.getSunoHandoff(handoff.id)?.status, "READY_FOR_SUNO");
  assert.equal(store.recentSunoHandoffs().length, 1);
  db.close();
});
