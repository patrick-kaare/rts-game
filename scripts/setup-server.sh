#!/bin/bash
# setup-server.sh — install Shape RTS as a systemd service on a Debian/Ubuntu
# box and publish it through the Cloudflare tunnel that is already on it.
#
#   git clone https://github.com/pkkann/rts-game.git ~/rts-game
#   cd ~/rts-game && bash scripts/setup-server.sh
#   (use `ssh -t` when running it remotely: it needs a terminal for sudo)
#
# What it does, skipping whatever is already there (re-running is safe):
#   1. git pull --ff-only (when the checkout is clean), npm ci, npm test,
#      npm run build                            (as this user, no sudo)
#   2. /etc/systemd/system/rts.service          (sudo) — one node process on
#      127.0.0.1:PORT serving dist/ and the /ws game socket
#   3. the tunnel: adds `rts.inigo.dk -> http://localhost:PORT` to
#      /etc/cloudflared/config.yml (sudo), restarts cloudflared, and creates
#      the DNS record with `cloudflared tunnel route dns`
#
#   PORT=3009 HOSTNAME_PUBLIC=rts.inigo.dk bash scripts/setup-server.sh
#   SKIP_PULL=1 ...    don't git pull first
#   SKIP_TESTS=1 ...   skip the test run
#   SKIP_TUNNEL=1 ...  only the service, leave Cloudflare alone
set -u
cd "$(dirname "$0")/.."
REPO="$PWD"

SERVICE=rts
PORT="${PORT:-3009}"
HOSTNAME_PUBLIC="${HOSTNAME_PUBLIC:-rts.inigo.dk}"
CF_CONFIG=/etc/cloudflared/config.yml
UNIT=/etc/systemd/system/$SERVICE.service

# --- output ------------------------------------------------------------------
if [ -t 1 ]; then
  B=$(printf '\033[1m'); DIM=$(printf '\033[2m'); R=$(printf '\033[0m')
  GRN=$(printf '\033[32m'); YEL=$(printf '\033[33m'); RED=$(printf '\033[31m')
else
  B=; DIM=; R=; GRN=; YEL=; RED=
fi
STEP_N=0; STEP_TOTAL=6
step() { STEP_N=$((STEP_N+1)); echo; echo "${B}[$STEP_N/$STEP_TOTAL] $*${R}"; }
ok()   { echo "  ${GRN}ok${R}   $*"; }
skip() { echo "  ${DIM}skip${R} $*"; }
warn() { echo "  ${YEL}warn${R} $*"; }
fail() { echo "  ${RED}FAIL${R} $*"; FAILED="$FAILED\n  - $*"; }
FAILED=
have() { command -v "$1" >/dev/null 2>&1; }

echo "${B}Shape RTS server setup${R}"
echo "${DIM}$REPO → https://$HOSTNAME_PUBLIC (127.0.0.1:$PORT)${R}"

# --- preflight ---------------------------------------------------------------
[ -f "$REPO/server/index.ts" ] || { echo "${RED}Not the repo root — server/index.ts is missing.${R}"; exit 1; }
if [ "$(id -u)" = 0 ]; then
  echo "${RED}Do not run this as root.${R} Run it as the user that should own the"
  echo "checkout and the service; it asks for sudo when it needs it."
  exit 1
fi
have sudo || { echo "${RED}sudo is required.${R}"; exit 1; }
if ! sudo -n true 2>/dev/null && [ ! -t 0 ]; then
  echo "${YEL}sudo needs a password and this shell has no terminal.${R} Use: ssh -t"
  exit 1
fi

# =============================================================================
step "Node"
if have node && [ "$(node -p 'process.versions.node.split(".")[0]')" -ge 20 ]; then
  skip "node $(node -v) at $(command -v node)"
else
  echo "  installing Node 20 from nodesource"
  if curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash - >/dev/null \
     && sudo apt-get install -y nodejs >/dev/null; then
    ok "node $(node -v)"
  else
    fail "could not install node — install Node >= 20 by hand and re-run"
  fi
