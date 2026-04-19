#!/usr/bin/env bash
# Wire the TalonQuest billing budget to a Cloud Function that detaches the
# project from billing when costs exceed the cap. This is a *hard* cap — it
# will stop every billable service in the project, not just TalonQuest.
#
# Prereqs:
#   - You must have roles/billing.admin (or equivalent) on the billing account
#     so the IAM binding for the function's service account can be created.
#   - You must have already run deploy/gcp/budget.sh so a TalonQuest budget
#     exists to wire up.
#
# Usage:
#   ./kill-switch.sh
#       [--name talonquest] [--region us-central1]
#       [--billing-account <ID>]    # default: the project's current BA
#       [--budget "TalonQuest monthly cap"]  # default matches budget.sh

set -euo pipefail

NAME="talonquest"
REGION="us-central1"
BUDGET_DISPLAY="TalonQuest monthly cap"
BILLING_ACCOUNT=""

die() { echo "error: $*" >&2; exit 1; }

while [[ $# -gt 0 ]]; do
  case "$1" in
    --name)            NAME="$2"; shift 2;;
    --region)          REGION="$2"; shift 2;;
    --budget)          BUDGET_DISPLAY="$2"; shift 2;;
    --billing-account) BILLING_ACCOUNT="$2"; shift 2;;
    -h|--help) sed -n '2,20p' "$0"; exit 0;;
    *) die "unknown flag: $1";;
  esac
done

command -v gcloud >/dev/null || die "gcloud CLI not found"
PROJECT="$(gcloud config get-value project 2>/dev/null || true)"
[[ -n "$PROJECT" ]] || die "no gcloud project configured"

if [[ -z "$BILLING_ACCOUNT" ]]; then
  BILLING_ACCOUNT="$(gcloud beta billing projects describe "$PROJECT" \
    --format='value(billingAccountName)' | sed 's|billingAccounts/||')"
fi
[[ -n "$BILLING_ACCOUNT" ]] || die "could not resolve billing account for $PROJECT"

TOPIC="${NAME}-budget"
FUNC="${NAME}-stop-billing"
SA_NAME="${NAME}-kill-switch"
SA_EMAIL="${SA_NAME}@${PROJECT}.iam.gserviceaccount.com"
SRC_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/kill-switch"

echo "==> project=$PROJECT  billing_account=$BILLING_ACCOUNT"
echo "==> topic=$TOPIC  function=$FUNC  sa=$SA_EMAIL"

echo "==> Enabling required APIs"
gcloud services enable \
  pubsub.googleapis.com \
  cloudfunctions.googleapis.com \
  cloudbilling.googleapis.com \
  cloudbuild.googleapis.com \
  run.googleapis.com \
  eventarc.googleapis.com \
  iam.googleapis.com \
  --quiet

echo "==> Creating Pub/Sub topic"
if ! gcloud pubsub topics describe "$TOPIC" >/dev/null 2>&1; then
  gcloud pubsub topics create "$TOPIC" --quiet
fi

echo "==> Creating kill-switch service account"
if ! gcloud iam service-accounts describe "$SA_EMAIL" >/dev/null 2>&1; then
  gcloud iam service-accounts create "$SA_NAME" \
    --display-name="TalonQuest budget kill switch" --quiet
fi

echo "==> Granting roles/billing.projectManager on the billing account"
# projectManager is the minimum role that can detach billing from a project.
gcloud billing accounts add-iam-policy-binding "$BILLING_ACCOUNT" \
  --member="serviceAccount:$SA_EMAIL" \
  --role="roles/billing.projectManager" \
  --condition=None \
  --quiet

echo "==> Deploying Cloud Function (Gen2)"
gcloud functions deploy "$FUNC" \
  --gen2 \
  --region "$REGION" \
  --runtime nodejs20 \
  --source "$SRC_DIR" \
  --entry-point stopBilling \
  --trigger-topic "$TOPIC" \
  --service-account "$SA_EMAIL" \
  --set-env-vars "GCP_PROJECT=${PROJECT}" \
  --max-instances=1 \
  --memory=256Mi \
  --timeout=60s \
  --quiet

echo "==> Locating budget '$BUDGET_DISPLAY'"
BUDGET_NAME="$(gcloud billing budgets list \
  --billing-account="$BILLING_ACCOUNT" \
  --filter="displayName=\"${BUDGET_DISPLAY}\"" \
  --format='value(name)' | head -n 1 || true)"
[[ -n "$BUDGET_NAME" ]] || die "budget '$BUDGET_DISPLAY' not found. Run budget.sh first."
BUDGET_ID="${BUDGET_NAME##*/}"

echo "==> Wiring budget $BUDGET_ID to topic $TOPIC"
gcloud billing budgets update "$BUDGET_ID" \
  --billing-account="$BILLING_ACCOUNT" \
  --all-updates-rule-pubsub-topic="projects/${PROJECT}/topics/${TOPIC}" \
  --quiet

cat <<EOF

==============================================================
  Kill switch armed.
==============================================================

  Project   : $PROJECT
  Budget    : $BUDGET_DISPLAY  (id: $BUDGET_ID)
  Topic     : projects/${PROJECT}/topics/${TOPIC}
  Function  : $FUNC  (region $REGION)

  When this project's costs exceed the budget, the function will detach
  the project from its billing account. Every billable resource in the
  project — not just TalonQuest — will stop.

  To re-enable billing afterwards:
    Console -> Billing -> Account management -> link the project back
    to a billing account. The Cloud Function will NOT re-arm until the
    next Pub/Sub notification after re-linking.

  Test the handler locally without touching billing:
    gcloud pubsub topics publish $TOPIC \\
      --message='{"costAmount": 999, "budgetAmount": 1, "budgetDisplayName": "dry-run"}'
    gcloud functions logs read $FUNC --region $REGION --gen2 --limit 20

  Disarm (keeps the VM and alerts running):
    gcloud functions delete $FUNC --region $REGION --gen2 --quiet
    gcloud pubsub topics delete $TOPIC --quiet

EOF
