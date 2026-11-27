'use strict';

// Only expose known command paths and normalized diagnostics. CLI output can contain credentials.
const paths = [
  'whoami', 'system yonbip env', 'template importtpl list', 'workbench service list', 'system session list', 'yonbuilder app list', 'yonbuilder app get',
  'yonbuilder bizobj list', 'yonbuilder page list', 'yonbuilder ui fields', 'yonbuilder ui templates',
  'yonbuilder ui set-prop', 'yonbuilder page-designer info', 'metadata find', 'erm find', 'find',
];
function cliFailure(entry, argv, error) {
  const path = paths.find(candidate => candidate.split(' ').every((word, index) => argv[index] === word));
  const command = path ? entry + ' ' + path : entry;
  const output = [error.stderr, error.stdout].map(value => String(value || '')).join('\n');
  let summary = '原因未确认';
  if (/YonClaw Python (?:proxy requires|代理缺少)\s*yonbip-skill-utils/i.test(output)) summary = '托管 Python 无法导入 yonbip-skill-utils';
  else if (/用户没有当前功能[^\n]*的权限/.test(output)) summary = '当前业务身份缺少功能权限';
  else if (/unknown option|missing required argument|缺少必填参数/i.test(output)) summary = 'CLI 报告参数错误';
  else if (/session expired|会话已过期/i.test(output)) summary = 'CLI 报告会话已过期';
  else if (/YonCode 环境下不可用/i.test(output)) summary = 'CLI 报告此命令在 YonCode 环境下不可用';
  const exitCode = Number.isInteger(error.code) ? error.code : null;
  const failure = new Error(command + ' 执行失败。' + summary);
  failure.code = 'YONBUILDER_CLI_FAILED';
  failure.cli = { command, exitCode, summary };
  return failure;
}
module.exports = { cliFailure };
