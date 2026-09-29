import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";

test("YouTube resumes a lost upload response without creating a duplicate, then checks public visibility", async () => {
  const folder = await mkdtemp(path.join(tmpdir(), "root-publisher-test-"));
  process.env.AGENT_MUSIC_DIR = folder;
  process.env.AGENT_YOUTUBE_CONFIG = path.join(folder, "credentials.json");
  const channelId = `UC${"a".repeat(22)}`;
  await writeFile(
    process.env.AGENT_YOUTUBE_CONFIG,
    JSON.stringify({
      clientId: "test",
      clientSecret: "test",
      refreshToken: "test",
      channelId
    })
  );
  const renderId = "b".repeat(64);
  await mkdir(path.join(folder, renderId));
  await writeFile(
    path.join(folder, renderId, "full.mp4"),
    "fake video bytes for mocked transport"
  );
  const payload = {
    id: "c".repeat(64),
    renderId,
    audioHash: "d".repeat(64),
    channelId,
    kind: "YOUTUBE_FULL",
    artistName: "Test",
    title: "Test song",
    campaign: {
      title: "Test song",
      description: "Description",
      shorts: [
        { hook: "One", caption: "One" },
        { hook: "Two", caption: "Two" }
      ]
    }
  };
  const originalFetch = globalThis.fetch;
  let inserts = 0;
  let committed = false;
  let publicVideo = false;
  globalThis.fetch = async (url, init = {}) => {
    const address = String(url);
    if (address.includes("oauth2.googleapis.com"))
      return Response.json({ access_token: "test-token" });
    if (address.includes("/channels?"))
      return Response.json({ items: [{ id: channelId }] });
    if (address.includes("/upload/youtube/")) {
      inserts++;
      return new Response(null, {
        status: 200,
        headers: { location: "https://www.googleapis.com/test-upload-session" }
      });
    }
    if (address.endsWith("/test-upload-session")) {
      if (init.headers["Content-Length"] === "0")
        return committed
          ? Response.json({ id: "abcdefghijk" })
          : new Response(null, { status: 308 });
      committed = true;
      init.body.destroy();
      throw new Error("Simulated lost network response after commit");
    }
    if (address.includes("/videos?"))
      return Response.json({
        items: [
          {
            status: {
              uploadStatus: "processed",
              privacyStatus: publicVideo ? "public" : "private"
            }
          }
        ]
      });
    throw new Error("Unexpected network request");
  };
  try {
    const { submitMusicJob } = await import("./music-publisher.mjs");
    const readJob = async () =>
      JSON.parse(
        await readFile(path.join(folder, payload.id, "job.json"), "utf8")
      );
    const settled = async () => {
      for (let i = 0; i < 100; i++) {
        const job = await readJob();
        if (job.status !== "RUNNING") return job;
        await delay(10);
      }
      throw new Error("Job did not settle");
    };
    await submitMusicJob(payload);
    assert.equal((await settled()).status, "BLOCKED");
    await submitMusicJob(payload);
    const privateJob = await settled();
    assert.equal(privateJob.error, "YOUTUBE_PRIVATE_RESTRICTION");
    assert.equal(privateJob.remoteId, "abcdefghijk");
    assert.equal(inserts, 1);
    publicVideo = true;
    await submitMusicJob(payload);
    assert.equal((await settled()).status, "SUCCEEDED");
    assert.equal((await submitMusicJob(payload)).status, "SUCCEEDED");
    assert.equal(inserts, 1);
    await assert.rejects(
      submitMusicJob({ ...payload, channelId: `UC${"b".repeat(22)}` }),
      /JOB_INPUT_CHANGED/
    );
  } finally {
    globalThis.fetch = originalFetch;
    await rm(folder, { recursive: true, force: true });
  }
});
