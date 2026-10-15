#!/bin/bash
# setup-actions.sh — register this machine as the GitHub Actions self-hosted
# runner that deploys Shape RTS, logging in from the terminal.
#
#   bash scripts/setup-actions.sh        (ssh -t when remote: sudo needs a tty)
#
# What it does: installs the gh CLI, logs you in (device flow — it prints a
# code you type into github.com from any browser, so a headless box is fine;
# sign in as the account that owns the repo, shamo6262@gmail.com), reads the
# repo off the git remote, pulls a runner registration token through the API,
# registers the runner in ~/actions-runner-rts, installs it as a systemd
# service, and grants it the one sudo right the deploy job needs. From then on
# .github/workflows/deploy.yml builds and restarts the game on every push to
# master.
#
# No registration token is pasted by hand: it comes from the API with your
# login and expires in an hour, so nothing long-lived is written down.
#
# Re-running is safe: an installed gh, a live login, an already-registered
# runner and an existing sudoers rule are all left alone.
#
#   NONINTERACTIVE=1 bash scripts/setup-actions.sh   # take every default
#
# To undo all of it, see the "Removing" lines the summary prints at the end.
set -u
cd "$(dirname "$0")/.."
REPO="$PWD"

RUNNER_DIR="${RUNNER_DIR:-$HOME/actions-runner-rts}"
SERVICE=rts
SUDOERS=/etc/sudoers.d/${SERVICE}-deploy
DEFAULT_BRANCH=master

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

INTERACTIVE=1
[ -n "${NONINTERACTIVE:-}" ] && INTERACTIVE=
[ -t 0 ] || INTERACTIVE=

ask() { # prompt, default -> stdout
  local prompt="$1" def="${2:-}" reply
  if [ -z "$INTERACTIVE" ]; then echo "$def"; return; fi
  if [ -n "$def" ]; then
    read -r -p "  $prompt [$def]: " reply </dev/tty; echo "${reply:-$def}"
  else
    read -r -p "  $prompt: " reply </dev/tty; echo "$reply"
  fi
}
ask_yn() { # prompt, default(y/n)
  local prompt="$1" def="${2:-y}" reply
  if [ -z "$INTERACTIVE" ]; then [ "$def" = y ]; return; fi
  while :; do
    read -r -p "  $prompt $([ "$def" = y ] && echo '[Y/n]' || echo '[y/N]'): " reply </dev/tty
    reply="${reply:-$def}"
    case "$reply" in [Yy]*) return 0;; [Nn]*) return 1;; esac
  done
}

# --- preflight ---------------------------------------------------------------
echo "${B}GitHub Actions runner setup (Shape RTS)${R}"
echo "${DIM}$REPO${R}"
echo
[ -f "$REPO/server/index.ts" ] || { echo "${RED}Not the repo root — server/index.ts is missing.${R}"; exit 1; }
have apt-get || { echo "${RED}This installs packages with apt-get and this machine has none.${R}"; exit 1; }
if [ "$(id -u)" = 0 ]; then
  echo "${RED}Do not run this as root.${R} The runner's config.sh refuses to run as root,"
  echo "and a root runner would execute every workflow step as root. Run it as the"
  echo "user that should own the runner; it asks for sudo when it needs it."
  exit 1
fi
have sudo || { echo "${RED}No sudo.${R} Installing the runner service and the deploy sudo rule needs it."; exit 1; }
if ! sudo -n true 2>/dev/null && [ ! -t 0 ]; then
  echo "${YEL}sudo needs a password and this shell has no terminal.${R} Use: ssh -t"
  exit 1
fi

# =============================================================================
step "gh CLI"
if have gh; then
  skip "already installed ($(gh --version | head -1))"
else
  # The official apt repo, so `apt upgrade` keeps it current — gh is the thing
  # holding your login, a pinned .deb would quietly rot.
  echo "  installing from GitHub's apt repo"
  KEYRING=/etc/apt/keyrings/githubcli-archive-keyring.gpg
  if sudo mkdir -p /etc/apt/keyrings \
     && curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg | sudo tee "$KEYRING" >/dev/null \
     && sudo chmod go+r "$KEYRING" \
     && echo "deb [arch=$(dpkg --print-architecture) signed-by=$KEYRING] https://cli.github.com/packages stable main" \
          | sudo tee /etc/apt/sources.list.d/github-cli.list >/dev/null \
     && sudo apt-get update -qq \
     && sudo apt-get install -y gh; then
    ok "gh $(gh --version | head -1 | awk '{print $3}')"
  else
    fail "could not install gh — see https://github.com/cli/cli/blob/trunk/docs/install_linux.md"
  fi
