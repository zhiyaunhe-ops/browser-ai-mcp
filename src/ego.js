'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { createHash } = require('node:crypto');
const { pathToFileURL } = require('node:url');

function read(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}
function write(file, data) {
  const temporary = file + '.tmp';
  fs.writeFileSync(temporary, JSON.stringify(data));
  fs.renameSync(temporary, file);
}

function notStarted(error) {
  return { state: 'failed', executionStopped: true, executionStarted: false, finishDispatched: false,
    error: { code: error?.code || 'EGO_PREPARATION_FAILED', message: String(error?.message || error), executionStarted: false } };
}

class EgoAdapter {
  constructor(options = {}) {
    this.command = options.command || process.env.BROWSER_AI_EGO_BIN || 'ego-browser';
    this.children = new Map();
  }

  run(options) { return this.launch({ ...options, mode: 'run' }).catch(notStarted); }
  finish(options) {
    return this.launch({ ...options, mode: 'finish', executionId: options.executionId,
      timeoutMs: options.timeoutMs || 30000 }).catch(notStarted);
  }

  async launch(options) {
    const directory = options.directory;
    fs.mkdirSync(directory, { recursive: true });
    const script = path.join(directory, 'round.mjs');
    const configuration = { runId: options.runId, executionId: options.executionId,
      spaceId: options.spaceId ?? null, name: options.name || `browser-ai:${options.runId}`,
      pageLabel: options.pageLabel || 'p1', args: options.args ?? null, pageMemoRead: options.pageMemoRead,
      resumeAfterUserAction: options.resumeAfterUserAction === true,
      keep: options.keep || [], mode: options.mode, directory: directory.replaceAll('\\', '/') };
    // The installed ego runtime supplies taskSpace/Page. This module runs INSIDE
    // ego-browser nodejs, not in the MCP host's ordinary Node environment.
    // 每轮注入的 memo prelude：在 page 可见处安装补丁（坐标点击自动补 label、计数、ys 助手）。
    // 用户代码放在其后，行号会整体后移，报错位置按诊断里的 stack 对齐即可。
    const memoPath = path.join(__dirname, '..', 'scripts', 'ego-memo.mjs');
    const memoRevision = createHash('sha256');
    for (const file of [memoPath, path.join(__dirname, 'memo.js'),
      path.join(__dirname, '..', 'scripts', 'ys-locate.mjs'),
      path.join(__dirname, '..', 'scripts', 'ys-page.mjs'),
      path.join(__dirname, '..', 'scripts', 'ys-transfer.mjs'), path.join(__dirname, 'program-contract.js')]) {
      memoRevision.update(fs.readFileSync(file));
    }
    // Ego may retain ESM imports across rounds. A changed helper needs a new URL.
    const memoUrl = `${pathToFileURL(memoPath).href}?revision=${memoRevision.digest('hex').slice(0, 16)}`;
    const prelude = options.memo === false || process.env.EGO_MEMO === '0' ? '' : `
memoModule = await import(${JSON.stringify(memoUrl)});
memoPage = page;
await memoModule.install(page, { task, pageLabel: config.pageLabel });
console.log(memoModule.banner());`;
    const source = `
const fs = await import('node:fs/promises');
const config = ${JSON.stringify(configuration)};
async function save(name, value) {
  const target = config.directory + '/' + name;
  await fs.writeFile(target + '.tmp', JSON.stringify(value), 'utf8');
  await fs.rename(target + '.tmp', target);
}
let task;
let envelope;
let memoModule;
let memoPage;
let finishDispatched = false;
try {
  await save('started.json', { executionId: config.executionId, pid: process.pid, startedAt: Date.now() });
  task = config.resumeAfterUserAction
    ? await takeOverTaskSpace(config.spaceId)
    : await taskSpace(config.spaceId ?? config.name);
  await save('context.json', { executionId: config.executionId, spaceId: task.spaceId });
  let result;
  if (config.mode === 'finish') {
    finishDispatched = true;
    await task.finish({ keep: config.keep });
    result = { finished: true };
  } else {
    const page = task.page(config.pageLabel);
    const input = config.args;
${prelude}
    // Bind helpers to this execution instead of the daemon's mutable global.
    const ys = memoModule ? page.ys : undefined;
    result = await (async () => {
${options.mode === 'run' ? options.code : ''}
    })();
  }
  envelope = { executionId: config.executionId, runId: config.runId,
    spaceId: task.spaceId, state: 'succeeded', result: result === undefined ? null : result,
    executionStopped: true, executionStarted: true, finishDispatched, finishedAt: Date.now() };
  // Serialize before saving so non-JSON return values become a captured error.
  JSON.stringify(envelope);
} catch (error) {
  const message = String(error?.message || error);
  const code = error?.code || error?.error_code || 'EGO_EXECUTION_FAILED';
  const late = error?.mayHaveLateEffects === true || error?.executionStopped === false;
  // Cleanup (mode 'finish') has no verification step of its own. A space that is
  // already gone satisfies the goal, and a space the user took over must be left
  // with the user — neither is an unknown outcome, and neither dispatched a finish
  // the runtime accepted, so the run may settle instead of waiting for a human.
  const settledCode = code === 'EGO_TASK_SPACE_USER_IN_CONTROL' || /task space not found/i.test(message);
  if (config.mode === 'finish' && !late && settledCode) {
    envelope = { executionId: config.executionId, runId: config.runId,
      spaceId: task?.spaceId ?? config.spaceId ?? null, state: 'skipped',
      result: { finished: false, reason: code === 'EGO_TASK_SPACE_USER_IN_CONTROL' ? 'user-in-control' : 'already-gone' },
      executionStopped: true, executionStarted: true, finishDispatched: false,
      error: { code, message, mayHaveLateEffects: false }, finishedAt: Date.now() };
  } else {
    envelope = { executionId: config.executionId, runId: config.runId,
      spaceId: task?.spaceId, state: late ? 'outcome_unknown' : 'failed',
      executionStopped: !late, executionStarted: true, finishDispatched, error: { code,
        message, mayHaveLateEffects: late }, finishedAt: Date.now() };
  }
}
// Capture settled reads even when user code failed. No memo means unavailable,
// rather than a fabricated zero-reader round. Never replace the original error.
try {
  if (memoModule && memoPage) {
    envelope.memo = memoModule.report(memoPage);
    envelope.observationTrace = memoModule.observationTrace(memoPage);
  }
} catch { /* Telemetry must not change execution outcome. */ }
if (memoModule && memoPage && config.pageMemoRead && envelope.state === 'succeeded') {
  try { envelope.pageContext = await memoModule.readMemoContext(memoPage, config.pageMemoRead); }
  catch { /* A closed or navigating page can no longer supply a reminder. */ }
}
await save('result.json', envelope);
`;
    fs.writeFileSync(script, source, 'utf8');
    const entry = `await import('${pathToFileURL(script).href.replaceAll("'", '%27')}')`;
    return new Promise(resolve => {
      let child;
      let spawned = false;
      let settled = false;
      let timer;
      const diagnostics = [];
      const diagnostic = (stage, error) => {
        diagnostics.push({ stage, code: error.code || 'EGO_ARTIFACT_ERROR', message: String(error.message || error), at: Date.now() });
        try { write(path.join(directory, 'diagnostics.json'), { executionId: options.executionId, diagnostics }); }
        catch (_) { /* The returned result still carries diagnostics when the directory cannot be written. */ }
      };
      const safeWrite = (name, value) => {
        try { write(path.join(directory, name), value); return true; }
        catch (error) { diagnostic(name, error); return false; }
      };
      const settle = result => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(diagnostics.length ? { ...result, diagnostics: [...(result.diagnostics || []), ...diagnostics] } : result);
      };
      const uncertain = (code, message, stopped = false) => ({ executionId: options.executionId, runId: options.runId, state: 'outcome_unknown', executionStopped: stopped,
        executionStarted: true, finishDispatched: null, error: { code, message, executionStarted: true } });
      try {
        child = spawn(this.command, ['nodejs', '-e', entry], {
          cwd: directory, shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe']
        });
      } catch (error) {
        const result = notStarted(error);
        safeWrite('result.json', { ...result, executionId: options.executionId, runId: options.runId });
        settle(result);
        return;
      }
      this.children.set(options.executionId, child);
      const logs = [];
      const capture = (source, name) => {
        if (!source) return;
        source.on('error', error => diagnostic(`${name}:source`, error));
        try {
          const stream = fs.createWriteStream(path.join(directory, name), { flags: 'a' });
          stream.on('error', error => {
            diagnostic(name, error);
            try { source.unpipe(stream); source.resume(); }
            catch (drainError) { diagnostic(`${name}:drain`, drainError); }
          });
          logs.push(stream);
          source.pipe(stream);
        } catch (error) {
          diagnostic(name, error);
          try { source.resume(); } catch (drainError) { diagnostic(`${name}:drain`, drainError); }
        }
      };
      capture(child.stdout, 'stdout.log');
      capture(child.stderr, 'stderr.log');
      child.once('spawn', () => {
        spawned = true;
        safeWrite('process.json', { executionId: options.executionId, pid: child.pid, ownerId: options.ownerId || null, startedAt: Date.now() });
      });
      child.once('error', error => {
        diagnostic('child-process', error);
        if (!spawned) {
          this.children.delete(options.executionId);
          const result = notStarted(error);
          safeWrite('result.json', { ...result, executionId: options.executionId, runId: options.runId });
          settle(result);
        } else settle(uncertain(error.code || 'EGO_PROCESS_ERROR', error.message));
      });
      child.once('close', (code, signal) => {
        for (const stream of logs) {
          try { stream.end(); } catch (error) { diagnostic('log-close', error); }
        }
        this.children.delete(options.executionId);
        safeWrite('exit.json', { executionId: options.executionId,
          code, signal, exitedAt: Date.now() });
        let result;
        try { result = read(path.join(directory, 'result.json')); }
        catch (error) { diagnostic('result.json', error); result = uncertain('EGO_RESULT_INVALID', error.message, true); }
        if (!result) result = uncertain('EGO_RESULT_MISSING', `ego exited (${code ?? signal}) without a result; inspect the saved stderr.log and current business state`, true);
        if (result.executionId !== options.executionId) {
          result = uncertain('EGO_RESULT_MISMATCH', 'Execution result belongs to another invocation', true);
        }
        settle(result);
      });
      timer = setTimeout(() => {
        // Ending the wait does not establish that a browser side effect stopped.
        settle(uncertain('EGO_TIMEOUT', 'The ego invocation is still unresolved; query run_get rather than resending it'));
      }, options.timeoutMs || 30000);
    });
  }

  async recover(execution) {
    if (!execution.directory) return null;
    const diagnostics = [];
    const artifact = name => {
      try {
        const value = read(path.join(execution.directory, name));
        if (value && value.executionId !== execution.executionId) {
          diagnostics.push({ stage: name, code: 'EGO_ARTIFACT_MISMATCH', message: 'Artifact belongs to another invocation' });
          return null;
        }
        return value;
      } catch (error) {
        diagnostics.push({ stage: name, code: 'EGO_ARTIFACT_INVALID', message: error.message });
        return null;
      }
    };
    const context = artifact('context.json');
    const unknown = (code, message, stopped = false) => ({ state: 'outcome_unknown', spaceId: context?.spaceId,
      executionStopped: stopped, finishDispatched: null, error: { code, message }, ...(diagnostics.length ? { diagnostics } : {}) });
    // A wrapper can save its result while the official runtime is still tearing down.
    // Do not consume that result until the original owned child has actually closed.
    if (this.children.has(execution.executionId)) return { state: 'running', executionStopped: false, spaceId: context?.spaceId };
    const exited = artifact('exit.json');
    const processInfo = artifact('process.json');
    const started = artifact('started.json');
    let stopped = Boolean(exited);
    // process.json names the wrapper that ran this execution; started.json names the
    // shared ego daemon, which outlives every execution. Prefer the wrapper so a dead
    // wrapper settles the round instead of a permanently live daemon blocking it.
    const owner = [processInfo, started].find(value => value && Number.isSafeInteger(value.pid) && value.pid > 0);
    const candidates = owner ? [owner] : [];
    for (const value of candidates) {
      // A close marker for this execution settles every recorded PID: exit.json is
      // written only after the official runtime child closed. started.json carries
      // the shared ego daemon PID, which outlives executions by design, so a live
      // PID there is not evidence of an unfinished invocation once the marker exists.
      if (exited) continue;
      try {
        process.kill(value.pid, 0);
        // PID occupancy alone cannot identify the invocation owner. Preserve the
        // uncertainty instead of treating a possibly reused PID as that owner.
        return unknown('EGO_PROCESS_UNCONFIRMED', 'A recorded process ID is occupied; invocation ownership and runtime teardown are not confirmed');
      } catch (error) {
        if (error.code !== 'ESRCH') return unknown('EGO_PROCESS_UNCONFIRMED', 'The recorded process could not be checked; runtime teardown is not confirmed');
        stopped = true;
      }
    }
    if (!stopped) return unknown('EGO_INTERRUPTED', 'Invocation exit or matching process completion evidence is unavailable; do not replay it');
    const result = artifact('result.json');
    const savedDiagnostics = artifact('diagnostics.json');
    if (Array.isArray(savedDiagnostics?.diagnostics)) diagnostics.push(...savedDiagnostics.diagnostics);
    if (!result) return unknown('EGO_RESULT_MISSING', 'The invocation stopped without a complete matching result file', true);
    // The wrapper saved this round as unknown while the runtime was still closing;
    // the close marker now proves the invocation ended, so the saved round is
    // settled even though its late effects stay unresolved.
    // The wrapper saved this round as unknown while it was still running (or was killed
    // before it could close). The owner process is gone now, so the round is settled
    // even though its late effects stay unresolved.
    const settled = stopped && result.state === 'outcome_unknown' ? { ...result, executionStopped: true } : result;
    return diagnostics.length ? { ...settled, diagnostics: [...(settled.diagnostics || []), ...diagnostics] } : settled;
  }
}

module.exports = { EgoAdapter };
