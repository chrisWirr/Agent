import { useEffect, useState } from "react";
import { Button, Surface, Badge } from "@cloudflare/kumo";
import type {
  Release,
  RELEASE_STRATEGY,
  distributionPacket
} from "./music/release";

export type ReleaseView = Release & {
  blockers: string[];
  hasAudio: boolean;
  distributionPacket: ReturnType<typeof distributionPacket>;
};
type Capabilities = {
  rendererReady: boolean;
  youtubeConfigured: boolean;
  channelId: string | null;
  error?: string;
};
const labels: Record<string, string> = {
  AUDIT_NOT_APPROVED: "Song-Audit noch nicht freigegeben",
  RIGHTS_UNCONFIRMED: "Kommerzielle Nutzungsrechte noch ungeklärt",
  AUDIO_MISSING: "Die ausgewählte MP3 fehlt im Veröffentlichungsspeicher",
  CAMPAIGN_NOT_READY: "Kampagne wird vorbereitet",
  RENDER: "Visualizer und zwei Kurzvideos erzeugen",
  YOUTUBE_FULL: "Vollständigen Song veröffentlichen",
  YOUTUBE_SHORT_1: "Ersten Short veröffentlichen · Tag 2",
  YOUTUBE_SHORT_2: "Zweiten Short veröffentlichen · Tag 5",
  PENDING: "Wartet",
  RUNNING: "Läuft",
  SUCCEEDED: "Fertig",
  BLOCKED: "Voraussetzung fehlt",
  FAILED: "Fehlgeschlagen",
  YOUTUBE_PRIVATE_RESTRICTION:
    "YouTube hat das Video privat gehalten. Der API-Zugang benötigt möglicherweise eine Freischaltung.",
  BRIDGE_UNAVAILABLE:
    "Der lokale Veröffentlichungsdienst ist nicht erreichbar.",
  YOUTUBE_NOT_CONNECTED: "YouTube-Konto noch nicht verbunden.",
  YOUTUBE_AUTH_REQUIRED: "YouTube-Anmeldung muss erneuert werden.",
  YOUTUBE_PROCESSING: "YouTube verarbeitet das Video noch.",
  YOUTUBE_UPLOAD_NEEDS_RECONCILIATION:
    "Uploadstatus unklar. Keine erneute Veröffentlichung, bis die bestehende Upload-Sitzung geprüft ist."
};

