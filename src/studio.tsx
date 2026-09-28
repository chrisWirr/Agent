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
  lastDirective: { decision: string; objective: string } | null;
  lastMission: { status: string; summary: string } | null;
};

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
