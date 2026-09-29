#!/usr/bin/env bash
set -euo pipefail

script_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
option=${1:-}
if [[ -n $option && $option != --no-browser && $option != --pause ]]; then
  echo "Verwendung: $0 [--no-browser|--pause]" >&2
  exit 2
fi

systemctl --user enable --now \
  openclaw-gateway.service \
  agent-local-bridge.service \
  agent-cloudflared.service

sleep 2
status=0
"$script_dir/status-all.sh" || status=$?

if [[ $option != --no-browser ]]; then
  xdg-open "https://agent.christian-schoenherr73.workers.dev/studio" >/dev/null 2>&1 &
fi

if [[ $option == --pause ]]; then
  echo
  read -r -p "Enter drücken, um dieses Fenster zu schließen … " _ || true
fi

exit "$status"