function ReleaseCard({
  release,
  token,
  capabilities,
  refresh
}: {
  release: ReleaseView;
  token: string;
  capabilities: Capabilities | null;
  refresh: () => Promise<void>;
}) {
  const [artistName, setArtistName] = useState(release.artistName);
  const [approved, setApproved] = useState(false);
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [audio, setAudio] = useState<File | null>(null);
  const request = async (path: string, body: unknown) => {
    const response = await fetch(path, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify(body)
    });
    const result = (await response.json()) as {
      accepted?: boolean;
      error?: string;
      reason?: string;
    };
    if (!response.ok || !result.accepted)
      throw new Error(result.reason ?? result.error ?? "Aktion fehlgeschlagen");
  };
  const act = async (fn: () => Promise<void>) => {
    setBusy(true);
    setMessage("");
    try {
      await fn();
      await refresh();
    } catch (error) {
      setMessage(
        error instanceof Error ? error.message : "Aktion fehlgeschlagen"
      );
    } finally {
      setBusy(false);
    }
  };
  return (
    <Surface className="rounded-xl border border-kumo-line bg-kumo-base p-5 space-y-4">
      <div className="flex flex-wrap justify-between gap-2">
        <h3 className="text-lg font-semibold">{release.title}</h3>
        <Badge variant="secondary">
          {release.paused
            ? "Pausiert"
            : release.approvedAt
              ? "Freigegeben"
              : "Vorbereitung"}
        </Badge>
      </div>
      {release.campaign ? (
        <details open={!release.approvedAt}>
          <summary className="cursor-pointer font-semibold">
            Vermarktungsplan und vorbereitete Texte
          </summary>
          <p className="my-3 text-sm">{release.campaign.rationale}</p>
          <h4 className="font-semibold">{release.campaign.title}</h4>
          <p className="whitespace-pre-wrap text-sm">
            {release.campaign.description}
          </p>
          <div className="mt-3 grid gap-3 sm:grid-cols-2">
            {release.campaign.shorts.map((short, index) => (
              <div
                key={index}
                className="rounded-lg border border-kumo-line p-3 text-sm"
              >
                <strong>
                  Short {index + 1} · Tag {index === 0 ? 2 : 5}
                </strong>
                <p>{short.hook}</p>
                <p className="mt-2">{short.caption}</p>
                <p className="mt-2 text-kumo-subtle">
                  25 Sekunden ab {short.startSeconds} s; Testausschnitt, keine
                  verifizierte Refrainmarke.
                </p>
              </div>
            ))}
          </div>
        </details>
      ) : (
        <p className="text-sm">
          {release.campaignStatus === "FAILED"
            ? "Die Kampagnenerstellung ist fehlgeschlagen. Der Fehler wird im nächsten zulässigen Versuch erneut geprüft."
            : "Das Marketing-Modul erstellt automatisch die Kampagne."}
        </p>
      )}
      <details>
        <summary className="cursor-pointer text-sm font-semibold">
          Spotify-Vertriebspaket · wartet auf Anbindung
        </summary>
        <p className="mt-2 text-sm">{release.distributionPacket.note}</p>
        <ul className="mt-2 list-disc pl-5 text-sm">
          {release.distributionPacket.missing.map((item) => (
            <li key={item}>{item}</li>
          ))}
        </ul>
        <Button
          className="mt-3"
          variant="secondary"
          onClick={() => {
            const url = URL.createObjectURL(
              new Blob([JSON.stringify(release.distributionPacket, null, 2)], {
                type: "application/json"
              })
            );
            const link = document.createElement("a");
            link.href = url;
            link.download = "distribution-packet.json";
            link.click();
            setTimeout(() => URL.revokeObjectURL(url), 1000);
          }}
        >
          Vorbereitetes Paket herunterladen
        </Button>
      </details>
      {!release.hasAudio && release.audioHash && (
        <form
          className="space-y-2 border-t border-kumo-line pt-3"
          onSubmit={(event) => {
            event.preventDefault();
            void act(async () => {
              if (!audio) return;
              const data = new FormData();
              data.set("handoffId", release.handoffId);
              data.set("audio", audio);
              const response = await fetch("/admin/release/audio", {
                method: "POST",
                headers: { Authorization: `Bearer ${token}` },
                body: data
              });
              if (!response.ok)
                throw new Error(
                  "Bitte dieselbe MP3 wie bei der Song-Abgabe verwenden (max. 6 MB)."
                );
              setMessage("Originaldatei gespeichert.");
            });
          }}
        >
          <label className="block text-sm">
            Frühere Abgaben enthielten nur ein Transkript. Einmal dieselbe
            ausgewählte MP3 ergänzen:
            <input
              className="mt-2 block"
              type="file"
              accept=".mp3,audio/mpeg"
              required
              onChange={(event) => setAudio(event.target.files?.[0] ?? null)}
            />
          </label>
          <Button type="submit" disabled={busy || !audio}>
            MP3 speichern
          </Button>
        </form>
      )}
      {!release.approvedAt && (
        <form
          className="space-y-3 border-t border-kumo-line pt-4"
          onSubmit={(event) => {
            event.preventDefault();
            void act(async () => {
              await request("/admin/release/approve", {
                handoffId: release.handoffId,
                artistName,
                rightsConfirmed: true,
                authorizePublication: true,
                audioHash: release.audioHash,
                campaignVersion: release.campaign?.version,
                channelId: capabilities?.channelId
              });
              setMessage(
                "Freigegeben. Veröffentlichung und Promotion laufen ab jetzt automatisch."
              );
            });
          }}
        >
          <label className="block text-sm">
            Künstlername für die Veröffentlichung
            <input
              className="mt-1 w-full rounded-lg border border-kumo-line bg-kumo-elevated p-2"
              value={artistName}
              minLength={2}
              maxLength={80}
              required
              onChange={(event) => setArtistName(event.target.value)}
            />
          </label>
          {release.blockers.length > 0 && (
            <ul className="list-disc pl-5 text-sm">
              {release.blockers.map((blocker) => (
                <li key={blocker}>{labels[blocker] ?? blocker}</li>
              ))}
            </ul>
          )}
          <label className="flex items-start gap-2 text-sm">
            <input
              type="checkbox"
              checked={approved}
              onChange={(event) => setApproved(event.target.checked)}
              className="mt-1"
            />
            <span>
              Ich gebe diese Songversion und Kampagne für die öffentliche
              Veröffentlichung auf dem verbundenen YouTube-Kanal frei und
              bestätige die nötigen Rechte. ROOT darf daraus den Visualizer und
              zwei Shorts veröffentlichen. Werbebudget: 0 €.
            </span>
          </label>
          <Button
            type="submit"
            variant="primary"
            disabled={
              busy ||
              !approved ||
              artistName.trim().length < 2 ||
              release.blockers.length > 0 ||
              !capabilities?.youtubeConfigured ||
              !capabilities.rendererReady
            }
          >
            Song freigeben & automatisch veröffentlichen
          </Button>
          {!capabilities?.youtubeConfigured && (
            <p className="text-sm text-kumo-subtle">
              Einmalige Einrichtung nötig: YouTube-Kanal mit Upload-Berechtigung
              verbinden.
            </p>
          )}
        </form>
      )}
      {release.approvedAt && (
        <>
          <ol className="space-y-3">
            {release.jobs.map((job) => (
              <li
                key={job.id}
                className="rounded-lg border border-kumo-line p-3 text-sm"
              >
                <div className="flex flex-wrap justify-between gap-2">
                  <strong>{labels[job.kind]}</strong>
                  <span>{labels[job.status]}</span>
                </div>
                {job.error && (
                  <p className="mt-2">{labels[job.error] ?? job.error}</p>
                )}
                {job.status === "PENDING" && job.nextAttemptAt > Date.now() && (
                  <p>
                    Frühestens:{" "}
                    {new Date(job.nextAttemptAt).toLocaleString("de-DE")}
                  </p>
                )}
                {job.url && (
                  <a
                    href={job.url}
                    target="_blank"
                    rel="noreferrer"
                    className="underline"
                  >
                    Video öffnen
                  </a>
                )}
              </li>
            ))}
          </ol>
          <Button
            variant="secondary"
            disabled={busy}
            onClick={() =>
              void act(() =>
                request("/admin/release/pause", {
                  id: release.id,
                  paused: !release.paused
                })
              )
            }
          >
            {release.paused
              ? "Automatik fortsetzen"
              : "Nächste Schritte pausieren"}
          </Button>
          <p className="text-xs text-kumo-subtle">
            Eine Pause hält neue Schritte an. Bereits laufende Uploads und
            veröffentlichte Videos bleiben bestehen.
          </p>
        </>
      )}
      <div className="border-t border-kumo-line pt-3 text-sm">
        <h4 className="font-semibold">Erfolg & Monetarisierung</h4>
        {release.metrics ? (
          <>
            <p>
              Zuletzt abgefragt:{" "}
              {new Date(release.metrics.fetchedAt).toLocaleString("de-DE")}
            </p>
            {release.metrics.videos.map((video) => (
              <p key={video.id}>
                {video.id}: {video.views} Views · {video.likes} Likes ·{" "}
                {video.comments} Kommentare
              </p>
            ))}
          </>
        ) : (
          <p>
            Nach Veröffentlichung werden täglich echte YouTube-Kennzahlen
            abgefragt.
          </p>
        )}
        <p>
          Umsatz:{" "}
          {release.metrics?.revenueUsd == null
            ? "unbekannt"
            : `${release.metrics.revenueUsd.toFixed(2)} USD (YouTube-Schätzung)`}
        </p>
        <p>
          {release.metrics?.revenueNote ?? "Noch kein Erlösbericht verfügbar."}
        </p>
      </div>
      {message && <output className="block text-sm">{message}</output>}
    </Surface>
  );
}

