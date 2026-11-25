'use strict';

const { spawnSync } = require('node:child_process');
const { existsSync } = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const toolkitEntry = () => process.env.BROWSER_AI_REVIEW_TOOLKIT || path.join(os.homedir(), 'yonclaw-toolkit', 'runtime', 'review.py');

function callReviewToolkit(command, input, args = []) {
  const entry = toolkitEntry();
  const python = process.env.BROWSER_AI_REVIEW_PYTHON || (process.platform === 'win32' ? 'python' : 'python3');
  const failure = (code, message) => Object.assign(new Error(message), { code });
  const result = spawnSync(python, ['-X', 'utf8', entry, command, ...args], {
    encoding: 'utf8', input: JSON.stringify(input)
  });
  if (result.error?.code === 'ENOBUFS') {
    throw failure('EVAL_TOOLKIT_OUTPUT_LIMIT', 'The Toolkit output exceeded the response limit. Query review_history with problem_id or attempt_id to narrow the result.');
  }
  let response;
  try {
    response = JSON.parse(result.stdout);
  } catch (_) {
    throw failure('EVAL_TOOLKIT_UNAVAILABLE', `Cannot run the review Toolkit. Install YonClaw Toolkit and set BROWSER_AI_REVIEW_TOOLKIT to its runtime/review.py. Check BROWSER_AI_REVIEW_PYTHON if needed. ${result.error?.message || result.stderr?.trim() || ''}`.trim());
  }
  if (response?.ok === false) throw failure(response.code, response.message);
  if (result.status !== 0 || (command !== 'history' && response?.ok !== true)) {
    throw failure('EVAL_TOOLKIT_UNAVAILABLE', result.stderr?.trim() || 'The review Toolkit exited before completing the operation.');
  }
  return response;
}

function resolveDomainTag(input) {
  if (input.domain_tag === undefined && !input.business_tool && !existsSync(toolkitEntry())) return undefined;
  return callReviewToolkit('resolve-domain', input).domain_tag ?? undefined;
}

function resolveDomainTags(items) {
  if (!items.length || !existsSync(toolkitEntry())) return [];
  return callReviewToolkit('resolve-domains', { items }).domain_tags;
}

module.exports = { callReviewToolkit, resolveDomainTag, resolveDomainTags };
