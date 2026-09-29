import { mkdir, readFile, writeFile, rename, stat } from "node:fs/promises";
import { createReadStream, existsSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";

const root =
  process.env.AGENT_MUSIC_DIR ||
  path.join(homedir(), ".local/share/agent-music");
const credentialPath =
  process.env.AGENT_YOUTUBE_CONFIG ||
  path.join(homedir(), ".config/agent-autonomy/youtube.json");
const active = new Set();
const accepting = new Set();
let busy = false;
const idPattern = /^[a-f0-9]{64}$/;

async function ffmpegPath() {
  if (process.env.AGENT_FFMPEG && existsSync(process.env.AGENT_FFMPEG))
    return process.env.AGENT_FFMPEG;
  if (existsSync("/usr/bin/ffmpeg")) return "/usr/bin/ffmpeg";
  const binary = path.join(
    homedir(),
    ".local/share/agent-media-runtime/system/usr/bin/ffmpeg"
  );
  return existsSync(binary) ? binary : null;
}

async function credentials() {
  try {
    const data = JSON.parse(await readFile(credentialPath, "utf8"));
    return data.clientId &&
      data.clientSecret &&
      data.refreshToken &&
      /^UC[\w-]{22}$/.test(data.channelId)
      ? data
      : null;
  } catch {
    return null;
  }
}

export async function musicCapabilities() {
  const config = await credentials();
  return {
    rendererReady: Boolean(await ffmpegPath()),
    youtubeConfigured: Boolean(config),
    channelId: config?.channelId ?? null,
    spotifyConfigured: false,
    spotifyReason: "DISTRIBUTOR_API_REQUIRED",
    instagramConfigured: false,
    tiktokConfigured: false
  };
}

async function save(file, value) {
  await writeFile(`${file}.tmp`, JSON.stringify(value), { mode: 0o600 });
  await rename(`${file}.tmp`, file);
}

function publicJob(job) {
  return {
    status: job.status,
    ...(job.error ? { error: job.error } : {}),
    ...(job.remoteId
      ? {
          remoteId: job.remoteId,
          url: `https://www.youtube.com/watch?v=${job.remoteId}`
        }
      : {})
  };
}

async function accessToken(config) {
  const response = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    body: new URLSearchParams({
      client_id: config.clientId,
      client_secret: config.clientSecret,
      refresh_token: config.refreshToken,
      grant_type: "refresh_token"
    }),
    signal: AbortSignal.timeout(20000)
  });
  if (!response.ok) throw new Error("YOUTUBE_AUTH_REQUIRED");
  const result = await response.json();
  if (!result.access_token) throw new Error("YOUTUBE_AUTH_REQUIRED");
  return result.access_token;
}

async function youtubeRead(token, resource, params) {
  const response = await fetch(
    `https://www.googleapis.com/youtube/v3/${resource}?${new URLSearchParams(params)}`,
    {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(20000)
    }
  );
  if (!response.ok)
    throw new Error(
      response.status === 401
        ? "YOUTUBE_AUTH_REQUIRED"
        : "YOUTUBE_API_UNAVAILABLE"
    );
  return response.json();
}

async function verifiedToken(config) {
  const token = await accessToken(config);
  const channels = await youtubeRead(token, "channels", {
    part: "id",
    mine: "true"
  });
  if (!channels.items?.some((item) => item.id === config.channelId))
    throw new Error("YOUTUBE_CHANNEL_MISMATCH");
  return token;
}

function run(binary, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(binary, args, {
      stdio: ["ignore", "ignore", "ignore"]
    });
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
    }, 15 * 60000);
    child.once("error", () => {
      clearTimeout(timer);
      reject(new Error("RENDER_FAILED"));
    });
    child.once("exit", (code) => {
      clearTimeout(timer);
      code === 0 ? resolve() : reject(new Error("RENDER_FAILED"));
    });
  });
}

