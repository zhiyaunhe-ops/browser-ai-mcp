'use strict';

const { spawnSync } = require('node:child_process');
const { existsSync } = require('node:fs');
const path = require('node:path');

const toolkitEntry = () => process.env.BROWSER_AI_REVIEW_TOOLKIT || path.join(__dirname, '..', 'vendor', 'review', 'review.py');

function callReviewToolkit(command, input, args = []) {
  const entry = toolkitEntry();
  const python = process.env.BROWSER_AI_REVIEW_PYTHON || (process.platform === 'win32' ? 'python' : 'python3');
  const failure = (code, message) => Object.assign(new Error(message), { code });
  const result = spawnSync(python, ['-B', '-X', 'utf8', entry, command, ...args], {
    encoding: 'utf8', input: JSON.stringify(input)
  });
  if (result.error?.code === 'ENOENT') {
    throw failure('EVAL_PYTHON_MISSING', 'Local evaluation needs Python 3.11+. Set BROWSER_AI_REVIEW_PYTHON to its executable.');
  }
  if (result.error?.code === 'ENOBUFS') {
    throw failure('EVAL_TOOLKIT_OUTPUT_LIMIT', 'The Toolkit output exceeded the response limit. Query review_history with problem_id or attempt_id to narrow the result.');
  }
  let response;
  try {
    response = JSON.parse(result.stdout);
  } catch (_) {
    throw failure('EVAL_TOOLKIT_UNAVAILABLE', `Cannot run the review engine at ${entry} with ${python}. Check BROWSER_AI_REVIEW_PYTHON and any BROWSER_AI_REVIEW_TOOLKIT override. ${result.error?.message || result.stderr?.trim() || ''}`.trim());
  }
  if (response?.ok === false) throw failure(response.code, response.message);
  const observationReceipt = command === 'observe' && response?.source === input.source
    && Number.isInteger(response.recorded) && Number.isInteger(response.replayed);
  if (result.status !== 0 || (command !== 'history' && !observationReceipt && response?.ok !== true)) {
    throw failure('EVAL_TOOLKIT_UNAVAILABLE', result.stderr?.trim() || 'The review Toolkit exited before completing the operation.');
  }
  return response;
}

function resolveDomainTag(input) {
  if (input.domain_tag === undefined && !input.business_tool && !existsSync(toolkitEntry())) return undefined;
  try {
    return callReviewToolkit('resolve-domain', input).domain_tag ?? undefined;
  } catch (error) {
    if (error.code === 'EVAL_PYTHON_MISSING' && input.domain_tag === undefined && !input.business_tool) return undefined;
    throw error;
  }
}

function resolveDomainTags(items) {
  if (!items.length || !existsSync(toolkitEntry())) return [];
  try {
    return callReviewToolkit('resolve-domains', { items }).domain_tags;
  } catch (error) {
    if (error.code === 'EVAL_PYTHON_MISSING') return [];
    throw error;
  }
}

module.exports = { callReviewToolkit, resolveDomainTag, resolveDomainTags };
