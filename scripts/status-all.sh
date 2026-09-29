#!/usr/bin/env bash
set -uo pipefail

services=(
  openclaw-gateway.service
  agent-local-bridge.service
  agent-cloudflared.service
)

healthy=1
for service in "${services[@]}"; do
  state=$(systemctl --user is-active "$service" 2>/dev/null || true)
  printf '%-34s %s\n' "$service" "${state:-unbekannt}"
  if [[ $state != active ]]; then healthy=0; fi
done

if ! python3 - <<'PY'
import json
import urllib.request
from pathlib import Path

base = "https://agent.christian-schoenherr73.workers.dev"
token_path = Path.home() / ".config/agent-autonomy/admin-token"
if not token_path.is_file():
    print("Worker: Admin-Token-Datei fehlt; Live-Status nicht geprüft.")
    raise SystemExit(1)

headers = {
    "Authorization": "Bearer " + token_path.read_text().strip(),
    "User-Agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/128.0.0.0 Safari/537.36",
}

def get(path):
    with urllib.request.urlopen(urllib.request.Request(base + path, headers=headers), timeout=12) as response:
        return json.load(response)

try:
    bridge = get("/admin/bridge-health")
    status = get("/admin/autonomy")
except Exception as error:
    print(f"Worker: Live-Status nicht erreichbar ({type(error).__name__}).")
    raise SystemExit(1)

bridge_ok = bridge.get("reachable") is True
print("Worker-Brücke:", "erreichbar" if bridge_ok else "nicht erreichbar")
print("ROOT-Mission:", "läuft" if status.get("currentMission") else "keine aktiv")
for handoff in status.get("sunoHandoffs", [])[:1]:
    print("Suno-Auftrag:", handoff.get("title", "Song"), "—", handoff.get("status", "unbekannt"))
if "MUSIC_STRATEGIST_REVIEW_FAILED" in status.get("recentEvents", [])[:3]:
    print("Hinweis: Der letzte Strategenlauf ist fehlgeschlagen; die neue Modellroute wartet auf den nächsten Review.")
raise SystemExit(0 if bridge_ok else 1)
PY
then
  healthy=0
fi

exit "$((1 - healthy))"
