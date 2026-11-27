'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { cliFailure } = require('../src/cli-error');
for (const [path, stderr, summary] of [
  ['yonbuilder page list', 'unrecognized server response', '原因未确认'],
  ['workbench service list', 'unknown option --private', 'CLI 报告参数错误'],
]) {
  test(path + ' failure preserves scope and excludes sensitive output', () => {
    const err = cliFailure('bip-cli', [...path.split(' '), '--token', 'secret'], {
      code: 1, stderr: stderr + '\nCookie: secret', stdout: '{"message":"secret"}',
    });
    assert.equal(err.code, 'YONBUILDER_CLI_FAILED');
    assert.deepEqual(err.cli, { command: 'bip-cli ' + path, exitCode: 1, summary });
    assert.doesNotMatch(err.message + JSON.stringify(err), /secret|private/);
  });
}
