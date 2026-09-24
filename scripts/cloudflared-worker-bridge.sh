#!/usr/bin/env bash
set -euo pipefail

export PATH=/home/linu/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin:$PATH
cd /home/linu/Dokumente/agent

updated=0
/home/linu/.local/bin/cloudflared tunnel --no-autoupdate --url http://127.0.0.1:18788 2>&1 |
  while IFS= read -r line; do
    printf '%s\n' "$line"
    if [[ $updated -eq 0 && $line =~ https://[a-z-]+\.trycloudflare\.com ]]; then
      address=${BASH_REMATCH[0]}
      if printf '%s\n' "$address" | ./node_modules/.bin/wrangler secret put OPENCLAW_BASE_URL --name agent >/dev/null 2>&1; then
        echo "Cloudflare Worker bridge address updated"
        updated=1
      else
        echo "Could not update Cloudflare Worker bridge address" >&2
      fi
    fi
  done
