# Deploying TalonQuest to Google Cloud (cheaply)

This is a deliberately boring setup: **one** Compute Engine VM running the
Node process behind Caddy (auto TLS). No Cloud Run, no GKE, no load balancer,
no autoscaling — autoscaling is the #1 way a game-server bill explodes.

Expected monthly cost in `us-central1`:

| Machine type | vCPU / RAM | ~Concurrent players | Approx. cost* |
| ------------ | ---------- | ------------------- | ------------- |
| `e2-micro`   | 2 shared / 1 GB | ~100  | ~$7 (free tier eligible) |
| `e2-small`   | 2 shared / 2 GB | ~300  | ~$14 |
| `e2-medium`  | 2 shared / 4 GB | ~600  | ~$27 |

*Compute only. **Egress is the real variable** — see the last section.

---

## 0. Prerequisites (once per Google account)

1. Create or pick a **billing account** and a **project** (`gcloud projects create talonquest`).
2. Install the gcloud CLI and log in: `gcloud auth login && gcloud config set project talonquest`.
3. Enable the two APIs we need:
   ```
   gcloud services enable compute.googleapis.com dns.googleapis.com
   ```

## 1. Set a hard budget **before** you create resources

This is the single most important step. Without a budget, a runaway container
or a traffic spike will bill you for thousands before you notice.

1. Console → **Billing → Budgets & alerts → Create budget**.
2. Scope: your billing account & the `talonquest` project only.
3. Amount: e.g. **$25/month** to start.
4. Thresholds: email yourself at **50%, 90%, 100%, 120%**.
5. (Optional, recommended) Wire the 100% alert to a Cloud Function that
   [disables billing on the project](https://cloud.google.com/billing/docs/how-to/notify#cap_disable_billing_to_stop_usage)
   — this is the only way to actually *cap* GCP spend.

## 2. Reserve a static external IP (optional but free while attached)

```
gcloud compute addresses create talonquest-ip --region us-central1
gcloud compute addresses describe talonquest-ip --region us-central1 --format="get(address)"
```

Point your DNS `A` record (e.g. `play.example.com`) at the printed IP. An
attached ephemeral IP is $0 if you're fine with it changing on restart.

## 3. Create the VM

```
gcloud compute instances create talonquest \
  --zone us-central1-a \
  --machine-type e2-small \
  --image-family debian-12 \
  --image-project debian-cloud \
  --boot-disk-size 20GB \
  --boot-disk-type pd-standard \
  --address talonquest-ip \
  --tags http-server,https-server \
  --metadata enable-oslogin=TRUE
```

Swap `e2-small` for `e2-micro` if you want the free-tier machine. **Stick to
`us-central1`, `us-east1`, or `us-west1`** — free tier eligibility and the
cheapest egress prices.

## 4. Open ports 80 and 443

```
gcloud compute firewall-rules create allow-http-https \
  --allow tcp:80,tcp:443 \
  --target-tags http-server,https-server
```

GCP blocks all inbound traffic by default; this rule only exposes the two
ports Caddy needs. Keep SSH on 22 locked down to your IP:

```
gcloud compute firewall-rules create allow-ssh-me \
  --allow tcp:22 \
  --source-ranges "$(curl -s ifconfig.me)/32"
```

## 5. Install and start TalonQuest on the VM

SSH in and run the one-shot installer (needs `sudo`):

```
gcloud compute ssh talonquest --zone us-central1-a
# then on the VM:
sudo DOMAIN=play.example.com \
     REPO=https://github.com/<you>/talonquest.git \
     BRANCH=main \
     bash /tmp/setup.sh
```

Easiest way to get the script onto the VM:

```
# from your laptop
gcloud compute scp deploy/gcp/setup.sh talonquest:/tmp/setup.sh --zone us-central1-a
```

The installer:

- installs Node 20 and Caddy
- creates a `talonquest` system user
- clones your repo to `/opt/talonquest` and runs `npm ci --omit=dev`
- installs `talonquest.service` (systemd) with memory/process caps
- writes `Caddyfile` with your domain and auto-issues a Let's Encrypt cert
- enables `ufw` so only 22/80/443 are reachable

Within ~30 seconds you should be able to open `https://play.example.com/`.

## 6. Day-2 operations

```
# watch the game log
gcloud compute ssh talonquest --zone us-central1-a \
  --command 'sudo journalctl -u talonquest -f'

# ship new code
gcloud compute ssh talonquest --zone us-central1-a --command '
  sudo -u talonquest git -C /opt/talonquest pull --ff-only &&
  sudo -u talonquest bash -c "cd /opt/talonquest && npm ci --omit=dev" &&
  sudo systemctl restart talonquest'

# stop the server cold (no bills for compute while stopped — only disk)
gcloud compute instances stop talonquest --zone us-central1-a
```

## 7. Watching the real cost driver: egress

GCP charges **$0.12/GB** for the first 200 GB/mo of outbound internet traffic
in North America. A real-time game at ~10 messages/sec × ~200 B × 500 concurrent
users ≈ **~80 GB/day**. That's ~$9/day in egress alone.

**Mitigations already applied in this repo:**

- `perMessageDeflate` on the WebSocket server (~60–80% bandwidth reduction).
- Zone-group broadcasting: players only receive state from their own
  screen-sized zone, not the whole world.
- `nb_players_per_world = 150` hard cap so one VM refuses connections past
  what it can afford. Raise via `server/config.json` only after confirming the
  egress bill is livable.

**Monitor it:**

- Cloud Monitoring → *VM Instances → Network bytes sent* (pin to dashboard).
- Set a **custom alert** at, say, 5 GB/hour sustained. That's your early
  warning that traffic has doubled unexpectedly.

**If the bill starts climbing:** switch to Hetzner Cloud (CPX21, ~€8/mo with
20 TB of unmetered egress). Porting is 10 minutes — same repo, same scripts,
different provider.

## 8. Scaling past one VM (only when you need to)

The upstream BrowserQuest design shards by *world* inside one process. If you
genuinely hit CPU or bandwidth ceilings on a single VM:

1. Bump `nb_worlds` in `server/config.json` — one extra world per free vCPU.
2. If the VM is saturated, resize (`gcloud compute instances set-machine-type`)
   rather than adding a second VM. A bigger VM is cheaper than a load balancer
   + sticky sessions + a second VM's IP.
3. Only add a second VM when you want geographic failover, not throughput.
