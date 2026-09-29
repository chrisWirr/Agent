# ROOT Musikprojekt

Dieses Repository steuert ein originelles englischsprachiges Sängerinnenprojekt. Die vorläufige künstlerische Richtung ist Alternative Soul mit Hip-Hop-/Trap-Einflüssen: eine warme, raue und emotional starke Stimme, konkrete und manchmal bissige Texte sowie Songs mit einem Refrain, der auch nur mit Klavier oder Gitarre trägt. Ein Künstlername steht noch nicht fest. Die Referenzen beschreiben Eigenschaften; Texte, Melodien, Stimme und Bildsprache sollen eigenständig sein.

## Stand des Systems

- Der Cloudflare Worker bleibt Chat-Oberfläche und Laufzeit für ROOT. Ein geplanter STRATEGIST wählt kleine künstlerische Schritte; ROOT plant höchstens zwei Spezialisten pro Mission. Nach jedem neuen Songtext führt ein zusätzlicher Lyrics-Experte eine unabhängige Textprüfung durch.
- Unterstützte Textrollen: `SONGWRITER`, `LYRICS_EXPERT`, `PRODUCER`, `VOCAL_DIRECTOR`, `A_AND_R`, `ART_DIRECTOR`, `RELEASE_PLANNER`, `AUDITOR` und `RESEARCHER`. Der Lyrics-Experte prüft Aussage, Bildsprache, Sprachrhythmus, Singbarkeit, Refrain und Klischees und legt eine vollständige Überarbeitung ab. Nur `RESEARCHER` hat öffentliche Web-Recherchewerkzeuge. Andere Rollen erzeugen Textentwürfe und Arbeitsanweisungen.
- Künstlerprofil und Produktionsprinzipien stehen in `src/music/project.ts`. Entwürfe werden als `DRAFT` in der SQLite-Datenbank des Durable Object gespeichert. Der geschützte Endpunkt `/admin/music` zeigt Profil, Entwürfe und aktuelle Entscheidungen.
- Auf der Live-Seite führt „Workspace“ zur privaten Studio-Ansicht (`/studio`). Sie lädt die Entwürfe nach Eingabe des Admin-Tokens. Der Token bleibt nur im Browser-Speicher der offenen Sitzung und gehört nicht in URLs oder Git.
- Ein vorhandener Songentwurf kann über den geschützten `POST /admin/review-lyrics` einmalig dem Lyrics-Experten vorgelegt werden; Kritik und Überarbeitung erscheinen danach als eigene Entwürfe im Workspace.
- Der Lyrics-Experte nutzt die Cloudflare-AI-Bindung (`LYRICS_EXPERT_MODEL`); ein fehlgeschlagener oder unvollständiger manueller Lauf kann bis zu zweimal wiederholt werden.
- Nach einer vollständigen Lyrics-Revision entscheidet ein unabhängiges A&R-/Produktionstor, ob der Song eine Suno-Demo verdient. Nur bei `READY` speichert es im privaten Workspace einen eigenen `Style of Music`-Prompt, den endgültigen Lyrics-Text und Hörkriterien. Der Mensch nutzt [Suno Custom Mode](https://help.suno.com/en/categories/550017) selbst; die Agenten verwenden kein Suno-Konto und keine Suno-Credits.
- Die beste Suno-Version wird im Workspace mit Suno-Link, Hörnotizen und dem Tarif zum Erzeugungszeitpunkt zurückgegeben. Optional kann eine MP3 bis 6 MB hochgeladen werden: Sie wird über die Workers-AI-Bindung transkribiert; gespeichert werden Transkript, Dateiname, Größe und SHA-256 sowie die private MP3 in begrenzten SQLite-Blöcken für die spätere Veröffentlichung. Ohne Transkript bleibt der Audit offen. Ein unabhängiger Audit vergleicht die übermittelten Lyrics und die Transkription, berücksichtigt deine Hörnotizen als menschliche Beobachtungen und erstellt gegebenenfalls einen Release-Vorschlag. Er behauptet nie, das Audio selbst gehört zu haben.
- Ein Release-Vorschlag ist keine Veröffentlichung. Die Rechtebasis bleibt sichtbar und ein Ergebnis aus einem kostenlosen oder ungeklärten Suno-Tarif wird für kommerzielle Verbreitung gesperrt. [Suno unterscheidet kostenlose und bei bezahltem Tarif erzeugte Songs](https://help.suno.com/en/articles/2410177); die Berechtigung wird vor einer konkreten Veröffentlichung geprüft.
- Alte Wirtschafts-Missionen bleiben als Historie gespeichert, werden aber für die neue Musikinitiative nicht als aktuelle Strategiedaten verwendet.
- Audioerzeugung und echtes Hören bleiben beim Menschen. Nach dem erfolgreichen Audit autorisiert eine einzige Songfreigabe den automatischen YouTube-Visualizer und zwei Shorts. Diese Freigabe bindet die Audiodatei, die Kampagnenversion und den Zielkanal. Zahlungen, Werbung und externe Kontakte sind in diesem Ablauf nicht enthalten. Spotify-Vertrieb, Instagram und TikTok benötigen weiterhin passende Konten und eigene API-Adapter.

Der Ablauf ist: Künstleridentität und Songbrief → Originalsong/Topline → Lyrics-Review → Suno-Bereitschaftsprüfung → menschliche Suno-Demo und Auswahl → Rückgabe mit Hörnotizen und optionaler MP3 → unabhängiger Audit → Release-Vorschlag → menschliche Freigabe → Publikumsfeedback.

## Lokal prüfen

```bash
npm install
npm run check
npm run test:autonomy
npm run dev
```

## Alles starten

Die drei lokalen User-Services starten automatisch bei der Anmeldung. Für einen manuellen Start mit Statusprüfung und geöffneter Studio-Seite dient `./scripts/start-all.sh`; ohne Browser `./scripts/start-all.sh --no-browser`. `./scripts/status-all.sh` prüft die Services und die geschützte Verbindung zum Cloudflare Worker. Der Starter `ROOT Music Studio starten.desktop` ist zusätzlich im Anwendungsmenü und auf dem Desktop installiert. Die Studio-Seite ist auch direkt unter `https://agent.christian-schoenherr73.workers.dev/studio` erreichbar. Der Worker selbst läuft dauerhaft bei Cloudflare und muss lokal nicht gestartet werden.

Die Statusprüfung liest den Admin-Token aus `~/.config/agent-autonomy/admin-token`, ohne ihn auszugeben. Fehlt die Datei oder ist die Verbindung unterbrochen, meldet sie dies als Fehler.

Der lokale Smoke-Test nutzt ein laufendes OpenClaw-Gateway und einen lokal bereitgestellten Token, der nicht in Git gehört:

```bash
OPENCLAW_GATEWAY_TOKEN_FILE=/path/to/local/token npx tsx scripts/smoke-autonomy.ts
```

## Laufzeit und Modelle

`wrangler.jsonc` routet STRATEGIST, ROOT, die Spezialisten und den Lyrics-Experten derzeit über die Cloudflare-AI-Bindung auf Llama 3.3 70B. Auch Suno-Vorbereitung und -Audit nutzen dieses Modell. So kann der Worker trotz erschöpftem AgentRouter-Budget weiterarbeiten. `STRATEGIST_REVIEW_MINUTES` bestimmt den Abstand der Reviews (Standard: 360 Minuten). Die Grenzwerte sind zwei erfolgreiche Strategieaufrufe und eine Mission pro 24 Stunden, höchstens zwei von ROOT geplante Spezialisten plus den automatischen Lyrics-Experten pro Songmission und eine Modellantwort pro Spezialist.

Auf dem Linux-Rechner versorgen diese User-Services die Brücke und das Gateway:

```bash
systemctl --user enable --now openclaw-gateway.service agent-local-bridge.service agent-cloudflared.service
systemctl --user status openclaw-gateway.service agent-local-bridge.service agent-cloudflared.service
```

Die Cloudflare-Quick-Tunnel-Adresse ändert sich nach Neustarts und muss im Worker-Secret `OPENCLAW_BASE_URL` aktualisiert werden. Dafür braucht Wrangler eine gültige Cloudflare-Anmeldung. Zugangsdaten gehören ausschließlich in lokale Dateien oder Worker-Secrets.

Der geschützte Endpunkt `/admin/autonomy` zeigt die aktuelle Mission und deren technischen Status; `/admin/music` zeigt zusätzlich Entwürfe und Suno-Übergaben. Das separat angelegte Google-Apps-Script `scripts/google-status-mail.gs` kann Statusmails und fertige Suno-Aufträge verschicken, sobald der vorhandene Admin-Token als private Skripteigenschaft eingetragen und der Trigger autorisiert wurde. Die lokale Skriptdatei muss dafür im Google-Apps-Script-Projekt aktualisiert werden.

Eine neue Cloudflare-Version entsteht mit `npm run deploy`. Ein lokaler Commit allein verändert den bereits veröffentlichten Worker nicht.

## Automatische Veröffentlichung

Cloudflare verwaltet pro Song eine dauerhafte Warteschlange. Im Studio erzeugt das Marketing-Modul automatisch Titel, Beschreibung und zwei unterschiedliche Short-Texte. Die Kampagnenerstellung hat höchstens zwei Versuche pro Song und zwei Versuche pro Tag. Eine Freigabe ist erst mit positivem Audit, kommerzieller Rechtebasis, unveränderter gespeicherter MP3 und verbundenem YouTube-Kanal möglich.

Nach „Song freigeben & automatisch veröffentlichen“:

1. Die lokale Brücke erzeugt einen vollständigen Visualizer und zwei Hochkant-Clips mit FFmpeg.
2. Die YouTube-API lädt den vollständigen Song auf den bestätigten Kanal hoch. Erst ein verarbeitetes, öffentliches Video zählt als veröffentlicht.
3. Zwei Shorts folgen zwei und fünf Tage nach der tatsächlichen Veröffentlichung. Ihre Beschreibungen verweisen auf den vollständigen Song.
4. Echte Views, Likes und Kommentare werden täglich abgefragt und an den Strategen weitergegeben. Optional werden YouTube-Erlösschätzungen der letzten 28 Tage abgerufen, mit Zeitraum und Kennzeichnung als Schätzung.

Die Brücke speichert Auftragskennungen, Upload-Sitzungen und Ergebnisse privat unter `~/.local/share/agent-music`. Nach einem verlorenen Upload-Ergebnis fragt sie dieselbe resumierbare Sitzung ab. Unklare oder abgelaufene Sitzungen werden nicht durch einen neuen Upload ersetzt. Unabhängige Publikationen bleiben durch die Freigabe gebunden. „Pausieren“ hält neue Schritte an; es bricht keinen bereits laufenden Upload ab. Der Rechner muss für Rendering und YouTube-Uploads eingeschaltet bleiben. Cloudflare bewahrt den Auftrag bei einer unterbrochenen Brücke auf.

### YouTube einmalig verbinden

Benötigt werden ein eigener YouTube-Kanal und ein Google-Cloud-Projekt mit aktivierter **YouTube Data API v3** sowie einem OAuth-Client vom Typ **Desktop-App**. Dessen heruntergeladene JSON-Datei bleibt außerhalb des Repositorys. Dann:

```bash
node scripts/connect-youtube.mjs /pfad/zum/oauth-desktop-client.json
```

Optional mit der aktivierten YouTube Analytics API und Lesezugriff auf Erlösberichte:

```bash
node scripts/connect-youtube.mjs /pfad/zum/oauth-desktop-client.json --revenue
```

Die Anmeldung fordert Upload- und Leserechte für den ausgewählten Kanal an, mit `--revenue` zusätzlich Erlösberichte. Refresh-Token und Client-Geheimnis werden nur in `~/.config/agent-autonomy/youtube.json` (Modus 0600) gespeichert. Google-Apps im Testmodus können eine erneute Anmeldung erfordern. Google kann Videos aus ungeprüften API-Projekten auf private Sichtbarkeit begrenzen; dann zeigt das Studio `YOUTUBE_PRIVATE_RESTRICTION`. Die Aufnahme in das Partnerprogramm bzw. die Freigabe des API-Projekts kann die Software nicht ersetzen.

FFmpeg mit `drawtext`, `showwaves` und H.264/AAC wird über `AGENT_FFMPEG`, `/usr/bin/ffmpeg` oder die lokale Installation unter `~/.local/share/agent-media-runtime/system/usr/bin/ffmpeg` gefunden. Auf diesem Rechner ist die lokale Installation eingerichtet. Der bestehende Startdienst `agent-local-bridge.service` betreibt den Publisher mit; es wird kein zusätzlicher Dienst benötigt.

### Spotify und weitere Kanäle

Spotify nimmt Musik über einen Distributor entgegen. DistroKids aktuelle Annahme von KI-Musik ist keine öffentliche Upload-API. Solange kein geeigneter API-Vertrieb mit Zugang verbunden ist, zeigt das Studio den Spotify-Vertrieb als **nicht verbunden**; es gibt keine simulierten Auslieferungen. Gleiches gilt derzeit für Instagram und TikTok. Das Modul stellt Strategie, Quellen und Voraussetzungen bereit. Es schaltet keine Werbung, bucht keine Tarife und errechnet keine fiktiven Streaming-Einnahmen.

Quellen und Recherchestand sind direkt im Studio hinterlegt. Die YouTube-/Shorts-Strategie ist eine erste testbare Hypothese, keine behauptete Garantie für den besten Vermarktungskanal. Der bisherige Suno-Audit wird nach Ablauf seines Wiederholungslimits automatisch erneut eingereiht. Für alte Songabgaben muss einmal die ursprüngliche MP3 ergänzt werden, weil vorher nur die Transkription gespeichert wurde.