export default function ReleasePanel({
  releases,
  strategy,
  token,
  refresh
}: {
  releases: ReleaseView[];
  strategy: typeof RELEASE_STRATEGY;
  token: string;
  refresh: () => Promise<void>;
}) {
  const [capabilities, setCapabilities] = useState<Capabilities | null>(null);
  const [connectionError, setConnectionError] = useState("");
  useEffect(() => {
    const controller = new AbortController();
    void fetch("/admin/release-system", {
      headers: { Authorization: `Bearer ${token}` },
      signal: controller.signal
    })
      .then(async (response) => {
        if (!response.ok) throw new Error();
        const value = (await response.json()) as Capabilities;
        setCapabilities(value);
        setConnectionError(
          value.error ? "Veröffentlichungsdienst nicht erreichbar" : ""
        );
      })
      .catch(() => {
        if (!controller.signal.aborted)
          setConnectionError("Verbindungsstatus nicht abrufbar");
      });
    return () => controller.abort();
  }, [token, releases]);
  return (
    <section className="space-y-4">
      <h2 className="text-lg font-semibold">Veröffentlichung & Vermarktung</h2>
      <Surface className="rounded-xl border border-kumo-line bg-kumo-base p-5 space-y-3">
        <p className="font-semibold">
          Eine Songfreigabe. Danach übernimmt ROOT.
        </p>
        <p className="text-sm">
          {strategy.primary} {strategy.hypothesis}
        </p>
        <div className="grid gap-2 text-sm sm:grid-cols-3">
          <p>
            Videoerzeugung:{" "}
            {capabilities?.rendererReady ? "bereit" : "noch nicht bereit"}
          </p>
          <p>
            YouTube:{" "}
            {capabilities?.youtubeConfigured
              ? "Konto hinterlegt"
              : "nicht verbunden"}
          </p>
          <p>Spotify-Vertrieb: nicht verbunden</p>
        </div>
        {capabilities?.channelId && (
          <p className="text-sm">
            Zielkanal:{" "}
            <a
              className="underline"
              href={`https://www.youtube.com/channel/${capabilities.channelId}`}
              target="_blank"
              rel="noreferrer"
            >
              {capabilities.channelId}
            </a>
          </p>
        )}
        {connectionError && (
          <p role="alert" className="text-sm">
            {connectionError}
          </p>
        )}
        <p className="text-sm">{strategy.spotify}</p>
        <p className="text-sm">
          Instagram und TikTok sind noch nicht verbunden. Aktuell führt die
          Automatik ausschließlich YouTube-Aufträge aus.
        </p>
        <details>
          <summary className="cursor-pointer text-sm font-semibold">
            Monetarisierung und aktuelle Quellen
          </summary>
          <ul className="mt-2 list-disc pl-5 space-y-2 text-sm">
            {strategy.monetization.map((item) => (
              <li key={item}>{item}</li>
            ))}
          </ul>
          <p className="mt-3 text-xs">Recherchestand: {strategy.checkedAt}</p>
          <div className="mt-2 flex flex-wrap gap-3 text-xs">
            {strategy.sources.map((source) => (
              <a
                key={source.url}
                href={source.url}
                target="_blank"
                rel="noreferrer"
                className="underline"
              >
                {source.title}
              </a>
            ))}
          </div>
        </details>
      </Surface>
      {!releases.length && (
        <p className="text-sm">
          Sobald eine Suno-Übergabe vorliegt, erstellt ROOT automatisch die
          Veröffentlichungskampagne.
        </p>
      )}
      {releases.map((release) => (
        <ReleaseCard
          key={release.id}
          release={release}
          token={token}
          capabilities={capabilities}
          refresh={refresh}
        />
      ))}
    </section>
  );
}