fi
have node || { echo; echo "${RED}No node. Stopping.${R}"; exit 1; }
NODE_BIN=$(command -v node)

# =============================================================================
step "Update checkout"
if [ -n "${SKIP_PULL:-}" ]; then
  skip "SKIP_PULL set"
elif [ ! -d .git ]; then
  skip "not a git checkout"
elif [ -n "$(git status --porcelain --untracked-files=no)" ]; then
  warn "local changes in $REPO — not pulling (deploying what is here)"
elif git pull --ff-only origin "$(git rev-parse --abbrev-ref HEAD)" 2>&1 | sed 's/^/  /'; then
  ok "at $(git log -1 --format='%h %s')"
else
  fail "git pull --ff-only"
fi

# =============================================================================
step "Install, test, build"
if npm ci --no-audit --no-fund; then ok "npm ci"; else fail "npm ci"; fi
if [ -n "${SKIP_TESTS:-}" ]; then
  skip "tests (SKIP_TESTS set)"
elif npm test; then ok "tests pass"; else fail "npm test"; fi
if npm run build; then ok "built dist/ ($(du -sh dist 2>/dev/null | cut -f1))"; else fail "npm run build"; fi
[ -f dist/index.html ] || { echo; echo "${RED}No dist/index.html — the build did not produce a client. Stopping.${R}"; exit 1; }

# =============================================================================
step "systemd service"
UNIT_TMP=$(mktemp)
cat > "$UNIT_TMP" <<UNIT
[Unit]
Description=$HOSTNAME_PUBLIC (Shape RTS game server)
After=network.target

[Service]
Type=simple
User=$(id -un)
WorkingDirectory=$REPO
Environment=NODE_ENV=production
Environment=PORT=$PORT
Environment=HOST=127.0.0.1
# tsx runs the TypeScript server directly; dist/ (the built client) is served
# by the same process because it exists next to server/.
ExecStart=$NODE_BIN $REPO/node_modules/tsx/dist/cli.mjs server/index.ts
Restart=always
RestartSec=5
StartLimitIntervalSec=0

[Install]
WantedBy=multi-user.target
UNIT
if sudo test -f "$UNIT" && sudo cmp -s "$UNIT_TMP" "$UNIT"; then
  skip "$UNIT unchanged"
  sudo systemctl restart $SERVICE.service && ok "restarted"
else
  if sudo install -m 0644 -o root -g root "$UNIT_TMP" "$UNIT" \
     && sudo systemctl daemon-reload \
     && sudo systemctl enable --now $SERVICE.service >/dev/null 2>&1 \
     && sudo systemctl restart $SERVICE.service; then
    ok "$UNIT installed and started"
  else
    fail "could not install/start $SERVICE.service"
  fi
fi
rm -f "$UNIT_TMP"
UP=
for _ in 1 2 3 4 5 6 7 8 9 10; do
  sleep 1
  if curl -fsS "http://127.0.0.1:$PORT/healthz" >/dev/null 2>&1; then UP=1; break; fi
done
if [ -n "$UP" ]; then
  ok "answering on http://127.0.0.1:$PORT  $(curl -fsS "http://127.0.0.1:$PORT/healthz")"
else
  fail "nothing answering on :$PORT — journalctl -u $SERVICE.service -n 40"
fi

# =============================================================================
step "Cloudflare tunnel ingress"
if [ -n "${SKIP_TUNNEL:-}" ]; then
  skip "SKIP_TUNNEL set"
elif ! sudo test -f "$CF_CONFIG"; then
  warn "no $CF_CONFIG on this machine — nothing to add the hostname to"
  echo "       ${DIM}point $HOSTNAME_PUBLIC at http://localhost:$PORT in whatever fronts this box${R}"
elif sudo grep -qE "^\s*-\s*hostname:\s*$HOSTNAME_PUBLIC\s*$" "$CF_CONFIG"; then
  skip "$HOSTNAME_PUBLIC already in $CF_CONFIG"