fi
have gh || { echo; echo "${RED}gh is required and is not installed. Stopping.${R}"; exit 1; }

# =============================================================================
step "GitHub login"
if gh auth status >/dev/null 2>&1; then
  skip "already logged in as $(gh api user --jq .login 2>/dev/null || echo '?')"
  echo "       ${DIM}wrong account? gh auth logout, then re-run${R}"
else
  echo "  ${B}Logging in from the terminal.${R} gh prints a one-time code and a URL —"
  echo "  open it anywhere (phone, laptop) and type the code in. Sign in as the"
  echo "  account that owns the repo (${B}shamo6262@gmail.com${R}); registering a runner"
  echo "  needs admin rights on it."
  echo
  # https for git: this user's ssh key may be a deploy key for another repo.
  if gh auth login --hostname github.com --git-protocol https --web; then
    ok "logged in as $(gh api user --jq .login 2>/dev/null || echo '?')"
  else
    echo
    echo "  ${DIM}Device flow failed or was cancelled. Alternative: a token with the"
    echo "  'repo' scope from https://github.com/settings/tokens, then"
    echo "    gh auth login --with-token < token.txt${R}"
    fail "gh auth login"
  fi
fi
gh auth status >/dev/null 2>&1 || { echo; echo "${RED}Not logged in. Stopping.${R}"; exit 1; }

# =============================================================================
step "Repository"
ORIGIN=$(git -C "$REPO" config --get remote.origin.url 2>/dev/null || true)
SLUG=$(echo "$ORIGIN" | sed -E 's#^git@[^:]+:##; s#^https?://[^/]+/##; s#\.git$##')
if [ -z "$SLUG" ] || [ "$(echo "$SLUG" | tr -cd '/' | wc -c)" != 1 ]; then
  warn "could not read owner/repo from the remote ($ORIGIN)"
  SLUG=$(ask "owner/repo" "pkkann/rts-game")
fi
SLUG=$(ask "Register the runner against which repo?" "$SLUG")
[ -n "$SLUG" ] || { echo "${RED}No repo. Stopping.${R}"; exit 1; }

if ! gh api "repos/$SLUG" --jq .full_name >/dev/null 2>&1; then
  echo "${RED}Cannot see $SLUG with this login.${R} Wrong account, or no access."
  exit 1
fi
VISIBILITY=$(gh api "repos/$SLUG" --jq '.visibility' 2>/dev/null || echo unknown)
ADMIN=$(gh api "repos/$SLUG" --jq '.permissions.admin' 2>/dev/null || echo false)
ok "$SLUG ($VISIBILITY)"
if [ "$ADMIN" != true ]; then
  echo "  ${RED}$(gh api user --jq .login 2>/dev/null) is not an admin of $SLUG.${R} Registering a runner"
  echo "  needs admin rights — the registration-token call below will be refused."
  ask_yn "Try anyway?" n || exit 1
fi

# A self-hosted runner on a public repo is the classic way to hand strangers a
# shell: anything that can trigger a workflow runs code on this machine. The
# deploy workflow only triggers on push-to-master and manual dispatch, neither
# of which a fork can reach — but that is a property of the workflow file.
if [ "$VISIBILITY" = public ]; then
  echo
  echo "  ${YEL}$SLUG is PUBLIC and this would be a self-hosted runner.${R}"
  echo "  Workflow jobs run as $(id -un) on this machine, on your network. deploy.yml"
  echo "  is safe today (push-to-master and workflow_dispatch only, which a fork"
  echo "  cannot trigger), but adding a pull_request trigger later would let any"
  echo "  fork's code run here. Keep it that way, and keep write access to the"
  echo "  repo to people you would give a shell on this box."
  ask_yn "  Register a runner on a public repo anyway?" y || exit 1