async function render(job, folder) {
  const binary = await ffmpegPath();
  if (!binary) throw new Error("RENDERER_MISSING");
  const input = path.join(folder, "audio.mp3");
  if (!existsSync(input)) throw new Error("AUDIO_MISSING");
  const font = "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf";
  if (!existsSync(font)) throw new Error("FONT_MISSING");
  const text = `${job.payload.artistName}\n${job.payload.title}`;
  await writeFile(path.join(folder, "title.txt"), text.slice(0, 180));
  for (let index = 0; index < 3; index++) {
    const short = index > 0;
    const width = short ? 720 : 1280;
    const height = short ? 1280 : 720;
    const hookPath = path.join(folder, `hook-${index}.txt`);
    const hook = short
      ? job.payload.campaign.shorts[index - 1].hook
      : "Original song · AI-assisted production";
    // Files, not filter expressions, carry model-written text. expansion=none disables substitutions.
    await writeFile(
      hookPath,
      hook.match(/.{1,30}(?:\s|$)|.{1,30}/g)?.join("\n") ?? hook
    );
    const overlay = `[0:a]showwaves=s=${width}x200:mode=line:colors=0x56d6c4:rate=25[wave];color=c=0x101526:s=${width}x${height}:r=25[bg];[bg][wave]overlay=0:${Math.round(height * 0.58)}:shortest=1,drawtext=fontfile=${font}:textfile=${path.join(folder, "title.txt")}:expansion=none:fontcolor=white:fontsize=${short ? 26 : 32}:x=(w-text_w)/2:y=h*0.18,drawtext=fontfile=${font}:textfile=${hookPath}:expansion=none:fontcolor=0x56d6c4:fontsize=${short ? 28 : 26}:x=(w-text_w)/2:y=h*0.35[v]`;
    const output = path.join(
      folder,
      index === 0 ? "full.mp4" : `short-${index}.mp4`
    );
    await run(binary, [
      "-y",
      "-nostdin",
      ...(short
        ? ["-ss", String(job.payload.campaign.shorts[index - 1].startSeconds)]
        : []),
      "-i",
      input,
      "-filter_complex",
      overlay,
      "-map",
      "[v]",
      "-map",
      "0:a",
      "-c:v",
      "libx264",
      "-preset",
      "veryfast",
      "-crf",
      "24",
      "-pix_fmt",
      "yuv420p",
      "-threads",
      "2",
      "-c:a",
      "aac",
      "-b:a",
      "192k",
      "-movflags",
      "+faststart",
      ...(short ? ["-t", "25"] : []),
      "-shortest",
      output
    ]);
  }
}

