'use strict';

function fieldError(code, message) {
  return Object.assign(new Error(message), { code });
}

async function setField(runYonbuilder, target, a) {
  const argv = ['yonbuilder', 'ui', 'set-prop', ...target(a), '--group-id', a.group,
    '--prop', a.property, '--value=' + a.value, '--format', 'json'];
  if (a.org) argv.push('--org', a.org);
  if (a.terminal) argv.push('--terminal', a.terminal);
  const write = await runYonbuilder('bip-cli', argv);
  if (write?.success !== true) throw fieldError('FIELD_WRITE_UNCONFIRMED', 'Field write returned no success receipt. Inspect the field before retrying.');
  // Dry-run fetches fresh settings and applies the native property mapping (including inverse required).
  let actual;
  try {
    actual = await runYonbuilder('bip-cli', [...argv, '--dry-run']);
  } catch (error) {
    error.message = 'Field write succeeded but readback failed. ' + error.message;
    throw error;
  }
  const selected = write.results?.[0];
  const read = actual?.results?.[0];
  const verified = write.results?.length === 1 && actual?.results?.length === 1 &&
    selected.groupId === a.group && read.groupId === a.group && selected.designId === read.designId &&
    actual.microserviceCode === a.microservice && actual.billNo === a.bill && actual.tplId === a.template &&
    actual.field === a.field && actual.prop === a.property && actual.dryRun === true && read.status === 'unchanged';
  if (!verified) throw fieldError('FIELD_VERIFICATION_FAILED', 'Write succeeded but fresh template settings did not confirm the requested field and value.');
  return { template: a.template, field: a.field, group: a.group, property: a.property,
    changed: write.appliedCount > 0, verified, value: read.oldValue };
}

module.exports = { setField };