else
  # Insert before the catch-all (`- service: http_status:404`), which must stay
  # last or cloudflared refuses the config.
  CF_TMP=$(mktemp)
  sudo awk -v host="$HOSTNAME_PUBLIC" -v port="$PORT" '
    /^[[:space:]]*-[[:space:]]*service:[[:space:]]*http_status:404/ && !done {
      print "  - hostname: " host
      print "    service: http://localhost:" port
      done=1
    }
    { print }
    END { if (!done) exit 2 }
  ' "$CF_CONFIG" > "$CF_TMP"
  case $? in
    0) sudo cp "$CF_CONFIG" "$CF_CONFIG.bak.$(date +%Y%m%d%H%M%S)"
       if sudo cloudflared --config "$CF_TMP" tunnel ingress validate >/dev/null 2>&1 \
          && sudo install -m 0644 -o root -g root "$CF_TMP" "$CF_CONFIG" \
          && sudo systemctl restart cloudflared; then
         ok "$HOSTNAME_PUBLIC -> http://localhost:$PORT added, cloudflared restarted"
       else
         fail "the new ingress did not validate or cloudflared did not restart (backup kept next to $CF_CONFIG)"
       fi ;;
    2) fail "no catch-all 'service: http_status:404' line in $CF_CONFIG — add the hostname by hand" ;;
    *) fail "could not rewrite $CF_CONFIG" ;;
  esac
  rm -f "$CF_TMP"
fi

# =============================================================================
step "DNS record"
TUNNEL_ID=$(sudo sed -n 's/^tunnel:[[:space:]]*//p' "$CF_CONFIG" 2>/dev/null | head -1)
if [ -n "${SKIP_TUNNEL:-}" ]; then
  skip "SKIP_TUNNEL set"
elif [ -z "$TUNNEL_ID" ]; then
  skip "no tunnel id in $CF_CONFIG"
elif ! have cloudflared; then
  skip "no cloudflared binary"
elif [ ! -f "$HOME/.cloudflared/cert.pem" ]; then
  warn "no $HOME/.cloudflared/cert.pem — cannot create DNS records from here"
  echo "       ${DIM}Cloudflare dashboard > DNS > add CNAME $HOSTNAME_PUBLIC -> $TUNNEL_ID.cfargotunnel.com (proxied),"
  echo "       or: cloudflared tunnel login && cloudflared tunnel route dns $TUNNEL_ID $HOSTNAME_PUBLIC${R}"
else
  OUT=$(cloudflared tunnel route dns "$TUNNEL_ID" "$HOSTNAME_PUBLIC" 2>&1)
  if [ $? -eq 0 ]; then
    ok "CNAME $HOSTNAME_PUBLIC -> tunnel $TUNNEL_ID"
  elif echo "$OUT" | grep -qi "already exists\|already has\|record with that host"; then
    skip "a DNS record for $HOSTNAME_PUBLIC already exists (leaving it alone)"
  else
    warn "cloudflared tunnel route dns: $(echo "$OUT" | tail -1)"
  fi
fi

# =============================================================================
echo
echo "${B}--- Done ---${R}"
echo
printf "  %-12s %s\n" "service"  "$SERVICE.service $(sudo systemctl is-active $SERVICE.service 2>/dev/null)  (http://127.0.0.1:$PORT)"
printf "  %-12s %s\n" "public"   "https://$HOSTNAME_PUBLIC"
printf "  %-12s %s\n" "tunnel"   "cloudflared $(sudo systemctl is-active cloudflared 2>/dev/null)"
printf "  %-12s %s\n" "logs"     "journalctl -u $SERVICE.service -f"
echo
echo "  Autodeploy on push to master:  bash scripts/setup-actions.sh"
if [ -n "$FAILED" ]; then
  echo
  echo "  ${RED}Some steps failed:${R}$(printf '%b' "$FAILED")"
  echo "  Re-running is safe — everything that worked is skipped."
fi
echo
