// One-time local OAuth setup. Secrets are only read from / written to private files.
import { createServer } from "node:http";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { randomBytes, createHash, timingSafeEqual } from "node:crypto";
import { spawn } from "node:child_process";
import { homedir } from "node:os";
import path from "node:path";

const clientFile = process.argv[2];
const revenueAccess = process.argv.includes("--revenue");
if (!clientFile) {
  console.log(
    "Verwendung: node scripts/connect-youtube.mjs /pfad/zum/google-oauth-desktop-client.json"
  );
  console.log(
    "Einmalig im eigenen Google-Cloud-Projekt: YouTube Data API v3 aktivieren, OAuth-Desktop-Client anlegen und dessen JSON herunterladen."
  );
  process.exit(1);
}
const downloaded = JSON.parse(await readFile(clientFile, "utf8"));
const client = downloaded.installed;
if (!client?.client_id || !client.client_secret)
  throw new Error("Ein OAuth-Desktop-Client wird benötigt.");
const state = randomBytes(32).toString("hex");
const verifier = randomBytes(48).toString("base64url");
const challenge = createHash("sha256").update(verifier).digest("base64url");
const folder = path.join(homedir(), ".config/agent-autonomy");
let redirect;
let handling = false;
const server = createServer(async (request, response) => {
  const url = new URL(request.url, "http://127.0.0.1");
  const supplied = Buffer.from(url.searchParams.get("state") || "");
  const expected = Buffer.from(state);
  if (
    url.pathname !== "/callback" ||
    supplied.length !== expected.length ||
    !timingSafeEqual(supplied, expected) ||
    handling
  ) {
    response.writeHead(400).end("Invalid callback");
    return;
  }
  handling = true;
  try {
    if (!url.searchParams.get("code"))
      throw new Error("AUTHORIZATION_CANCELLED");
    const exchange = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      body: new URLSearchParams({
        code: url.searchParams.get("code"),
        client_id: client.client_id,
        client_secret: client.client_secret,
        redirect_uri: redirect,
        grant_type: "authorization_code",
        code_verifier: verifier
      }),
      signal: AbortSignal.timeout(30000)
    });
    if (!exchange.ok) throw new Error("TOKEN_EXCHANGE_FAILED");
    const tokens = await exchange.json();
    if (!tokens.refresh_token) throw new Error("OFFLINE_ACCESS_MISSING");
    const channelResponse = await fetch(
      "https://www.googleapis.com/youtube/v3/channels?part=id,snippet&mine=true",
      {
        headers: { Authorization: `Bearer ${tokens.access_token}` },
        signal: AbortSignal.timeout(30000)
      }
    );
    if (!channelResponse.ok) throw new Error("CHANNEL_LOOKUP_FAILED");
    const channels = await channelResponse.json();
    if (channels.items?.length !== 1)
      throw new Error("SELECT_EXACTLY_ONE_YOUTUBE_CHANNEL");
    const channel = channels.items[0];
    await mkdir(folder, { recursive: true, mode: 0o700 });
    await writeFile(
      path.join(folder, "youtube.json"),
      JSON.stringify({
        clientId: client.client_id,
        clientSecret: client.client_secret,
        refreshToken: tokens.refresh_token,
        channelId: channel.id,
        revenueAccess
      }),
      { mode: 0o600 }
    );
    response
      .writeHead(200, { "Content-Type": "text/plain; charset=utf-8" })
      .end("YouTube verbunden. Du kannst zum Music Studio zurückkehren.");
    console.log(
      `YouTube verbunden: ${channel.snippet.title} (${channel.id}). Zugangsdaten privat gespeichert.`
    );
  } catch (error) {
    console.error(
      "Anmeldung fehlgeschlagen:",
      /^[A-Z0-9_]+$/.test(error.message ?? "")
        ? error.message
        : "OAUTH_SETUP_FAILED"
    );
    response
      .writeHead(400)
      .end("Anmeldung fehlgeschlagen. Details im lokalen Terminal.");
  } finally {
    clearTimeout(timeout);
    server.close();
  }
});
const timeout = setTimeout(() => {
  console.error("Anmeldung abgelaufen; erneut starten.");
  server.close();
}, 10 * 60000);
server.listen(0, "127.0.0.1", () => {
  redirect = `http://127.0.0.1:${server.address().port}/callback`;
  const url = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  url.search = new URLSearchParams({
    client_id: client.client_id,
    redirect_uri: redirect,
    response_type: "code",
    access_type: "offline",
    prompt: "consent",
    state,
    code_challenge: challenge,
    code_challenge_method: "S256",
    scope:
      "https://www.googleapis.com/auth/youtube.upload https://www.googleapis.com/auth/youtube.readonly" +
      (revenueAccess
        ? " https://www.googleapis.com/auth/yt-analytics-monetary.readonly"
        : "")
  }).toString();
  console.log(
    "Öffne die Google-Anmeldung und wähle den Künstlerkanal. Angefragt: Videos hochladen und Kanal-/Videodaten lesen."
  );
  if (revenueAccess)
    console.log("Zusätzlich angefragt: YouTube-Erlösberichte lesen.");
  console.log(url.toString());
  const browser = spawn("xdg-open", [url.toString()], { stdio: "ignore" });
  browser.on("error", () =>
    console.log("Bitte den obenstehenden Link im Browser öffnen.")
  );
});
