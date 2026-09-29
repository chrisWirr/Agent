import assert from "node:assert/strict";
import { test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { AutonomyStore } from "../autonomy/store";
import type { SunoHandoff } from "./suno";
import {
  approveRelease,
  approvalBlockers,
  makeRelease,
  nextReleaseJob,
  finishReleaseJob
} from "./release";

const audioHash = "a".repeat(64);
const channelId = `UC${"a".repeat(22)}`;
function fixture() {
  const handoff: SunoHandoff = {
    id: "suno:test",
    sourceArtifactId: "song:1",
    sourceMissionId: "mission:1",
    title: "A Song",
    lyrics: "Original lyrics",
    preparation: null,
    status: "RELEASE_PROPOSED",
    submission: {
      handoffId: "suno:test",
      sunoUrl: "https://suno.com/song/test",
      listeningNotes: "Human approved listening notes for this song.",
      rightsBasis: "PAID_AT_CREATION",
      audioEvidence: {
        filename: "song.mp3",
        sha256: audioHash,
        byteLength: 3,
        transcript: "Original lyrics"
      }
    },
    audit: {
      decision: "RELEASE_CANDIDATE",
      summary: "The submitted evidence supports this candidate.",
      lyricFidelity: "Reported words match the text.",
      strengths: [],
      issues: [],
      uncertainties: [],
      releaseProposal: "Publish"
    },
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };
  const release = makeRelease(handoff);
  release.campaign = {
    version: "v1",
    title: "A Song",
    description: "Original song",
    shorts: [
      { hook: "One", caption: "First", startSeconds: 0 },
      { hook: "Two", caption: "Second", startSeconds: 5 }
    ],
    rationale: "Test one channel",
    createdAt: new Date().toISOString()
  };
  release.campaignStatus = "READY";
  const approval = {
    handoffId: handoff.id,
    artistName: "Test Artist",
    rightsConfirmed: true,
    authorizePublication: true,
    audioHash,
    campaignVersion: "v1",
    channelId
  };
  return { release, handoff, approval };
}

test("publication requires audited audio, commercial rights and exact campaign approval", async () => {
  const { release, handoff, approval } = fixture();
  assert.deepEqual(approvalBlockers(release, handoff, true), []);
  await assert.rejects(
    approveRelease(release, handoff, false, approval),
    /RELEASE_NOT_READY/
  );
  await assert.rejects(
    approveRelease(
      release,
      { ...handoff, status: "FAILED", audit: null },
      true,
      approval
    ),
    /RELEASE_NOT_READY/
  );
  await assert.rejects(
    approveRelease(
      release,
      {
        ...handoff,
        submission: { ...handoff.submission!, rightsBasis: "FREE" }
      },
      true,
      approval
    ),
    /RELEASE_NOT_READY/
  );
  await assert.rejects(
    approveRelease(release, handoff, true, {
      ...approval,
      audioHash: "b".repeat(64)
    }),
    /STALE_APPROVAL/
  );
  await assert.rejects(
    approveRelease(release, handoff, true, {
      ...approval,
      campaignVersion: "old"
    }),
    /STALE_APPROVAL/
  );
  const result = await approveRelease(release, handoff, true, approval);
  assert.equal(result.approval?.channelId, channelId);
  assert.equal(result.jobs.length, 4);
  await assert.rejects(
    approveRelease(result, handoff, true, approval),
    /ALREADY_APPROVED/
  );
});

test("jobs survive repeated approvals deterministically, respect pauses, and schedule promotion after actual publication", async () => {
  const { release, handoff, approval } = fixture();
  const a = await approveRelease(release, handoff, true, approval);
  const b = await approveRelease(release, handoff, true, approval);
  assert.deepEqual(
    a.jobs.map((j) => j.id),
    b.jobs.map((j) => j.id)
  );
  assert.equal(nextReleaseJob(release), undefined);
  assert.equal(nextReleaseJob({ ...a, paused: true }), undefined);
  assert.equal(nextReleaseJob(a)?.kind, "RENDER");
  const rendered = finishReleaseJob(a, a.jobs[0].id);
  assert.equal(nextReleaseJob(rendered)?.kind, "YOUTUBE_FULL");
  const now = Date.now();
  const published = finishReleaseJob(rendered, a.jobs[1].id, now);
  assert.equal(nextReleaseJob(published, now + 86400000), undefined);
  assert.equal(
    nextReleaseJob(published, now + 2 * 86400000)?.kind,
    "YOUTUBE_SHORT_1"
  );
  const firstShort = finishReleaseJob(
    published,
    a.jobs[2].id,
    now + 2 * 86400000
  );
  assert.equal(nextReleaseJob(firstShort, now + 3 * 86400000), undefined);
  assert.equal(
    nextReleaseJob(firstShort, now + 5 * 86400000)?.kind,
    "YOUTUBE_SHORT_2"
  );
  assert.equal(nextReleaseJob({ ...a, audioHash: "b".repeat(64) }), undefined);
});

test("release and retained audio persist in SQLite, with one pipeline lease", () => {
  const db = new DatabaseSync(":memory:");
  const store = new AutonomyStore(
    <T>(
      strings: TemplateStringsArray,
      ...values: (string | number | boolean | null)[]
    ) => {
      const sql = strings.reduce(
        (text, part, index) => text + part + (index < values.length ? "?" : ""),
        ""
      );
      return db
        .prepare(sql)
        .all(
          ...values.map((v) => (typeof v === "boolean" ? Number(v) : v))
        ) as T[];
    }
  );
  store.initialize();
  const { release } = fixture();
  store.saveRelease(release);
  assert.equal(store.getRelease(release.id)?.title, release.title);
  const base64 = Buffer.alloc(350000, 42).toString("base64");
  store.saveAudio(audioHash, base64);
  store.saveAudio(audioHash, base64);
  assert.equal(store.hasAudio(audioHash), true);
  assert.equal(store.getAudio(audioHash), base64);
  assert.equal(store.tryAcquireReleaseTick(), true);
  assert.equal(store.tryAcquireReleaseTick(), false);
  store.releaseReleaseTick();
  assert.equal(store.tryAcquireReleaseTick(), true);
  db.close();
});
