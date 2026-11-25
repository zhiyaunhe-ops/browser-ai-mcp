'use strict';

const { execFileSync } = require('node:child_process');
const path = require('node:path');

function invalid(message) {
  return Object.assign(new Error(message), { code: 'IMPROVEMENT_ARTIFACT' });
}

function git(repository, ...args) {
  try {
    return execFileSync('git', ['--no-replace-objects', '--literal-pathspecs', ...args], {
      cwd: repository, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true
    });
  } catch {
    throw invalid('The local Git worktree must contain the specified commit and its first-parent history.');
  }
}

function committedFile(kind, { repository, commit, file, prUrl }) {
  if (typeof repository !== 'string' || !path.isAbsolute(repository)) {
    throw invalid('Provide the absolute path of the repository worktree.');
  }
  if (typeof commit !== 'string' || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i.test(commit)) {
    throw invalid('Provide the full Git commit object ID.');
  }
  if (typeof file !== 'string' || /[\\\0]/.test(file) || /^[a-z]:/i.test(file) ||
      file.split('/').some(part => ['', '.', '..'].includes(part))) {
    throw invalid('Provide a repository-relative file path using forward slashes.');
  }
  const root = path.resolve(git(repository, 'rev-parse', '--show-toplevel').replace(/\r?\n$/, ''));
  if (git(repository, 'rev-parse', '--show-prefix').replace(/\r?\n$/, '')) {
    throw invalid('Use the worktree root as the repository path.');
  }
  const version = git(root, 'rev-parse', '--verify', commit + '^{commit}').trim();
  if (version !== commit.toLowerCase()) throw invalid('The object ID must name the commit itself.');
  const entry = git(root, 'ls-tree', '-z', version, '--', file);
  const blob = /^\d+ blob ([a-f0-9]+)\t/.exec(entry)?.[1];
  if (!blob || entry.slice(entry.indexOf('\t') + 1) !== file + '\0' ||
      git(root, 'cat-file', '-t', blob).trim() !== 'blob') {
    throw invalid('The named file must exist as a blob in the specified commit.');
  }
  // Read the actual parent header. Shallow clones can otherwise present a boundary as a root commit.
  const headers = git(root, 'cat-file', 'commit', version).split('\n\n', 1)[0];
  const firstParent = /^parent ([a-f0-9]+)$/m.exec(headers)?.[1];
  if (firstParent && git(root, 'ls-tree', '-z', firstParent, '--', file) === entry) {
    throw invalid('The specified commit must change the named file relative to its first parent.');
  }
  return { kind, version, repository: root, file, blob, ...(prUrl ? { prUrl } : {}) };
}

function capturedRequest(service, runId, evidenceId) {
  if (typeof evidenceId !== 'string' || !evidenceId) throw invalid('Supply the captured request evidenceId.');
  const record = service.store.evidenceById(evidenceId, runId);
  if (record?.kind !== 'network' || record.captureSource !== 'ego-page' ||
      record.payload?.src !== 'ego-page' || record.payload.netType !== 'request') {
    throw invalid('Use a same-run ego-page request with recorded capture provenance. Older unmarked records have unknown provenance. Capture an authorized observation without repeating a write.');
  }
  const { method, url, queryKeys, requestShape, captureSkipped, sourceGap } = record.payload;
  return { evidenceId, executionId: record.executionId, method, url, queryKeys,
    ...(requestShape !== undefined ? { requestShape } : {}),
    ...(captureSkipped ? { captureSkipped } : {}), ...(sourceGap ? { sourceGap } : {}) };
}

function applyMemory(service, item, update) {
  if (!update || update.entry?.verification === 'verified' || update.patch?.verification === 'verified') {
    throw invalid('Supply a memoryUpdate and leave verification pending until re-evaluation.');
  }
  const run = service.run(item.runId);
  const review = service.store.get('evaluation', item.reviewId);
  if (review?.runId !== run.runId) throw invalid('The memory change requires the evaluation of the source run.');
  const handoff = [run.feedback, ...(run.feedbackHistory || [])].find(feedback => feedback?.requestId === review.reviewKey);
  if (!handoff) throw invalid('The evaluated handoff is unavailable.');
  const evidence = new Set([...review.evidenceIds, ...review.criterionResults.flatMap(row => row.evidenceIds)]);
  const [memoryId] = service.memory.applyUpdates(run, [update], [...evidence], handoff.outcome);
  const { revision } = service.memory.get(memoryId);
  return { kind: 'memory', version: memoryId + '@' + revision, memoryId, revision };
}

function applyArtifact(service, item, input) {
  if (!input || typeof input !== 'object') throw invalid('Supply the artifact details.');
  if (item.kind === 'memory') return applyMemory(service, item, input.memoryUpdate);
  if (!['code', 'script', 'request'].includes(item.kind)) throw invalid('Unsupported improvement artifact kind.');
  const artifact = committedFile(item.kind, input);
  if (item.kind === 'request') artifact.request = capturedRequest(service, item.runId, input.evidenceId);
  return artifact;
}

module.exports = { applyArtifact };