fi

# =============================================================================
step "Runner download"
RUNNER_NAME=$(ask "Runner name" "$(hostname -s)-rts")
DEPLOY_DIR=$(ask "Directory the deploy job should pull, build and restart" "$REPO")
mkdir -p "$RUNNER_DIR"
if [ -x "$RUNNER_DIR/config.sh" ]; then
  skip "already unpacked in $RUNNER_DIR"
else
  case "$(uname -m)" in
    x86_64) RARCH=x64 ;;
    aarch64|arm64) RARCH=arm64 ;;
    armv7l) RARCH=arm ;;
    *) RARCH= ;;
  esac
  if [ -z "$RARCH" ]; then
    fail "no runner build for $(uname -m)"
  else
    RVER=$(gh api repos/actions/runner/releases/latest --jq '.tag_name' 2>/dev/null | sed 's/^v//')
    if [ -z "$RVER" ]; then
      fail "could not find the latest runner release"
    else
      TARBALL="$RUNNER_DIR/actions-runner-linux-$RARCH-$RVER.tar.gz"
      echo "  downloading $(basename "$TARBALL")"
      if curl -fsSL --retry 5 --retry-delay 2 -o "$TARBALL" \
           "https://github.com/actions/runner/releases/download/v$RVER/$(basename "$TARBALL")" \
         && tar -xzf "$TARBALL" -C "$RUNNER_DIR"; then
        ok "runner $RVER unpacked"
      else
        fail "could not download or unpack the runner"
      fi
      [ -f "${TARBALL:?}" ] && rm -f -- "${TARBALL:?}"
    fi
  fi
fi
if [ -x "$RUNNER_DIR/bin/installdependencies.sh" ] && [ ! -f "$RUNNER_DIR/.deps-done" ]; then
  echo "  installing the runner's system dependencies"
  if (cd "$RUNNER_DIR" && sudo ./bin/installdependencies.sh >/dev/null 2>&1); then
    touch "$RUNNER_DIR/.deps-done"; ok "dependencies installed"
  else
    warn "installdependencies.sh failed — the runner may still work; check its log if not"
  fi
fi

# =============================================================================
step "Register the runner"
if [ ! -x "$RUNNER_DIR/config.sh" ]; then
  fail "nothing to register — the download step did not finish"
