#!/usr/bin/env bash
set -euo pipefail

# Move to demo root (one level up from this script)
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR/.."

# Load only ngrok-related vars from .env without sourcing the whole file
if [[ -f .env ]]; then
  while IFS='=' read -r k v; do
    [[ -z "$k" || "$k" =~ ^# ]] && continue
    case "$k" in
      NGROK_AUTHTOKEN|NGROK_DOMAIN|NGROK_REGION|NGROK_DISABLE_DOMAIN|NGROK_POOLING_ENABLED|PORT)
        # trim surrounding quotes
        v="${v%\r}"
        v="${v%\n}"
        [[ "$v" =~ ^\".*\"$ ]] && v="${v:1:${#v}-2}"
        [[ "$v" =~ ^\'.*\'$ ]] && v="${v:1:${#v}-2}"
        export "$k"="$v"
      ;;
    esac
  done < .env
fi

# Allow opting out of reserved domain even if .env sets it
if [[ "${NGROK_DISABLE_DOMAIN:-}" =~ ^(1|true|yes)$ ]]; then
  echo "🚫 NGROK_DISABLE_DOMAIN is set — ignoring NGROK_DOMAIN from .env"
  unset NGROK_DOMAIN
fi

if ! command -v ngrok >/dev/null 2>&1; then
  echo "❌ ngrok CLI not found. Install it: https://ngrok.com/download"
  exit 1
fi

PORT="${PORT:-3000}"

# Configure authtoken if provided
if [[ -n "${NGROK_AUTHTOKEN:-}" ]]; then
  echo "🔐 Configuring ngrok authtoken"
  ngrok config add-authtoken "$NGROK_AUTHTOKEN" >/dev/null
fi

DOMAIN_FLAG=()
if [[ -n "${NGROK_DOMAIN:-}" ]]; then
  DOMAIN_FLAG=("--domain=$NGROK_DOMAIN")
  echo "🌐 Using reserved domain: $NGROK_DOMAIN"
else
  echo "🌐 Using random ngrok domain"
fi

echo "🚇 Starting ngrok → http://localhost:$PORT"

# Print the public URL once via local ngrok API (4040) while ngrok starts
(
  for i in $(seq 1 40); do
    url=$(curl -sS http://127.0.0.1:4040/api/tunnels 2>/dev/null | sed -n 's/.*"public_url":"\(https:\/\/[^"[:space:]]*\)".*/\1/p' | head -n1)
    if [[ -n "$url" ]]; then
      echo "✅ Public URL: $url"
      break
    fi
    sleep 0.25
  done
) &

if [[ -n "${NGROK_DOMAIN:-}" ]]; then
  exec ngrok http --domain="$NGROK_DOMAIN" "$PORT"
else
  exec ngrok http "$PORT"
fi


