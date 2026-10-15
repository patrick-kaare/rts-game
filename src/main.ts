import { Application } from 'pixi.js';
import { Game } from './game';
import { DEFAULT_RULES } from './sim/rules';
import { Lobby } from './ui/lobby';
import './ui/ui.css';

async function main() {
  const viewport = document.getElementById('viewport')!;
  const app = new Application();
  await app.init({ resizeTo: viewport, background: 0x000000, antialias: true, autoDensity: true, resolution: window.devicePixelRatio || 1 });
  viewport.append(app.canvas);

  const overlay = document.createElement('div');
  overlay.id = 'overlay';
  overlay.hidden = true;
  const status = document.createElement('div');
  status.id = 'status';
  status.hidden = true;
  viewport.append(overlay, status);

  const lobby = new Lobby({
    playLocal: (seed, players, rules) => game.startLocal(seed, players, rules),
    playOnline: (net, info) => game.startOnline(net, info),
  });
  const game = new Game(app, viewport, document.getElementById('sidebar')!, overlay, status, {
    onExit: (online) => (online ? lobby.leave() : lobby.backToRoom()),
  });
  document.body.append(lobby.el);

  // ?seed=123 jumps straight into an offline 1v1 on that map.
  const seed = Number(new URLSearchParams(location.search).get('seed'));
  if (seed) {
    lobby.hide();
    game.startLocal(
      seed,
      [
        { name: 'You', ai: false, team: 0 },
        { name: 'AI 2', ai: true, team: 0 },
      ],
      DEFAULT_RULES,
    );
  } else lobby.open();
  if (import.meta.env.DEV) (window as unknown as { game: Game }).game = game;
}

main();
