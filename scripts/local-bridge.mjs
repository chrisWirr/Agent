import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { Readable } from "node:stream";
import { timingSafeEqual } from "node:crypto";
import { readPublicPage, searchPublicWeb } from "../src/autonomy/research.ts";
import {
  musicCapabilities,
  submitMusicJob,
  musicMetrics
} from "./music-publisher.mjs";

const tokenFile = process.env.OPENCLAW_GATEWAY_TOKEN_FILE;
if (!tokenFile) throw new Error("OPENCLAW_GATEWAY_TOKEN_FILE is required");
const token = readFileSync(tokenFile, "utf8").trim();
const port = Number(process.env.AGENT_BRIDGE_PORT || 18788);

function authorized(value) {
  if (typeof value !== "string" || !value.startsWith("Bearer ")) return false;
  const provided = Buffer.from(value.slice(7));
  const expected = Buffer.from(token);
  return (
    provided.length === expected.length && timingSafeEqual(provided, expected)
  );
}

createServer(async (request, response) => {
  if (!authorized(request.headers.authorization)) {
    response.writeHead(401).end("Unauthorized");
    return;
  }

  const url = new URL(request.url || "/", "http://localhost");
  if (url.pathname.startsWith("/music/")) {
    try {
      let result;
      if (url.pathname === "/music/capabilities" && request.method === "GET")
        result = await musicCapabilities();
      else if (
        request.method === "POST" &&
        ["/music/jobs", "/music/metrics"].includes(url.pathname)
      ) {
        const chunks = [];
        let size = 0;
        for await (const chunk of request) {
          size += chunk.length;
          if (size > 9_000_000) throw new Error("PAYLOAD_TOO_LARGE");
          chunks.push(chunk);
        }
        const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        result =
          url.pathname === "/music/jobs"
            ? await submitMusicJob(body)
            : await musicMetrics(body.videoIds);
      } else {
        response.writeHead(404).end("Not found");
        return;
      }
      response.writeHead(200, {
        "content-type": "application/json",
        "cache-control": "no-store"
      });
      response.end(JSON.stringify(result));
    } catch {
      response
        .writeHead(400, { "content-type": "application/json" })
        .end(JSON.stringify({ error: "MUSIC_REQUEST_FAILED" }));
    }
    return;
  }
  if (url.pathname === "/research/search" && request.method === "GET") {
    const query = url.searchParams.get("q")?.slice(0, 160) || "";
    if (!query) {
      response.writeHead(400).end("Missing query");
      return;
    }
    try {
      const hits = await searchPublicWeb(query);
      response.writeHead(200, {
        "content-type": "application/json; charset=utf-8",
        "cache-control": "no-store"
      });
      response.end(JSON.stringify(hits));
    } catch {
      response.writeHead(502).end("Search unavailable");
    }
    return;
  }

  if (url.pathname === "/research/read" && request.method === "GET") {
    const sourceUrl = url.searchParams.get("url")?.slice(0, 2048) || "";
    try {
      const page = await readPublicPage(sourceUrl);
      response.writeHead(200, {
        "content-type": "application/json; charset=utf-8",
        "cache-control": "no-store"
      });
      response.end(JSON.stringify(page));
    } catch {
      response.writeHead(502).end("Page unavailable");
    }
    return;
  }

  if (!url.pathname.startsWith("/v1/")) {
    response.writeHead(404).end("Not found");
    return;
  }

  try {
    const headers = new Headers();
    for (const [name, value] of Object.entries(request.headers)) {
      if (
        typeof value === "string" &&
        !["host", "connection", "content-length"].includes(name)
      ) {
        headers.set(name, value);
      }
    }
    const upstream = await fetch(
      `http://127.0.0.1:18789${url.pathname}${url.search}`,
      {
        method: request.method,
        headers,
        body: ["GET", "HEAD"].includes(request.method || "GET")
          ? undefined
          : request,
        duplex: "half"
      }
    );
    const responseHeaders = Object.fromEntries(
      [...upstream.headers].filter(
        ([name]) => !["connection", "transfer-encoding"].includes(name)
      )
    );
    response.writeHead(upstream.status, responseHeaders);
    if (upstream.body) Readable.fromWeb(upstream.body).pipe(response);
    else response.end();
  } catch {
    response.writeHead(502).end("Gateway unavailable");
  }
}).listen(port, "127.0.0.1", () => {
  console.log(`Agent local bridge listening on 127.0.0.1:${port}`);
});