async function upload(job, file, folder) {
  const config = await credentials();
  if (!config) throw new Error("YOUTUBE_NOT_CONNECTED");
  if (config.channelId !== job.payload.channelId)
    throw new Error("YOUTUBE_CHANNEL_MISMATCH");
  const token = await verifiedToken(config);
  if (!job.remoteId) {
    const renderFolder = path.join(root, job.payload.renderId);
    const shortIndex =
      job.payload.kind === "YOUTUBE_SHORT_1"
        ? 1
        : job.payload.kind === "YOUTUBE_SHORT_2"
          ? 2
          : 0;
    const video = path.join(
      renderFolder,
      shortIndex ? `short-${shortIndex}.mp4` : "full.mp4"
    );
    const size = (await stat(video)).size;
    if (!job.sessionUrl) {
      const campaign = job.payload.campaign;
      const title = (
        shortIndex
          ? campaign.shorts[shortIndex - 1].hook
          : `${job.payload.artistName} – ${campaign.title}`
      ).slice(0, 100);
      const description =
        `${shortIndex ? campaign.shorts[shortIndex - 1].caption : campaign.description}\n\n${job.payload.artistName} – ${job.payload.title}\nAI-assisted music and vocals.\n${shortIndex && job.payload.fullUrl ? `Full song: ${job.payload.fullUrl}` : ""}`.slice(
          0,
          4900
        );
      const response = await fetch(
        "https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&part=snippet,status",
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
            "X-Upload-Content-Type": "video/mp4",
            "X-Upload-Content-Length": String(size)
          },
          body: JSON.stringify({
            snippet: {
              title,
              description,
              categoryId: "10",
              defaultLanguage: "en"
            },
            status: {
              privacyStatus: "public",
              selfDeclaredMadeForKids: false,
              containsSyntheticMedia: true
            }
          }),
          signal: AbortSignal.timeout(30000)
        }
      );
      if (!response.ok) throw new Error("YOUTUBE_UPLOAD_INIT_FAILED");
      const location = response.headers.get("location");
      if (
        !location ||
        new URL(location).hostname !== "www.googleapis.com" ||
        new URL(location).protocol !== "https:"
      )
        throw new Error("YOUTUBE_SESSION_INVALID");
      job.sessionUrl = location;
      await save(file, job);
    }
    // Always query the saved session first. A lost PUT response must never cause another videos.insert.
    const progress = await fetch(job.sessionUrl, {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Length": "0",
        "Content-Range": `bytes */${size}`
      },
      signal: AbortSignal.timeout(30000)
    });
    if (progress.ok) {
      job.remoteId = (await progress.json()).id;
    } else if (progress.status === 308) {
      const range = progress.headers.get("range");
      const offset = range ? Number(range.match(/-(\d+)$/)?.[1] ?? -1) + 1 : 0;
      if (offset >= size) throw new Error("YOUTUBE_PROCESSING");
      const uploaded = await fetch(job.sessionUrl, {
        method: "PUT",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "video/mp4",
          "Content-Length": String(size - offset),
          "Content-Range": `bytes ${offset}-${size - 1}/${size}`
        },
        body: createReadStream(video, { start: offset }),
        duplex: "half",
        signal: AbortSignal.timeout(5 * 60000)
      });
      if (!uploaded.ok) throw new Error("YOUTUBE_UPLOAD_INTERRUPTED");
      job.remoteId = (await uploaded.json()).id;
    } else {
      throw new Error("YOUTUBE_UPLOAD_NEEDS_RECONCILIATION");
    }
    if (!/^[\w-]{11}$/.test(job.remoteId ?? ""))
      throw new Error("YOUTUBE_UPLOAD_NEEDS_RECONCILIATION");
    await save(file, job);
  }
  const result = await youtubeRead(token, "videos", {
    part: "status",
    id: job.remoteId
  });
  const status = result.items?.[0]?.status;
  if (!status) throw new Error("YOUTUBE_PROCESSING");
  if (["failed", "rejected", "deleted"].includes(status.uploadStatus))
    throw new Error("YOUTUBE_VIDEO_REJECTED");
  if (status.privacyStatus !== "public")
    throw new Error("YOUTUBE_PRIVATE_RESTRICTION");
  if (status.uploadStatus !== "processed")
    throw new Error("YOUTUBE_PROCESSING");
}

export async function submitMusicJob(payload) {
  if (!idPattern.test(payload?.id ?? "") || accepting.has(payload.id))
    throw new Error("JOB_BUSY_OR_INVALID");
  accepting.add(payload.id);
  try {
    return await submitMusicJobLocked(payload);
  } finally {
    accepting.delete(payload.id);
  }
}

