#!/usr/bin/env bash
# Tear down every resource provision.sh created, in dependency order.
# Billing stops as soon as the VM + IP are gone.
#
# Usage:
#   ./destroy.sh --name talonquest [--region us-central1] [--zone us-central1-a]

set -euo pipefail

NAME="talonquest"
REGION="us-central1"
ZONE="us-central1-a"
YES=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --name)   NAME="$2"; shift 2;;
    --region) REGION="$2"; shift 2;;
    --zone)   ZONE="$2"; shift 2;;
    -y|--yes) YES=1; shift;;
    *) echo "unknown flag: $1" >&2; exit 1;;
  esac
done

echo "About to delete TalonQuest resources:"
echo "  - VM                $NAME (zone $ZONE)"
echo "  - static IP         $NAME-ip (region $REGION)"
echo "  - firewall rule     $NAME-allow-web"
echo "  - alert policies    matching '$NAME'"
echo "  - notification chan '$NAME alerts to *'"
echo "  - kill-switch       function $NAME-stop-billing, topic $NAME-budget"
echo "                      service account $NAME-kill-switch@"
echo
echo "This does NOT touch the billing budget (deploy/gcp/budget.sh created"
echo "it at the billing-account level; delete manually in the console if you"
echo "want that gone too)."
echo
if [[ -z "$YES" ]]; then
  read -r -p "Type the name '$NAME' to confirm: " confirm
  [[ "$confirm" == "$NAME" ]] || { echo "aborted"; exit 1; }
fi

# Warn early if the project is already detached from billing, because every
# gcloud command below will error out otherwise.
CURRENT_BA="$(gcloud beta billing projects describe \
  "$(gcloud config get-value project 2>/dev/null)" \
  --format='value(billingAccountName)' 2>/dev/null || true)"
if [[ -z "$CURRENT_BA" ]]; then
  echo "!! The project has no billing account linked — the kill switch likely"
  echo "!! fired. Re-link the project in the Console before running destroy,"
  echo "!! otherwise API calls below will fail."
  echo
fi

delete_if_exists() {
  local describe=("$1"); shift
  local delete=("$1"); shift
  if "${describe[@]}" &>/dev/null; then
    "${delete[@]}" --quiet
  fi
}

echo "==> Deleting VM"
if gcloud compute instances describe "$NAME" --zone "$ZONE" &>/dev/null; then
  gcloud compute instances delete "$NAME" --zone "$ZONE" --quiet
fi

echo "==> Deleting static IP"
if gcloud compute addresses describe "$NAME-ip" --region "$REGION" &>/dev/null; then
  gcloud compute addresses delete "$NAME-ip" --region "$REGION" --quiet
fi

echo "==> Deleting firewall rule"
if gcloud compute firewall-rules describe "$NAME-allow-web" &>/dev/null; then
  gcloud compute firewall-rules delete "$NAME-allow-web" --quiet
fi

echo "==> Removing alert policies named 'TalonQuest: *'"
while IFS=$'\t' read -r pname display; do
  [[ -n "$pname" ]] || continue
  echo "    removing $display"
  gcloud alpha monitoring policies delete "$pname" --quiet || true
done < <(gcloud alpha monitoring policies list \
            --filter='displayName:TalonQuest' \
            --format='value(name,displayName)')

echo "==> Removing TalonQuest email notification channels"
while IFS=$'\t' read -r cname display; do
  [[ -n "$cname" ]] || continue
  echo "    removing $display"
  gcloud alpha monitoring channels delete "$cname" --quiet || true
done < <(gcloud alpha monitoring channels list \
            --filter='displayName:TalonQuest' \
            --format='value(name,displayName)')

echo "==> Removing kill-switch Cloud Function"
if gcloud functions describe "$NAME-stop-billing" --region "$REGION" --gen2 &>/dev/null; then
  gcloud functions delete "$NAME-stop-billing" --region "$REGION" --gen2 --quiet || true
fi

echo "==> Removing kill-switch Pub/Sub topic"
if gcloud pubsub topics describe "$NAME-budget" &>/dev/null; then
  gcloud pubsub topics delete "$NAME-budget" --quiet || true
fi

echo "==> Removing kill-switch service account"
PROJECT="$(gcloud config get-value project 2>/dev/null || true)"
SA_EMAIL="${NAME}-kill-switch@${PROJECT}.iam.gserviceaccount.com"
if gcloud iam service-accounts describe "$SA_EMAIL" &>/dev/null; then
  gcloud iam service-accounts delete "$SA_EMAIL" --quiet || true
fi

echo
echo "Done. Billing for these resources has stopped."
echo "Reminder: the billing budget itself (if you created one with budget.sh)"
echo "still exists at the billing-account level. Delete it in the Cloud"
echo "Console if you no longer want the email alerts."
