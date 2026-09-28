import { useState } from "react";
import { Badge, Button, Surface, Text } from "@cloudflare/kumo";

type Draft = {
  id: string;
  kind: string;
  title: string;
  content: string;
  status: string;
  created_at: number;
};

type Workspace = {
  programId: string;
  artistBrief: Record<string, unknown>;
  drafts: Draft[];
  sunoHandoffs: SunoHandoff[];
  lastDirective: { decision: string; objective: string } | null;
  lastMission: { status: string; summary: string } | null;
};

type SunoHandoff = {
  id: string;
  title: string;
  lyrics: string;
  status: string;
  preparation: {
    decision: "READY" | "REVISE";
    reason: string;
    stylePrompt: string;
    qualityChecks: string[];
  } | null;
  submission: {
    sunoUrl: string;
    listeningNotes: string;
    rightsBasis: string;
    audioEvidence: { transcript: string } | null;
  } | null;
  audit: {
    decision: string;
    summary: string;
    lyricFidelity: string;
    strengths: string[];
    issues: string[];
    uncertainties: string[];
    releaseProposal: string;
  } | null;
};

function SunoReturnForm({
  handoff,
  token,
  onSubmitted
}: {
  handoff: SunoHandoff;
  token: string;
  onSubmitted: () => Promise<void>;
}) {
  const [url, setUrl] = useState(handoff.submission?.sunoUrl ?? "");
  const [notes, setNotes] = useState(handoff.submission?.listeningNotes ?? "");
  const [rights, setRights] = useState(
    handoff.submission?.rightsBasis ?? "UNKNOWN"
  );
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");

  return (
    <form
      className="mt-5 space-y-3 border-t border-kumo-line pt-5"
      onSubmit={async (event) => {
        event.preventDefault();
        setBusy(true);
        setMessage("");
        try {
          const form = new FormData();
          form.set("handoffId", handoff.id);
          form.set("sunoUrl", url.trim());
          form.set("listeningNotes", notes.trim());
          form.set("rightsBasis", rights);
          if (file) form.set("audio", file);
          const response = await fetch("/admin/suno/submit", {
            method: "POST",
            headers: { Authorization: `Bearer ${token.trim()}` },
            body: form
          });
          const result = (await response.json()) as {
            accepted?: boolean;
            reason?: string;
            error?: string;
            transcriptionError?: boolean;
          };
          if (!response.ok || !result.accepted)
            throw new Error(
              result.error ?? result.reason ?? "Abgabe fehlgeschlagen"
            );
          setMessage(
            result.transcriptionError
              ? "Link gespeichert, aber die Transkription ist fehlgeschlagen. Bitte MP3 erneut senden."
              : file
                ? "Ergebnis eingegangen. Die Prüfung läuft; bitte aktualisieren."
                : "Link gespeichert. Für die Text-/Audio-Prüfung bitte auch eine MP3 hochladen."
          );
          await onSubmitted();
        } catch (cause) {
          setMessage(
            cause instanceof Error ? cause.message : "Abgabe fehlgeschlagen"
          );
        } finally {
          setBusy(false);
        }
      }}
    >
      <h4 className="font-semibold">Dein bestes Suno-Ergebnis zurückgeben</h4>
      <label className="block text-sm">
        Suno-Link
        <input
          type="url"
          required
          value={url}
          onChange={(event) => setUrl(event.target.value)}
          placeholder="https://suno.com/song/..."
          className="mt-1 w-full rounded-lg border border-kumo-line bg-kumo-elevated px-3 py-2"
        />
      </label>
      <label className="block text-sm">
        Was du beim Hören bemerkst (Stimme, Refrain, Text, Produktion)
        <textarea
          required
          minLength={30}
          rows={4}
          value={notes}
          onChange={(event) => setNotes(event.target.value)}
          className="mt-1 w-full rounded-lg border border-kumo-line bg-kumo-elevated px-3 py-2"
        />
      </label>
      <label className="block text-sm">
        Suno-Tarif zum Zeitpunkt der Erzeugung
        <select
          value={rights}
          onChange={(event) => setRights(event.target.value)}
          className="mt-1 w-full rounded-lg border border-kumo-line bg-kumo-elevated px-3 py-2"
        >
          <option value="UNKNOWN">Unbekannt</option>
          <option value="PAID_AT_CREATION">Bezahlter Tarif</option>
          <option value="FREE">Kostenloser Tarif</option>
        </select>
      </label>
      <label className="block text-sm">
        MP3 des ausgewählten Ergebnisses (optional, maximal 6 MB)
        <input
          type="file"
          accept=".mp3,audio/mpeg"
          onChange={(event) => setFile(event.target.files?.[0] ?? null)}
          className="mt-1 block w-full text-sm"
        />
      </label>
      <Text size="sm" variant="secondary">
        Die MP3 wird nur zur automatischen Transkription verarbeitet. Die Datei
        wird nicht gespeichert; der Suno-Link bleibt die Hörquelle. Ohne
        Audiodatei erstellt das System noch keinen vollständigen Audit.
      </Text>
      <Button type="submit" variant="primary" disabled={busy}>
        {busy ? "Verarbeite …" : "Ergebnis übergeben"}
      </Button>
      {message && <output className="text-sm">{message}</output>}
    </form>
  );
}