async function submitMusicJobLocked(payload) {
  if (
    !payload ||
    !idPattern.test(payload.id) ||
    !idPattern.test(payload.renderId) ||
    !idPattern.test(payload.audioHash ?? "") ||
    !["RENDER", "YOUTUBE_FULL", "YOUTUBE_SHORT_1", "YOUTUBE_SHORT_2"].includes(
      payload.kind
    )
  )
    throw new Error("INVALID_JOB");
  const folder = path.join(root, payload.id);
  const file = path.join(folder, "job.json");
  await mkdir(folder, { recursive: true, mode: 0o700 });
  let job;
  try {
    job = JSON.parse(await readFile(file, "utf8"));
  } catch {
    /* new job */
  }
  if (
    job &&
    (job.payload.kind !== payload.kind ||
      job.payload.audioHash !== payload.audioHash ||
      job.payload.channelId !== payload.channelId)
  )
    throw new Error("JOB_INPUT_CHANGED");
  if (!job) {
    if (
      !payload.campaign?.shorts ||
      payload.campaign.shorts.length !== 2 ||
      typeof payload.artistName !== "string" ||
      typeof payload.title !== "string"
    )
      throw new Error("INVALID_JOB");
    if (payload.kind === "RENDER") {
      if (
        typeof payload.audioBase64 !== "string" ||
        payload.audioBase64.length > 8000000
      )
        throw new Error("AUDIO_MISSING");
      const bytes = Buffer.from(payload.audioBase64, "base64");
      if (
        createHash("sha256").update(bytes).digest("hex") !== payload.audioHash
      )
        throw new Error("AUDIO_HASH_MISMATCH");
      await writeFile(path.join(folder, "audio.mp3"), bytes, { mode: 0o600 });
    }
    const { audioBase64: _audio, ...safePayload } = payload;
    job = { status: "PENDING", payload: safePayload, attempts: 0 };
    await save(file, job);
  }
  if (
    job.status === "SUCCEEDED" ||
    job.status === "FAILED" ||
    active.has(payload.id) ||
    busy
  )
    return publicJob(job);
  busy = true;
  active.add(payload.id);
  job.status = "RUNNING";
  delete job.error;
  await save(file, job);
  void (async () => {
    try {
      if (payload.kind === "RENDER") await render(job, folder);
      else await upload(job, file, folder);
      job.status = "SUCCEEDED";
    } catch (error) {
      const code = /^[A-Z0-9_]+$/.test(error?.message ?? "")
        ? error.message
        : "PUBLISHER_TEMPORARY_FAILURE";
      const recoverable = [
        "YOUTUBE_NOT_CONNECTED",
        "YOUTUBE_AUTH_REQUIRED",
        "YOUTUBE_CHANNEL_MISMATCH",
        "RENDERER_MISSING",
        "FONT_MISSING",
        "YOUTUBE_PROCESSING",
        "YOUTUBE_PRIVATE_RESTRICTION"
      ].includes(code);
      if (!recoverable) job.attempts++;
      job.status =
        code === "YOUTUBE_UPLOAD_NEEDS_RECONCILIATION" ||
        code === "YOUTUBE_VIDEO_REJECTED" ||
        job.attempts >= 3
          ? "FAILED"
          : "BLOCKED";
      job.error = code;
    } finally {
      try {
        await save(file, job);
      } finally {
        active.delete(payload.id);
        busy = false;
      }
    }
  })().catch(() => {
    console.error("Music job persistence failed");
  });
  return publicJob(job);
}

export async function musicMetrics(videoIds) {
  if (
    !Array.isArray(videoIds) ||
    videoIds.length > 3 ||
    !videoIds.every((id) => /^[\w-]{11}$/.test(id))
  )
    throw new Error("INVALID_IDS");
  const config = await credentials();
  if (!config) throw new Error("YOUTUBE_NOT_CONNECTED");
  const token = await verifiedToken(config);
  const result = await youtubeRead(token, "videos", {
    part: "statistics",
    id: videoIds.join(",")
  });
  let revenueUsd = null;
  let revenueNote = "Kein Abrechnungszugang verbunden; Umsatz unbekannt.";
  if (config.revenueAccess) {
    const startDate = new Date(Date.now() - 28 * 86400000)
      .toISOString()
      .slice(0, 10);
    const endDate = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
    try {
      const reportResponse = await fetch(
        `https://youtubeanalytics.googleapis.com/v2/reports?${new URLSearchParams({ ids: "channel==MINE", startDate, endDate, metrics: "estimatedRevenue", filters: `video==${videoIds.join(",")}`, currency: "USD" })}`,
        {
          headers: { Authorization: `Bearer ${token}` },
          signal: AbortSignal.timeout(20000)
        }
      );
      if (!reportResponse.ok) throw new Error("REPORT_UNAVAILABLE");
      const report = await reportResponse.json();
      const column =
        report.columnHeaders?.findIndex(
          (item) => item.name === "estimatedRevenue"
        ) ?? -1;
      if (
        column >= 0 &&
        report.rows?.length &&
        report.rows.every(
          (row) =>
            typeof row[column] === "number" &&
            Number.isFinite(row[column]) &&
            row[column] >= 0
        )
      ) {
        revenueUsd = report.rows.reduce((sum, row) => sum + row[column], 0);
        revenueNote = `YouTube-Schätzung für ${startDate} bis ${endDate}; keine bestätigte Auszahlung.`;
      } else
        revenueNote =
          "YouTube liefert noch keinen Erlösbericht für diese Videos.";
    } catch {
      revenueNote = "Erlösbericht nicht abrufbar; Umsatz unbekannt.";
    }
  }
  return {
    fetchedAt: new Date().toISOString(),
    videos: (result.items ?? []).map((item) => ({
      id: item.id,
      views: Number(item.statistics?.viewCount ?? 0),
      likes: Number(item.statistics?.likeCount ?? 0),
      comments: Number(item.statistics?.commentCount ?? 0)
    })),
    revenueUsd,
    revenueNote
  };
}
