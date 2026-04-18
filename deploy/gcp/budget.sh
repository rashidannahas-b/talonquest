#!/usr/bin/env bash
# Create a Cloud Billing budget scoped to the TalonQuest project, with email
# alerts at 50/90/100/120% of the monthly cap. Budgets live at the billing
# account level, so this is separate from provision.sh (which only needs
# project-level permissions).
#
# NOTE: GCP budgets *alert* by default; they do not automatically cap spend.
# For a hard cap, wire the Pub/Sub notifications to a Cloud Function that
# disables billing on the project:
#   https://cloud.google.com/billing/docs/how-to/notify#cap_disable_billing_to_stop_usage
#
# Usage:
#   ./budget.sh --amount 25 --email you@example.com
#       [--billing-account <ID>]  (defaults to the project's current billing account)
#       [--currency USD] [--name "TalonQuest monthly cap"]

set -euo pipefail

AMOUNT=""
EMAIL=""
CURRENCY="USD"
NAME="TalonQuest monthly cap"
BILLING_ACCOUNT=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --amount)          AMOUNT="$2"; shift 2;;
    --email)           EMAIL="$2"; shift 2;;
    --currency)        CURRENCY="$2"; shift 2;;
    --name)            NAME="$2"; shift 2;;
    --billing-account) BILLING_ACCOUNT="$2"; shift 2;;
    *) echo "unknown flag: $1" >&2; exit 1;;
  esac
done

[[ -n "$AMOUNT" ]] || { echo "--amount is required (e.g. 25)"; exit 1; }
[[ -n "$EMAIL"  ]] || { echo "--email is required"; exit 1; }

PROJECT="$(gcloud config get-value project 2>/dev/null)"
[[ -n "$PROJECT" ]] || { echo "no gcloud project configured"; exit 1; }

if [[ -z "$BILLING_ACCOUNT" ]]; then
  BILLING_ACCOUNT="$(gcloud beta billing projects describe "$PROJECT" \
    --format='value(billingAccountName)' | sed 's|billingAccounts/||')"
fi
[[ -n "$BILLING_ACCOUNT" ]] || { echo "could not determine billing account"; exit 1; }

echo "==> project=$PROJECT billing-account=$BILLING_ACCOUNT amount=${AMOUNT} ${CURRENCY}"

# Create or reuse an email notification channel for the budget.
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

echo "==> Creating monthly budget ($NAME) scoped to $PROJECT"
gcloud billing budgets create \
  --billing-account="$BILLING_ACCOUNT" \
  --display-name="$NAME" \
  --budget-amount="${AMOUNT}${CURRENCY}" \
  --threshold-rule=percent=0.5 \
  --threshold-rule=percent=0.9 \
  --threshold-rule=percent=1.0 \
  --threshold-rule=percent=1.2 \
  --filter-projects="projects/${PROJECT}" \
  --notifications-rule-monitoring-notification-channels="$CHANNEL_NAME" \
  --notifications-rule-disable-default-iam-recipients \
  --quiet

echo
echo "Budget created. Check it at:"
echo "  https://console.cloud.google.com/billing/${BILLING_ACCOUNT}/budgets"
