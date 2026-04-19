// TalonQuest billing kill switch.
//
// Triggered by Pub/Sub notifications published by the Cloud Billing budget
// (see deploy/gcp/kill-switch.sh). When cost exceeds the budget amount, this
// function calls Cloud Billing's updateProjectBillingInfo with an empty
// billingAccountName, which detaches the project from any billing account.
//
// Detaching billing stops all billable activity on the project — not just
// TalonQuest. That's the whole point: a hard "turn it all off" cap. To
// re-enable, go to Console → Billing → Account management → link the project
// back to a billing account. The Cloud Function itself will not re-enable it.

'use strict';

// Pure handler, exported for unit testing. Takes an already-constructed
// billing client so tests can stub it without monkey-patching require().
async function stopBillingImpl(cloudEvent, billing, projectId, logger) {
  const log = logger || console;
  const message = cloudEvent && cloudEvent.data && cloudEvent.data.message;
  if (!message || !message.data) {
    log.log('No Pub/Sub data in event; nothing to do.');
    return 'no-data';
  }

  const payload = JSON.parse(Buffer.from(message.data, 'base64').toString('utf8'));
  log.log('Budget notification:', JSON.stringify(payload));

  const cost = Number(payload.costAmount);
  const cap  = Number(payload.budgetAmount);
  const displayName = payload.budgetDisplayName || '(unnamed budget)';

  if (!isFinite(cost) || !isFinite(cap)) {
    log.log('Malformed budget payload; skipping.');
    return 'malformed';
  }
  if (cost < cap) {
    log.log(`Cost ${cost} still below cap ${cap} for ${displayName}; no action.`);
    return 'under-cap';
  }
  if (!projectId) {
    log.error('No project id; cannot disable billing.');
    return 'no-project';
  }

  const name = `projects/${projectId}`;
  const [info] = await billing.getProjectBillingInfo({name});
  if (!info.billingEnabled) {
    log.log(`Billing already disabled on ${name}; no-op.`);
    return 'already-disabled';
  }

  log.log(`Budget ${displayName} exceeded (${cost} >= ${cap}). Disabling billing on ${name}.`);
  const [updated] = await billing.updateProjectBillingInfo({
    name,
    projectBillingInfo: {billingAccountName: ''},
  });
  log.log('Billing disabled:', JSON.stringify(updated));
  return 'disabled';
}

module.exports = {stopBillingImpl};

// Only register the function-framework binding when loaded as the entry
// point. Skipping this during unit tests avoids a network-touching client.
if (require.main !== module && process.env.TALONQUEST_SKIP_FF !== '1') {
  const functions = require('@google-cloud/functions-framework');
  const {CloudBillingClient} = require('@google-cloud/billing');
  const billing = new CloudBillingClient();

  functions.cloudEvent('stopBilling', (cloudEvent) =>
    stopBillingImpl(
      cloudEvent,
      billing,
      process.env.GCP_PROJECT ||
        process.env.GOOGLE_CLOUD_PROJECT ||
        process.env.FUNCTION_TARGET_PROJECT
    )
  );
}
