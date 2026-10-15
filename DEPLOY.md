# Deploying Shape RTS (rts.inigo.dk)

Production is one Node process on the home server `inigo` (Debian 13, user
`kaare`, checkout `/home/kaare/rts-game`), run by systemd as `rts.service` on
`127.0.0.1:3009`. The process is the game server from `server/` and it also
serves the built client from `dist/`, so the page and the `/ws` socket share
one origin. The Cloudflare tunnel already on that box (`cloudflared.service`,
config in `/etc/cloudflared/config.yml`) routes `rts.inigo.dk` to that port;
Cloudflare terminates TLS and passes WebSockets through.

```
                 https://rts.inigo.dk
Cloudflare edge ──tunnel──▶ cloudflared ──▶ http://localhost:3009 (rts.service)
                                              ├─ GET /          dist/ (vite build)
                                              ├─ GET /healthz   {"ok":true,"rooms":n}
                                              └─ WS  /ws        game rooms
```

The deploy checkout's `origin` is whatever repo the box should follow. If you
cannot push to `pkkann/rts-game`, point it at your fork instead: the deploy
workflow triggers on `master` of the repo the runner is registered against,
and `setup-actions.sh` reads that repo off `origin`, so a fork works end to end
(`git remote set-url origin https://github.com/<you>/rts-game.git`).

## First install on a machine (once)

```
ssh -t kaare@10.0.0.192
git clone https://github.com/<owner>/rts-game.git ~/rts-game
cd ~/rts-game && bash scripts/setup-server.sh
```

`setup-server.sh` runs `npm ci`, the tests and the build, installs and starts
`rts.service`, adds the `rts.inigo.dk -> localhost:3009` ingress rule to the
tunnel config (restarting cloudflared) and creates the DNS record with
`cloudflared tunnel route dns`. Every step is skipped if already done, so it
is safe to re-run. `PORT=… HOSTNAME_PUBLIC=…` override the defaults;
`SKIP_TESTS=1` and `SKIP_TUNNEL=1` do what they say. It needs a terminal for
the sudo password, hence `ssh -t`.

## Autodeploy (GitHub Actions, once)

Every push to `master` runs `.github/workflows/deploy.yml` on a self-hosted
runner on the box: pull, `npm ci`, `npm test`, `npm run build`, restart
`rts.service`, then check `/healthz`. A failing test or build leaves the
running game untouched.

```
ssh -t kaare@10.0.0.192 "cd ~/rts-game && bash scripts/setup-actions.sh"
```

It installs the `gh` CLI, logs in with the device flow (sign in as the
account that owns `pkkann/rts-game`, shamo6262@gmail.com — admin rights are
needed to register a runner), registers the runner in `~/actions-runner-rts`,
installs it as a systemd service and grants `kaare` one passwordless sudo
right: `systemctl restart rts.service`. The runner's `.env` carries
`RTS_DEPLOY_DIR`, so which checkout gets deployed is a property of the machine,
not of the workflow file.

Check it:

```
gh api repos/pkkann/rts-game/actions/runners --jq '.runners[]|"\(.name) \(.status)"'
gh workflow run Deploy --repo pkkann/rts-game && gh run watch --repo pkkann/rts-game
```

The repo is public and the runner is a real machine on a home network, so the
workflow must only ever trigger on `push` to `master` and `workflow_dispatch`.
Never add `pull_request`: a fork could then run its code on the box.

## Manual deploy

```
ssh -t kaare@10.0.0.192 "cd ~/rts-game && git pull --ff-only && npm ci && npm run build && sudo systemctl restart rts.service"
```

## Looking around

```
systemctl status rts.service
journalctl -u rts.service -f
curl http://127.0.0.1:3009/healthz
journalctl -u 'actions.runner.*' -f        # the Actions runner
sudo journalctl -u cloudflared -n 50       # the tunnel
```

Environment the service reads: `PORT` (3009), `HOST` (127.0.0.1), `STATIC_DIR`
(defaults to `dist/` next to `server/`; `none` disables static serving).