elif [ -f "$RUNNER_DIR/.runner" ]; then
  skip "already registered as '$(sed -n 's/.*"agentName": *"\([^"]*\)".*/\1/p' "$RUNNER_DIR/.runner" 2>/dev/null || echo '?')'"
  echo "       ${DIM}to re-register: cd $RUNNER_DIR && ./config.sh remove, then re-run this${R}"
else
  echo "  fetching a registration token from the API"
  RTOKEN=$(gh api -X POST "repos/$SLUG/actions/runners/registration-token" --jq '.token' 2>/dev/null || true)
  if [ -z "$RTOKEN" ]; then
    fail "could not get a registration token (admin rights on $SLUG are required)"
  else
    if (cd "$RUNNER_DIR" && ./config.sh \
          --url "https://github.com/$SLUG" \
          --token "$RTOKEN" \
          --name "$RUNNER_NAME" \
          --labels self-hosted,linux,"$(uname -m)" \
          --unattended --replace); then
      ok "registered as '$RUNNER_NAME'"
    else
      fail "config.sh could not register the runner"
    fi
    unset RTOKEN
  fi
fi

# The deploy job needs to know which checkout to build; the runner passes its
# own .env through to every job, which keeps the machine's path out of the
# committed workflow.
if [ -d "$RUNNER_DIR" ]; then
  touch "$RUNNER_DIR/.env"
  if grep -q "^RTS_DEPLOY_DIR=" "$RUNNER_DIR/.env"; then
    sed -i "s#^RTS_DEPLOY_DIR=.*#RTS_DEPLOY_DIR=$DEPLOY_DIR#" "$RUNNER_DIR/.env"
  else
    echo "RTS_DEPLOY_DIR=$DEPLOY_DIR" >> "$RUNNER_DIR/.env"
  fi
  ok "RTS_DEPLOY_DIR=$DEPLOY_DIR (in $RUNNER_DIR/.env)"
fi

# The job pulls as this user from a systemd service — no terminal to answer a
# host-key or passphrase prompt. Public repo over https needs nothing; an ssh
# remote would need a passphrase-less key that can read this repo.
if [ -d "$DEPLOY_DIR/.git" ]; then
  if GIT_SSH_COMMAND='ssh -o BatchMode=yes -o StrictHostKeyChecking=accept-new' \
     git -C "$DEPLOY_DIR" ls-remote origin -h >/dev/null 2>&1; then
    ok "$DEPLOY_DIR can reach its remote without a prompt"
  else
    warn "$DEPLOY_DIR cannot reach its remote non-interactively — the deploy will fail"
    echo "       ${DIM}fix: git -C $DEPLOY_DIR remote set-url origin https://github.com/$SLUG.git${R}"
  fi
else
  warn "$DEPLOY_DIR is not a git checkout — the deploy job would stop there"
fi

# =============================================================================
step "Runner service and deploy permission"
if [ -f "$RUNNER_DIR/.service" ]; then
  skip "service already installed ($(cat "$RUNNER_DIR/.service" 2>/dev/null))"
  (cd "$RUNNER_DIR" && sudo ./svc.sh start >/dev/null 2>&1) && ok "started" || warn "could not start it"
elif [ -x "$RUNNER_DIR/svc.sh" ] && [ -f "$RUNNER_DIR/.runner" ]; then
  if (cd "$RUNNER_DIR" && sudo ./svc.sh install "$(id -un)" && sudo ./svc.sh start); then
    ok "installed and started as a systemd service (survives reboot)"
  else
    fail "svc.sh install/start"
  fi
else
  skip "no registered runner to install a service for"
fi

# The one sudo right the deploy job needs, scoped to exactly one command.
# Validated with visudo before it is installed: a malformed sudoers.d file
# breaks sudo for everyone on the box.
if sudo test -f "$SUDOERS"; then
  skip "deploy sudo rule already present ($SUDOERS)"
else
  SUDO_TMP=$(mktemp)
  echo "$(id -un) ALL=(root) NOPASSWD: /usr/bin/systemctl restart $SERVICE.service" > "$SUDO_TMP"
  if sudo visudo -c -f "$SUDO_TMP" >/dev/null 2>&1; then
    if sudo install -m 0440 -o root -g root "$SUDO_TMP" "$SUDOERS"; then
      ok "$(id -un) may restart $SERVICE.service without a password"
    else
      fail "could not install $SUDOERS"
    fi
  else
    fail "the generated sudoers rule did not validate — not installing it"
  fi
  rm -f -- "${SUDO_TMP:?}"
fi

# =============================================================================
echo
echo "${B}--- Done ---${R}"
echo
printf "  %-10s %s\n" "repo"     "$SLUG ($VISIBILITY)"
printf "  %-10s %s\n" "login"    "$(gh api user --jq .login 2>/dev/null || echo '?')"
printf "  %-10s %s\n" "runner"   "$RUNNER_NAME in $RUNNER_DIR"
printf "  %-10s %s\n" "deploys"  "$DEPLOY_DIR on every push to $DEFAULT_BRANCH"
echo
echo "  Is it online?   gh api repos/$SLUG/actions/runners --jq '.runners[]|\"\(.name) \(.status)\"'"
echo "  Runner log:     journalctl -u '$(cat "$RUNNER_DIR/.service" 2>/dev/null || echo 'actions.runner.*')' -f"
echo "  Trigger a run:  gh workflow run Deploy --repo $SLUG"
echo "  Watch it:       gh run watch --repo $SLUG"
echo
echo "  ${DIM}Removing: cd $RUNNER_DIR && sudo ./svc.sh stop && sudo ./svc.sh uninstall"
echo "            ./config.sh remove --token \$(gh api -X POST repos/$SLUG/actions/runners/remove-token --jq .token)"
echo "            sudo rm $SUDOERS${R}"
if [ -n "$FAILED" ]; then
  echo
  echo "  ${RED}Some steps failed:${R}$(printf '%b' "$FAILED")"
  echo "  Re-running is safe — everything that worked is skipped."
fi
echo
