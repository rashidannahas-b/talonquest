#!/usr/bin/env bash
# One-shot TalonQuest provisioner for Google Cloud.
#
# Creates: static external IP, firewall rules, an e2-small VM that
# bootstraps itself on first boot, a Cloud Monitoring notification channel,
# and alert policies for egress/CPU/uptime. Prints next steps at the end.
#
# Prereqs (run these once yourself):
#   gcloud auth login
#   gcloud config set project <your-project>
#
# Usage:
#   ./provision.sh \
#       --domain play.example.com \
#       --email  you@example.com \
#       --repo   https://github.com/<you>/talonquest.git \
#       [--branch main] \
#       [--region us-central1] [--zone us-central1-a] \
#       [--machine e2-small] [--name talonquest]
#
# Idempotent: re-running with the same --name is safe; resources that already
# exist are skipped. Tear everything down with ./destroy.sh --name talonquest.

set -euo pipefail

NAME="talonquest"
REGION="us-central1"
ZONE="us-central1-a"
MACHINE="e2-small"
BRANCH="main"
DOMAIN=""
EMAIL=""
REPO=""

die() { echo "error: $*" >&2; exit 1; }

while [[ $# -gt 0 ]]; do
  case "$1" in
    --name)    NAME="$2"; shift 2;;
    --region)  REGION="$2"; shift 2;;
    --zone)    ZONE="$2"; shift 2;;
    --machine) MACHINE="$2"; shift 2;;
    --domain)  DOMAIN="$2"; shift 2;;
    --email)   EMAIL="$2"; shift 2;;
    --repo)    REPO="$2"; shift 2;;
    --branch)  BRANCH="$2"; shift 2;;
    -h|--help) sed -n '2,25p' "$0"; exit 0;;
    *) die "unknown flag: $1";;
  esac
done

[[ -n "$DOMAIN" ]] || die "--domain is required (public hostname you control)"
[[ -n "$EMAIL"  ]] || die "--email is required (for alert notifications)"
[[ -n "$REPO"   ]] || die "--repo is required (git https URL to clone)"

command -v gcloud >/dev/null || die "gcloud CLI not found; install google-cloud-sdk first"
PROJECT="$(gcloud config get-value project 2>/dev/null || true)"
[[ -n "$PROJECT" ]] || die "no gcloud project configured; run: gcloud config set project <project>"

echo "==> project=$PROJECT  name=$NAME  region=$REGION  machine=$MACHINE"
echo "==> domain=$DOMAIN  email=$EMAIL"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

echo "==> Enabling required APIs (idempotent)"
gcloud services enable \
  compute.googleapis.com \
  monitoring.googleapis.com \
  logging.googleapis.com \
  --quiet

echo "==> Reserving static external IP ($NAME-ip)"
if ! gcloud compute addresses describe "$NAME-ip" --region "$REGION" &>/dev/null; then
  gcloud compute addresses create "$NAME-ip" --region "$REGION" --quiet
fi
IP="$(gcloud compute addresses describe "$NAME-ip" --region "$REGION" --format='value(address)')"
echo "    static IP: $IP"

echo "==> Creating firewall rules (HTTP/HTTPS)"
if ! gcloud compute firewall-rules describe "$NAME-allow-web" &>/dev/null; then
  gcloud compute firewall-rules create "$NAME-allow-web" \
    --allow tcp:80,tcp:443 \
    --target-tags "$NAME-web" \
    --description "Let TalonQuest's Caddy serve HTTP(S)" \
    --quiet
fi

echo "==> Creating VM $NAME (startup script bootstraps Node, Caddy, TalonQuest)"
if ! gcloud compute instances describe "$NAME" --zone "$ZONE" &>/dev/null; then
  gcloud compute instances create "$NAME" \
    --zone "$ZONE" \
    --machine-type "$MACHINE" \
    --image-family debian-12 \
    --image-project debian-cloud \
    --boot-disk-size 20GB \
    --boot-disk-type pd-standard \
    --address "$IP" \
    --tags "$NAME-web" \
    --labels "app=$NAME,managed_by=provision-sh" \
    --metadata="DOMAIN=${DOMAIN},REPO=${REPO},BRANCH=${BRANCH}" \
    --metadata-from-file "startup-script=${SCRIPT_DIR}/setup.sh" \
    --quiet
