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

## Deploying

The server is a single long-running Node process that speaks HTTP and
WebSockets on one port, so it runs on anything that can keep a Node container
alive and pass through WebSocket upgrades. The repository ships the pieces you
need for a few common hosts:

- `Dockerfile` — production image (Node 20 alpine, `npm ci --omit=dev`)
- `fly.toml` — Fly.io deployment config
- `render.yaml` — Render.com blueprint
- `Procfile` — for Heroku / Railway nixpacks / similar

The server reads the `PORT` environment variable (falling back to the
`server/config.json` value), and the client's `config_local.json` uses
`"host": "auto"` / `"port": "auto"` to derive the WebSocket URL from
`window.location`, so TLS (`wss://`) works automatically behind any
reverse proxy.

### Google Cloud (GCE VM, cost-capped)

See [`deploy/gcp/README.md`](deploy/gcp/README.md) for the full walkthrough.
Short version: one `e2-small` VM + Caddy, flat ~$14/mo compute. **Set a
billing budget alert before you create the VM** — GCP egress is the one bill
that can run away on a WebSocket game.

```
gcloud compute scp deploy/gcp/setup.sh talonquest:/tmp/setup.sh --zone us-central1-a
gcloud compute ssh talonquest --zone us-central1-a
sudo DOMAIN=play.example.com REPO=https://github.com/<you>/talonquest.git BRANCH=main \
  bash /tmp/setup.sh
```

### Fly.io (free tier, great for WebSockets)

```
brew install flyctl              # or: curl -L https://fly.io/install.sh | sh
fly auth signup                   # or: fly auth login
fly launch --copy-config --no-deploy  # pick a unique app name, keep the Dockerfile
fly deploy
fly open                          # opens https://<your-app>.fly.dev/
```

The included `fly.toml` keeps one machine warm (`min_machines_running = 1`)
so live sockets aren't dropped when the app idles.

### Render.com

1. Push this repo to GitHub.
2. In the Render dashboard, click *New → Blueprint* and point it at the
   repo. Render will read `render.yaml` and create the web service.
3. Wait for the first deploy, then visit `https://<service>.onrender.com/`.

### Railway / Heroku-style (Procfile)

```
railway init
railway up
```

or on Heroku:

```
heroku create my-talonquest
git push heroku claude/add-fishing-combat-TwDGL:main
heroku open
```

### Plain VPS (DigitalOcean, Hetzner, Linode…)

```
# on the box, as a deploy user
git clone <your repo>
cd talonquest
npm ci --omit=dev
# keep it running (systemd, pm2, or nohup)
PORT=8000 pm2 start server/js/main.js --name talonquest
pm2 save
```

Then put Nginx or Caddy in front to terminate TLS and proxy WebSockets:

```nginx
server {
    listen 443 ssl http2;
    server_name talonquest.example.com;
    # ssl_certificate / ssl_certificate_key ...
    location / {
        proxy_pass http://127.0.0.1:8000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_read_timeout 3600s;
    }
}
```

### Local Docker test before you push

```
docker build -t talonquest .
docker run --rm -p 8000:8000 talonquest
open http://localhost:8000/
```

## License

MPL-2.0 — same as upstream BrowserQuest. See `LICENSE`.