function draftDisplay(draft: Draft): { title: string; body: string } {
  try {
    const parsed: unknown = JSON.parse(draft.content);
    if (parsed && typeof parsed === "object") {
      const item = parsed as Record<string, unknown>;
      if (typeof item.body === "string")
        return {
          title: typeof item.title === "string" ? item.title : draft.kind,
          body: item.body
        };
    }
  } catch {
    // Plain-text drafts are already readable.
  }
  const firstLine = draft.content.split("\n", 1)[0];
  return {
    title: firstLine.length < 120 ? firstLine : draft.kind,
    body: draft.content
  };
}

const kindLabels: Record<string, string> = {
  ARTIST_PROFILE: "Künstlerprofil",
  SONG_DRAFT: "Songentwurf",
  LYRIC_REVIEW: "Lyrics-Prüfung",
  SONG_REVISION: "Überarbeiteter Song",
  PRODUCTION_BRIEF: "Produktion",
  VOCAL_BRIEF: "Gesang",
  ARTISTIC_REVIEW: "Künstlerische Prüfung",
  ARTWORK_BRIEF: "Artwork",
  RELEASE_PLAN: "Release-Plan"
};

export default function StudioPage() {
  const [token, setToken] = useState("");
  const [workspace, setWorkspace] = useState<Workspace | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  const loadWorkspace = async () => {
    if (!token.trim()) {
      setError("Bitte den privaten Admin-Token eingeben.");
      return;
    }
    setLoading(true);
    setError("");
    try {
      const response = await fetch("/admin/music", {
        headers: { Authorization: `Bearer ${token.trim()}` },
        cache: "no-store"
      });
      if (!response.ok) {
        throw new Error(
          response.status === 404
            ? "Der Admin-Token wurde nicht akzeptiert."
            : `Workspace konnte nicht geladen werden (HTTP ${response.status}).`
        );
      }
      setWorkspace((await response.json()) as Workspace);
    } catch (cause) {
      setWorkspace(null);
      setError(
        cause instanceof Error ? cause.message : "Workspace nicht erreichbar."
      );
    } finally {
      setLoading(false);
    }
  };

  const drafts = [...(workspace?.drafts ?? [])].sort((a, b) => {
    const order = ["ARTIST_PROFILE", "SONG_DRAFT", "PRODUCTION_BRIEF"];
    const aRank = order.indexOf(a.kind);
    const bRank = order.indexOf(b.kind);
    return (aRank < 0 ? 99 : aRank) - (bRank < 0 ? 99 : bRank);
  });

  return (
    <main className="min-h-screen bg-kumo-elevated text-kumo-default">
      <header className="border-b border-kumo-line bg-kumo-base px-5 py-4">
        <div className="mx-auto flex max-w-4xl items-center justify-between gap-4">
          <div>
            <a href="/" className="text-sm text-kumo-subtle hover:underline">
              ← Zurück zum Chat
            </a>
            <h1 className="mt-1 text-xl font-semibold">🎙️ Music Workspace</h1>
          </div>
          {workspace && (
            <Badge variant="secondary">Privater Entwurfsraum</Badge>
          )}
        </div>
      </header>

      <div className="mx-auto max-w-4xl space-y-6 px-5 py-8">
        <Surface className="rounded-xl border border-kumo-line bg-kumo-base p-5">
          <h2 className="mb-2 text-lg font-semibold">Entwürfe ansehen</h2>
          <Text size="sm" variant="secondary">
            Die Texte sind privat und noch nicht veröffentlicht. Der Token wird
            nur für diese Sitzung im Browser gehalten und nicht in der Adresse
            oder im lokalen Speicher abgelegt.
          </Text>
          <form
            className="mt-4 flex flex-wrap gap-2"
            onSubmit={(event) => {
              event.preventDefault();
              void loadWorkspace();
            }}
          >
            <input
              type="password"
              name="admin-token"
              aria-label="Admin-Token"
              autoComplete="off"
              value={token}
              onChange={(event) => setToken(event.target.value)}
              placeholder="Privater Admin-Token"
              className="min-w-64 flex-1 rounded-lg border border-kumo-line bg-kumo-elevated px-3 py-2 text-sm text-kumo-default"
            />
            <Button type="submit" variant="primary" disabled={loading}>
              {loading ? "Lade …" : workspace ? "Aktualisieren" : "Öffnen"}
            </Button>
            {workspace && (
              <Button
                type="button"
                variant="secondary"
                onClick={() => {
                  setToken("");
                  setWorkspace(null);
                  setError("");
                }}
              >
                Schließen
              </Button>
            )}
          </form>
          {error && (
            <p role="alert" className="mt-3 text-sm text-red-600">
              {error}
            </p>
          )}
        </Surface>

        {workspace && (
          <>
            <section className="grid gap-3 sm:grid-cols-3">
              <Surface className="rounded-xl border border-kumo-line bg-kumo-base p-4">
                <Text size="xs" variant="secondary">
                  Letzte Mission
                </Text>
                <p className="mt-1 font-semibold">
                  {workspace.lastMission?.status ?? "Noch keine"}
                </p>
              </Surface>
              <Surface className="rounded-xl border border-kumo-line bg-kumo-base p-4">
                <Text size="xs" variant="secondary">
                  Entwürfe
                </Text>
                <p className="mt-1 font-semibold">{drafts.length}</p>
              </Surface>
              <Surface className="rounded-xl border border-kumo-line bg-kumo-base p-4">
                <Text size="xs" variant="secondary">
                  Künstlername
                </Text>
                <p className="mt-1 font-semibold">Noch offen</p>
              </Surface>
            </section>

            <section>
              <h2 className="mb-3 text-lg font-semibold">Übergabe an Suno</h2>
              {(workspace.sunoHandoffs ?? []).length === 0 ? (
                <Surface className="rounded-xl border border-kumo-line bg-kumo-base p-5">
                  <p className="text-sm">
                    Noch kein Song wurde für Suno freigegeben.
                  </p>
                  <Button
                    type="button"
                    variant="secondary"
                    className="mt-3"
                    onClick={async () => {
                      setLoading(true);
                      try {
                        await fetch("/admin/suno/prepare", {
                          method: "POST",
                          headers: { Authorization: `Bearer ${token.trim()}` }
                        });
                        await loadWorkspace();
                      } finally {
                        setLoading(false);
                      }
                    }}
                  >
                    Letzten Song prüfen lassen
                  </Button>
                </Surface>
              ) : (
                <div className="space-y-4">
                  {workspace.sunoHandoffs.map((handoff) => (
                    <Surface
                      key={handoff.id}
                      className="rounded-xl border border-kumo-line bg-kumo-base p-5"
                    >
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <h3 className="text-lg font-semibold">
                          {handoff.title}
                        </h3>
                        <Badge variant="secondary">{handoff.status}</Badge>
                      </div>
                      {handoff.preparation && (
                        <>
                          <p className="mt-3 text-sm">
                            {handoff.preparation.reason}
                          </p>
                          {handoff.preparation.decision === "READY" && (
                            <div className="mt-5 space-y-4">
                              <p className="text-sm">
                                In{" "}
                                <a
                                  className="underline"
                                  href="https://suno.com/create"
                                  target="_blank"
                                  rel="noreferrer"
                                >
                                  Suno Custom Mode
                                </a>{" "}
                                den Text in „Lyrics“ und die Stilbeschreibung in
                                „Style of Music“ einfügen. Danach hörst du die
                                Varianten und gibst die beste hier zurück.
                              </p>
                              <label className="block text-sm font-semibold">
                                Lyrics
                                <textarea
                                  readOnly
                                  rows={12}
                                  value={handoff.lyrics}
                                  className="mt-1 w-full rounded-lg border border-kumo-line bg-kumo-elevated p-3 font-mono text-xs"
                                />
                              </label>
                              <label className="block text-sm font-semibold">
                                Suno Style of Music
                                <textarea
                                  readOnly
                                  rows={5}
                                  value={handoff.preparation.stylePrompt}
                                  className="mt-1 w-full rounded-lg border border-kumo-line bg-kumo-elevated p-3 text-sm"
                                />
                              </label>
                              <p className="text-sm font-semibold">
                                Beim Anhören prüfen:
                              </p>
                              <ul className="list-disc space-y-1 pl-5 text-sm">
                                {handoff.preparation.qualityChecks.map(
                                  (check) => (
                                    <li key={check}>{check}</li>
                                  )
                                )}
                              </ul>
                            </div>
                          )}
                        </>
                      )}
                      {["READY_FOR_SUNO", "AWAITING_AUDIO"].includes(
                        handoff.status
                      ) && (
                        <SunoReturnForm
                          handoff={handoff}
                          token={token}
                          onSubmitted={loadWorkspace}
                        />
                      )}
                      {handoff.submission &&
                        !["READY_FOR_SUNO", "AWAITING_AUDIO"].includes(
                          handoff.status
                        ) && (
                          <p className="mt-4 text-sm">
                            Ausgewählte Version:{" "}
                            <a
                              className="underline"
                              href={handoff.submission.sunoUrl}
                              target="_blank"
                              rel="noreferrer"
                            >
                              Suno öffnen
                            </a>
                          </p>
                        )}
                      {handoff.audit && (
                        <div className="mt-5 space-y-3 border-t border-kumo-line pt-5 text-sm">
                          <h4 className="font-semibold">
                            Unabhängige Prüfung: {handoff.audit.decision}
                          </h4>
                          <p>{handoff.audit.summary}</p>
                          <p>
                            <strong>Lyrics:</strong>{" "}
                            {handoff.audit.lyricFidelity}
                          </p>
                          {handoff.audit.issues.length > 0 && (
                            <p>
                              <strong>Offene Punkte:</strong>{" "}
                              {handoff.audit.issues.join(" · ")}
                            </p>
                          )}
                          {handoff.audit.uncertainties.length > 0 && (
                            <p>
                              <strong>Unsicher:</strong>{" "}
                              {handoff.audit.uncertainties.join(" · ")}
                            </p>
                          )}
                          {handoff.audit.releaseProposal && (
                            <p>
                              <strong>Verbreitungsvorschlag:</strong>{" "}
                              {handoff.audit.releaseProposal}
                            </p>
                          )}
                          <p className="text-kumo-subtle">
                            Ein Vorschlag ist keine Veröffentlichung.
                            Plattformen, Rechte und endgültige Freigabe werden
                            vor jeder Verbreitung geprüft.
                          </p>
                        </div>
                      )}
                      {handoff.status === "FAILED" && (
                        <Button
                          type="button"
                          variant="secondary"
                          className="mt-4"
                          onClick={async () => {
                            const auditFailed = Boolean(handoff.submission);
                            const response = await fetch(
                              auditFailed
                                ? "/admin/suno/retry-audit"
                                : "/admin/suno/prepare",
                              {
                                method: "POST",
                                headers: {
                                  Authorization: `Bearer ${token.trim()}`,
                                  ...(auditFailed
                                    ? { "Content-Type": "application/json" }
                                    : {})
                                },
                                body: auditFailed
                                  ? JSON.stringify({ handoffId: handoff.id })
                                  : undefined
                              }
                            );
                            if (response.ok) await loadWorkspace();
                          }}
                        >
                          Prüfung erneut starten
                        </Button>
                      )}
                    </Surface>
                  ))}
                </div>
              )}
            </section>

            <section>
              <h2 className="mb-3 text-lg font-semibold">
                Künstlerische Richtung
              </h2>
              <Surface className="rounded-xl border border-kumo-line bg-kumo-base p-5">
                <dl className="grid gap-3 sm:grid-cols-2">
                  {Object.entries(workspace.artistBrief)
                    .filter(([, value]) => typeof value === "string")
                    .map(([key, value]) => (
                      <div key={key}>
                        <dt className="text-xs font-semibold uppercase tracking-wide text-kumo-subtle">
                          {key}
                        </dt>
                        <dd className="mt-1 text-sm">{String(value)}</dd>
                      </div>
                    ))}
                </dl>
              </Surface>
            </section>

            <section>
              <div className="mb-3 flex items-center justify-between gap-3">
                <h2 className="text-lg font-semibold">Gespeicherte Entwürfe</h2>
                <Badge variant="secondary">DRAFT · nicht veröffentlicht</Badge>
              </div>
              <div className="space-y-3">
                {drafts.map((draft, index) => {
                  const display = draftDisplay(draft);
                  return (
                    <details
                      key={draft.id}
                      open={index < 2}
                      className="rounded-xl border border-kumo-line bg-kumo-base p-5"
                    >
                      <summary className="cursor-pointer list-none">
                        <span className="mr-3 inline-block text-xs font-semibold uppercase tracking-wide text-kumo-subtle">
                          {kindLabels[draft.kind] ?? draft.kind}
                        </span>
                        <span className="font-semibold">{display.title}</span>
                      </summary>
                      <pre className="mt-5 whitespace-pre-wrap border-t border-kumo-line pt-5 font-sans text-sm leading-7">
                        {display.body}
                      </pre>
                    </details>
                  );
                })}
              </div>
            </section>
          </>
        )}
      </div>
    </main>
  );
}