else
  echo "    VM already exists, leaving it alone (destroy.sh to recreate)"
fi

echo "==> Creating email notification channel ($EMAIL)"
CHANNEL_NAME="$(gcloud alpha monitoring channels list \
  --filter="type=email AND labels.email_address=$EMAIL AND displayName:TalonQuest" \
  --format='value(name)' | head -n 1 || true)"
if [[ -z "$CHANNEL_NAME" ]]; then
  CHANNEL_NAME="$(gcloud alpha monitoring channels create \
    --display-name="TalonQuest alerts to $EMAIL" \
    --type=email \
    --channel-labels="email_address=$EMAIL" \
    --format='value(name)')"
fi
echo "    channel: $CHANNEL_NAME"

echo "==> Applying alert policies"
for policy_tpl in "$SCRIPT_DIR"/alerts/*.yaml; do
  [[ -f "$policy_tpl" ]] || continue
  tmp="$(mktemp)"
  sed -e "s|__CHANNEL__|${CHANNEL_NAME}|g" \
      -e "s|__NAME__|${NAME}|g" \
      "$policy_tpl" > "$tmp"
  # Skip templates that still have unresolved placeholders (e.g. uptime.yaml
  # needs an uptime check ID that the user must create in the console).
  if grep -q '__[A-Z_]\+__' "$tmp"; then
    echo "    skipping $(basename "$policy_tpl") (unresolved placeholder)"
    rm -f "$tmp"; continue
  fi
  display="$(awk -F': ' '/^displayName:/ {print $2; exit}' "$tmp" | tr -d '"')"
  existing="$(gcloud alpha monitoring policies list \
    --filter="displayName=\"${display}\"" --format='value(name)' | head -n 1 || true)"
  if [[ -n "$existing" ]]; then
    gcloud alpha monitoring policies update "$existing" --policy-from-file="$tmp" --quiet
  else
    gcloud alpha monitoring policies create --policy-from-file="$tmp" --quiet
  fi
  rm -f "$tmp"
done

echo "==> Importing Cloud Monitoring dashboard"
if [[ -f "$SCRIPT_DIR/dashboard.json" ]]; then
  existing_dash="$(gcloud monitoring dashboards list \
    --filter='displayName="TalonQuest"' --format='value(name)' | head -n 1 || true)"
  if [[ -n "$existing_dash" ]]; then
    gcloud monitoring dashboards update "$existing_dash" \
      --config-from-file="$SCRIPT_DIR/dashboard.json" --quiet
  else
    gcloud monitoring dashboards create \
      --config-from-file="$SCRIPT_DIR/dashboard.json" --quiet
  fi
fi

echo
echo "=============================================================="
echo "  TalonQuest infra provisioned."
echo "=============================================================="
echo
echo "  VM         : $NAME ($MACHINE) in $ZONE"
echo "  Static IP  : $IP"
echo "  Domain     : $DOMAIN"
echo
echo "  Next steps you must do yourself:"
echo "    1) Point your DNS A record for $DOMAIN at $IP."
echo "       (GCP can't do this unless the domain is in Cloud DNS.)"
echo "    2) Create a billing budget (the only real cost cap):"
echo "         deploy/gcp/budget.sh --amount 25 --email $EMAIL"
echo "    3) Wait ~2 minutes for the VM's startup script to finish, then open"
echo "         https://$DOMAIN/"
echo "       Tail the bootstrap log to watch progress:"
echo "         gcloud compute ssh $NAME --zone $ZONE --command \\"
echo "           'sudo journalctl -u google-startup-scripts -f'"
echo "    4) Dashboard + alerts:"
echo "         https://console.cloud.google.com/monitoring/dashboards"
echo
echo "  Tear everything down and stop all charges:"
echo "    deploy/gcp/destroy.sh --name $NAME --region $REGION --zone $ZONE"
echo
