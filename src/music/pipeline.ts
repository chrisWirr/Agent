import { z } from "zod";
import { AutonomyStore } from "../autonomy/store";
import { createModelRunner } from "../autonomy/model";
import {
  finishReleaseJob,
  generateCampaign,
  makeRelease,
  nextReleaseJob,
  type Release
} from "./release";

const remoteJobSchema = z.object({
  status: z.enum(["PENDING", "RUNNING", "SUCCEEDED", "BLOCKED", "FAILED"]),
  error: z
    .string()
    .regex(/^[A-Z0-9_]+$/)
    .optional(),
  remoteId: z
    .string()
    .regex(/^[a-zA-Z0-9_-]{11}$/)
    .optional(),
  url: z
    .string()
    .url()
    .startsWith("https://www.youtube.com/watch?v=")
    .optional()
});

export async function releaseBridge(
  env: Env,
  path: string,
  body?: unknown
): Promise<unknown> {
  if (!env.OPENCLAW_BASE_URL || !env.OPENCLAW_GATEWAY_TOKEN)
    throw new Error("BRIDGE_UNCONFIGURED");
  const response = await fetch(`${env.OPENCLAW_BASE_URL}${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: {
      Authorization: `Bearer ${env.OPENCLAW_GATEWAY_TOKEN}`,
      "Content-Type": "application/json"
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(15000)
  });
  if (!response.ok) throw new Error("BRIDGE_UNAVAILABLE");
  return response.json();
}

export function ensureReleases(store: AutonomyStore) {
  for (const handoff of store.recentSunoHandoffs()) {
    if (!handoff.preparation) continue;
    const id = `release:${handoff.id}`;
    const existing = store.getRelease(id);
    if (!existing) store.saveRelease(makeRelease(handoff));
    else if (
      !existing.approvedAt &&
      existing.audioHash !== (handoff.submission?.audioEvidence?.sha256 ?? null)
    ) {
      store.saveRelease({
        ...existing,
        audioHash: handoff.submission?.audioEvidence?.sha256 ?? null
      });
    }
  }
}

export async function runReleaseTick(store: AutonomyStore, env: Env) {
  if (!store.tryAcquireReleaseTick()) return;
  try {
    ensureReleases(store);
    let generated = false;
    for (const snapshot of store.recentReleases()) {
      let release = store.getRelease(snapshot.id)!;
      if (release.paused) continue;
      if (
        release.campaignStatus === "GENERATING" &&
        Date.now() - (release.campaignStartedAt ?? 0) > 180000
      ) {
        release.campaignStatus = "FAILED";
        store.saveRelease(release);
      }
      if (
        !generated &&
        store.countEventsSince(
          "MUSIC_CAMPAIGN_ATTEMPT",
          Date.now() - 86400000
        ) < 2 &&
        !release.approvedAt &&
        ["PENDING", "FAILED"].includes(release.campaignStatus) &&
        release.campaignAttempts < 2
      ) {
        const handoff = store.getSunoHandoff(release.handoffId);
        if (!handoff) continue;
        generated = true;
        release = {
          ...release,
          campaignStatus: "GENERATING",
          campaignAttempts: release.campaignAttempts + 1,
          campaignStartedAt: Date.now()
        };
        store.saveRelease(release);
        store.recordEvent("MUSIC_CAMPAIGN_ATTEMPT", { releaseId: release.id });
        try {
          const campaign = await generateCampaign(
            handoff,
            createModelRunner(env)
          );
          release = {
            ...store.getRelease(release.id)!,
            campaign,
            campaignStatus: "READY",
            updatedAt: new Date().toISOString()
          };
          store.recordEvent("MUSIC_CAMPAIGN_READY", { releaseId: release.id });
        } catch {
          release = {
            ...store.getRelease(release.id)!,
            campaignStatus: "FAILED"
          };
        }
        store.saveRelease(release);
      }
      const job = nextReleaseJob(release);
      if (job) {
        try {
          // Re-submitting a stable job ID resumes the same local job/session.
          const render = release.jobs.find((item) => item.kind === "RENDER")!;
          const full = release.jobs.find(
            (item) => item.kind === "YOUTUBE_FULL"
          );
          const response = remoteJobSchema.parse(
            await releaseBridge(env, "/music/jobs", {
              id: job.id,
              kind: job.kind,
              renderId: render.id,
              artistName: release.artistName,
              title: release.title,
              campaign: release.campaign,
              audioHash: release.audioHash,
              channelId: release.approval?.channelId,
              fullUrl: full?.url,
              ...(job.kind === "RENDER" && job.status !== "RUNNING"
                ? { audioBase64: store.getAudio(release.audioHash!) }
                : {})
            })
          );
          const current = store.getRelease(release.id)!;
          const updated = current.jobs.find((item) => item.id === job.id)!;
          Object.assign(updated, response, {
            nextAttemptAt:
              Date.now() + (response.status === "BLOCKED" ? 300000 : 60000)
          });
          release =
            response.status === "SUCCEEDED"
              ? finishReleaseJob(current, job.id)
              : current;
          store.saveRelease(release);
          if (response.status === "SUCCEEDED")
            store.recordEvent("MUSIC_RELEASE_STEP_COMPLETED", {
              releaseId: release.id,
              kind: job.kind,
              url: response.url
            });
        } catch {
          const current = store.getRelease(release.id)!;
          const updated = current.jobs.find((item) => item.id === job.id)!;
          updated.attempts++;
          updated.error = "BRIDGE_UNAVAILABLE";
          updated.status = "BLOCKED";
          updated.nextAttemptAt =
            Date.now() +
            Math.min(3600000, 60000 * 2 ** Math.min(updated.attempts, 6));
          store.saveRelease(current);
        }
      }
      release = store.getRelease(release.id)!;
      const videoIds = release.jobs
        .filter((item) => item.status === "SUCCEEDED" && item.remoteId)
        .map((item) => item.remoteId!);
      if (
        release.approvedAt &&
        !release.paused &&
        videoIds.length &&
        release.nextMetricsAt <= Date.now()
      ) {
        release.nextMetricsAt = Date.now() + 86400000;
        store.saveRelease(release);
        try {
          const metrics = z
            .object({
              fetchedAt: z.string().datetime(),
              videos: z
                .array(
                  z.object({
                    id: z.string(),
                    views: z.number().nonnegative(),
                    likes: z.number().nonnegative(),
                    comments: z.number().nonnegative()
                  })
                )
                .max(3),
              revenueUsd: z.number().nonnegative().nullable(),
              revenueNote: z.string().max(300)
            })
            .parse(await releaseBridge(env, "/music/metrics", { videoIds }));
          store.saveRelease({ ...store.getRelease(release.id)!, metrics });
        } catch {
          // Keep the last observed values; an unavailable API is not zero revenue.
        }
      }
    }
  } finally {
    store.releaseReleaseTick();
  }
}

export function releaseSummary(release: Release) {
  return {
    id: release.id,
    title: release.title,
    approvedAt: release.approvedAt,
    paused: release.paused,
    campaignStatus: release.campaignStatus,
    jobs: release.jobs.map((job) => ({
      kind: job.kind,
      status: job.status,
      error: job.error,
      url: job.url
    })),
    metrics: release.metrics
  };
}
