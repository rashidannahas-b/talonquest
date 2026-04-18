# Deploying TalonQuest to Google Cloud

Deliberately boring, cost-capped setup: **one** Compute Engine VM that
bootstraps itself on first boot, with Cloud Monitoring alerts and a billing
budget configured up front. No Cloud Run, no GKE, no load balancer, no
autoscaling. Autoscaling is the #1 way a game-server bill explodes.

Approximate monthly cost in `us-central1` (compute only — egress is the
variable, see the bottom of this file):

| Machine     | vCPU / RAM      | Rough concurrent players | Approx. cost |
| ----------- | --------------- | ------------------------ | ------------ |
| `e2-micro`  | 2 shared / 1 GB | ~100                     | ~$7 (free-tier eligible) |
| `e2-small`  | 2 shared / 2 GB | ~300                     | ~$14 |
| `e2-medium` | 2 shared / 4 GB | ~600                     | ~$27 |

## What's in this directory

| File | Purpose |
| ---- | ------- |
| `provision.sh` | One-shot: reserves a static IP, creates the VM with `setup.sh` as its startup script, creates an email notification channel, applies alert policies, and installs the monitoring dashboard. Idempotent. |
| `destroy.sh` | Tears down everything `provision.sh` created so billing stops. |
| `budget.sh` | Creates a Cloud Billing budget with 50/90/100/120% email alerts. Separate because it needs billing-account permissions. |
| `setup.sh` | VM-side bootstrap: installs Node 20 + Caddy, clones the repo, runs `npm ci`, sets up systemd + Caddy. Reads config from env vars *or* GCE instance metadata. |
| `talonquest.service` | systemd unit with memory/restart caps so a crash loop can't rack up bills. |
| `Caddyfile` | TLS termination (auto Let's Encrypt) and WebSocket-friendly reverse proxy. |
| `alerts/*.yaml` | Cloud Monitoring alert policies (egress, CPU, uptime). |
| `dashboard.json` | Cloud Monitoring dashboard with egress / CPU / memory / TCP panels. |

## Prerequisites (once per Google account)

```bash
gcloud auth login
gcloud config set project <your-project-id>
```

You also need:

- A domain name you control (`play.example.com` in the examples below), with
  the ability to update its `A` record.
- An email you can receive alerts on.

## Step 1 — set a billing budget first

This is the single most important step. Without a budget a runaway process or
a traffic spike will bill you for days before you notice.

```bash
deploy/gcp/budget.sh --amount 25 --email you@example.com
```

Default thresholds: 50%, 90%, 100%, 120%. GCP budgets *alert*; they do not
hard-cap spend. For an actual cap, wire the Pub/Sub notification into a Cloud
Function that disables billing on the project:
<https://cloud.google.com/billing/docs/how-to/notify#cap_disable_billing_to_stop_usage>

## Step 2 — provision the VM and monitoring

```bash
deploy/gcp/provision.sh \
  --domain play.example.com \
  --email  you@example.com \
  --repo   https://github.com/<you>/talonquest.git \
  --branch main
```

Defaults (override with flags): `--name talonquest --region us-central1 --zone us-central1-a --machine e2-small`.

The script:

1. Enables the Compute, Monitoring and Logging APIs.
2. Reserves a static external IP (`talonquest-ip`).
3. Opens a firewall rule for ports 80 and 443 only (SSH uses GCP's IAP).
4. Creates the VM with the repo's `setup.sh` as its boot startup-script, and
   passes `DOMAIN`, `REPO`, `BRANCH` via instance metadata.
5. Creates an email notification channel and attaches it to the egress, CPU
   and uptime alert policies under `alerts/`.
6. Imports the monitoring dashboard from `dashboard.json`.

At the end it prints the IP and the URL to tail.

## Step 3 — point your DNS at the IP

Update the `A` record for your domain to the static IP printed by
`provision.sh`. Caddy will finish issuing the TLS certificate automatically
once the domain resolves.

## Step 4 — open the game

After ~2 minutes:

```
open https://play.example.com/
```

Watch the bootstrap log if something looks off:

```
gcloud compute ssh talonquest --zone us-central1-a \
  --command 'sudo journalctl -u google-startup-scripts -f'
```

## Day-2 operations

```bash
# watch game logs
gcloud compute ssh talonquest --zone us-central1-a \
  --command 'sudo journalctl -u talonquest -f'

# ship new code (idempotent)
gcloud compute ssh talonquest --zone us-central1-a --command '
  sudo -u talonquest git -C /opt/talonquest pull --ff-only &&
  sudo -u talonquest bash -c "cd /opt/talonquest && npm ci --omit=dev" &&
  sudo systemctl restart talonquest'

# stop the VM when you don't need it (only disk keeps billing)
gcloud compute instances stop talonquest --zone us-central1-a

# nuke everything, stop all charges
deploy/gcp/destroy.sh --name talonquest
```

## Cost reality check: egress

GCP charges **$0.12/GB** outbound internet traffic in North America. A
real-time game at ~10 msg/s × ~200 B × 500 concurrent users ≈ **~80 GB/day**,
or roughly $9/day in egress — often more than the compute itself.

Mitigations baked into this repo:

- `perMessageDeflate` on the WebSocket server (~60–80% bandwidth reduction).
- Zone-group broadcasting (upstream BrowserQuest design): players only
  receive state from their own screen-sized zone.
- Tick rate dropped to 20 UPS.
- Hard `nb_players_per_world = 150` cap so one VM refuses connections past
  what it can afford. Raise intentionally in `server/config.json`.
- The `TalonQuest: high egress` alert fires at ~5 GB/hour sustained (~$0.60/h).

If egress ever becomes the dominant line item, Hetzner Cloud (CPX21, ~€8/mo,
20 TB unmetered) is a ~10-minute port: same repo, same `setup.sh`, different
provider.
