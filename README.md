# TalonQuest

An HTML5 mini-MMORPG adapted from Mozilla's open-source
[BrowserQuest](https://github.com/mozilla/BrowserQuest) (MPL 2.0). The original
world, sprites, characters, weapons, armor, items, NPCs and quests are intact.
Two new gameplay systems have been added:

- **Fishing** — cast a line with **F** (or the fish button / `/fish` in chat)
  to pull in a trout and restore a chunk of your health. 6-second cooldown.
- **The Wild** — a marked PvP zone covering the forest biome (roughly the
  rectangle `x 1..85, y 179..266`). A warning banner appears while you are
  inside it and a chat bubble is emitted on entry. Players can attack other
  players **only** when both are standing inside The Wild.

## Running locally

```
npm install
npm start
```

Open <http://localhost:8000/> in your browser. Open more tabs or ask a friend
to connect over your LAN to see multiplayer and PvP in action.

## Controls

- **Arrow keys / click** — move
- **Click** a mob *or* another player (inside The Wild) — attack
- **F** — fish for a heal (also `/fish` or the floating fish button)
- **Enter** — open chat, Enter again to send
- **Esc** — close dialogs / stop attacks

## What's different from BrowserQuest?

The game server has been modernized so it boots on current Node:

- the transport shim (`server/js/ws.js`) uses the actively-maintained
  [`ws`](https://www.npmjs.com/package/ws) package instead of the long-dead
  `websocket-server` / `BISON` stack,
- the HTTP server now also serves the `client/` directory as static files so
  there is a single port to remember,
- the `log` dependency was replaced with a small console logger,
- the deprecated memcache-based metrics module is no longer loaded,
- `path.exists` → `fs.access`.

See `server/js/player.js` for the fishing and PvP gameplay hooks, and
`client/js/game.js` / `client/js/main.js` for the F-key, banner and PvP
click handling.

## License

MPL-2.0 — same as upstream BrowserQuest. See `LICENSE`.
