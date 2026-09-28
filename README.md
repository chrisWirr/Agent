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
- Die beste Suno-Version wird im Workspace mit Suno-Link, Hörnotizen und dem Tarif zum Erzeugungszeitpunkt zurückgegeben. Optional kann eine MP3 bis 6 MB hochgeladen werden: Sie wird über die Workers-AI-Bindung transkribiert; gespeichert werden nur Transkript, Dateiname, Größe und SHA-256, nicht die Audiodatei. Ohne Transkript bleibt der Audit offen. Ein unabhängiger Audit vergleicht die übermittelten Lyrics und die Transkription, berücksichtigt deine Hörnotizen als menschliche Beobachtungen und erstellt gegebenenfalls einen Release-Vorschlag. Er behauptet nie, das Audio selbst gehört zu haben.
- Ein Release-Vorschlag ist keine Veröffentlichung. Die Rechtebasis bleibt sichtbar und ein Ergebnis aus einem kostenlosen oder ungeklärten Suno-Tarif wird für kommerzielle Verbreitung gesperrt. [Suno unterscheidet kostenlose und bei bezahltem Tarif erzeugte Songs](https://help.suno.com/en/articles/2410177); die Berechtigung wird vor einer konkreten Veröffentlichung geprüft.
- Alte Wirtschafts-Missionen bleiben als Historie gespeichert, werden aber für die neue Musikinitiative nicht als aktuelle Strategiedaten verwendet.
- Audioerzeugung und echtes Hören bleiben beim Menschen. Bilddateien, Vertrieb, Promotion und Kostenbuchung sind noch nicht angeschlossen. Ein Textentwurf wird nicht als fertiger Song ausgegeben. Veröffentlichung, Uploads, Zahlungen und externe Kontakte brauchen eine konkrete menschliche Freigabe.

Der Ablauf ist: Künstleridentität und Songbrief → Originalsong/Topline → Lyrics-Review → Suno-Bereitschaftsprüfung → menschliche Suno-Demo und Auswahl → Rückgabe mit Hörnotizen und optionaler MP3 → unabhängiger Audit → Release-Vorschlag → menschliche Freigabe → Publikumsfeedback.

## Lokal prüfen

```bash
npm install
npm run check
npm run test:autonomy
npm run dev
```

Der lokale Smoke-Test nutzt ein laufendes OpenClaw-Gateway und einen lokal bereitgestellten Token, der nicht in Git gehört:

```bash
OPENCLAW_GATEWAY_TOKEN_FILE=/path/to/local/token npx tsx scripts/smoke-autonomy.ts
```

## Laufzeit und Modelle

`wrangler.jsonc` routet STRATEGIST nach `openclaw/strategist`, ROOT und die meisten anderen Rollen nach `openclaw/main`; der Lyrics-Experte sowie Suno-Vorbereitung und -Audit laufen über Workers AI. Bei einer nicht verfügbaren Brücke fällt die Anwendung auf Workers AI zurück. `STRATEGIST_REVIEW_MINUTES` bestimmt den Abstand der Reviews (Standard: 360 Minuten). Die Grenzwerte sind zwei Strategieaufrufe und eine Mission pro 24 Stunden, höchstens zwei von ROOT geplante Spezialisten plus den automatischen Lyrics-Experten pro Songmission und eine Modellantwort pro Spezialist.

Auf dem Linux-Rechner versorgen diese User-Services die Brücke und das Gateway:

```bash
systemctl --user start openclaw-gateway.service agent-local-bridge.service agent-cloudflared.service
systemctl --user status openclaw-gateway.service agent-local-bridge.service agent-cloudflared.service
```

Die Cloudflare-Quick-Tunnel-Adresse ändert sich nach Neustarts und muss im Worker-Secret `OPENCLAW_BASE_URL` aktualisiert werden. Dafür braucht Wrangler eine gültige Cloudflare-Anmeldung. Zugangsdaten gehören ausschließlich in lokale Dateien oder Worker-Secrets.

Der geschützte Endpunkt `/admin/autonomy` zeigt die aktuelle Mission und deren technischen Status; `/admin/music` zeigt zusätzlich Entwürfe und Suno-Übergaben. Das separat angelegte Google-Apps-Script `scripts/google-status-mail.gs` kann Statusmails und fertige Suno-Aufträge verschicken, sobald der vorhandene Admin-Token als private Skripteigenschaft eingetragen und der Trigger autorisiert wurde. Die lokale Skriptdatei muss dafür im Google-Apps-Script-Projekt aktualisiert werden.

Eine neue Cloudflare-Version entsteht mit `npm run deploy`. Ein lokaler Commit allein verändert den bereits veröffentlichten Worker nicht.
