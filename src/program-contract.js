'use strict';

const acorn = require('acorn');
const path = require('node:path');

// This is a compatibility check for mistakes observed with the installed Ego
// SDK, not an allowlist of JavaScript or browser capabilities.
const UNKNOWN = Symbol('unknown literal');
const DOM_GLOBALS = new Set(['document', 'window', 'location']);
const UNSUPPORTED = new Set(['$', 'locator', 'frames', 'wait']);

function validateCall(method, args = []) {
  const issues = [];
  const add = message => issues.push({ code: 'EGO_API_CONTRACT', message });
  const options = method === 'page.fill' ? args[2] : args[1];
  const has = (object, key) => object && object !== UNKNOWN && typeof object === 'object'
    && Object.prototype.hasOwnProperty.call(object, key);
  if (method === 'page.fill' && has(options, 'label')) {
    add('page.fill does not accept label; use fill(selector, value, { clearFirst?, timeout? }).');
  }
  if (method === 'page.goto' && has(options, 'timeoutMs')) {
    add('page.goto uses timeout, not timeoutMs: goto(url, { referer?, timeout?, waitUntil? }).');
  }
  if (method === 'page.screenshot') {
    const screenshotOptions = args[0];
    if (has(screenshotOptions, 'label')) add('page.screenshot does not accept label.');
    if (has(screenshotOptions, 'path') && typeof screenshotOptions.path === 'string'
      && !path.posix.isAbsolute(screenshotOptions.path) && !path.win32.isAbsolute(screenshotOptions.path)) {
      add('page.screenshot path must be absolute; omit path to let Ego choose its output file.');
    }
  }
  if (method === 'page.mouse.wheel') {
    if (args.length < 2 || args.slice(0, 2).some(value => value !== UNKNOWN && !Number.isFinite(value))) {
      add('page.mouse.wheel requires finite deltaX and deltaY: wheel(0, 600, { label? }).');
    }
  }
  if (method === 'page.mouse.down' && args.length && args[0] !== undefined && args[0] !== UNKNOWN
    && (args[0] === null || typeof args[0] !== 'object' || Array.isArray(args[0]))) {
    add('page.mouse.down expects an options object, for example { button: "left" }.');
  }
  return issues;
}

function assertCall(method, args) {
  const issues = validateCall(method, args);
  if (issues.length) {
    const error = new Error(issues.map(issue => issue.message).join('\n'));
    error.code = 'EGO_API_CONTRACT';
    error.issues = issues;
    throw error;
  }
}

function children(node) {
  const result = [];
  for (const [key, value] of Object.entries(node)) {
    if (key === 'loc' || key === 'start' || key === 'end') continue;
    if (Array.isArray(value)) {
      for (const item of value) if (item && typeof item.type === 'string') result.push(item);
    } else if (value && typeof value.type === 'string') result.push(value);
  }
  return result;
}

function propertyName(node) {
  if (!node || !['MemberExpression', 'Property'].includes(node.type)) return null;
  const key = node.type === 'Property' ? node.key : node.property;
  if (!node.computed && key.type === 'Identifier') return key.name;
  return key.type === 'Literal' && typeof key.value === 'string' ? key.value : null;
}

function literal(node) {
  if (!node) return undefined;
  if (node.type === 'Literal') return node.value;
  if (node.type === 'TemplateLiteral' && !node.expressions.length) return node.quasis[0].value.cooked;
  if (node.type === 'UnaryExpression' && ['+', '-'].includes(node.operator)) {
    const value = literal(node.argument);
    return typeof value === 'number' ? (node.operator === '-' ? -value : value) : UNKNOWN;
  }
  if (node.type === 'ObjectExpression') {
    const value = Object.create(null);
    for (const property of node.properties) {
      const key = propertyName(property);
      if (key !== null && property.kind === 'init' && !property.method) value[key] = literal(property.value);
    }
    return value;
  }
  return UNKNOWN;
}

function inspectProgram(code) {
  const issues = [];
  const warnings = [];
  let ast;
  try {
    ast = acorn.parse(code, { ecmaVersion: 'latest', sourceType: 'module', locations: true,
      allowAwaitOutsideFunction: true, allowReturnOutsideFunction: true });
  } catch (error) {
    return { issues: [{ code: 'EGO_PROGRAM_SYNTAX', message: error.message,
      line: error.loc?.line || 1, column: error.loc?.column || 0 }], warnings };
  }

  const scopes = new WeakMap();
  const parents = new WeakMap();
  const declarations = new WeakSet();
  const root = { parent: null, functionScope: true, bindings: new Map() };
  const isFunction = node => ['FunctionDeclaration', 'FunctionExpression', 'ArrowFunctionExpression'].includes(node.type);
  function bind(pattern, scope, value = null) {
    if (!pattern) return;
    if (pattern.type === 'Identifier') {
      declarations.add(pattern);
      // A later duplicate declaration should not hide an available callback.
      const prior = scope.bindings.get(pattern.name);
      scope.bindings.set(pattern.name, value || prior || pattern);
    } else if (pattern.type === 'RestElement') bind(pattern.argument, scope);
    else if (pattern.type === 'AssignmentPattern') bind(pattern.left, scope);
    else if (pattern.type === 'ArrayPattern') pattern.elements.forEach(item => bind(item, scope));
    else if (pattern.type === 'ObjectPattern') {
      for (const property of pattern.properties) bind(property.type === 'RestElement' ? property.argument : property.value, scope);
    }
  }
  function visit(node, scope, parent) {
    if (parent) parents.set(node, parent);
    if (node.type === 'FunctionDeclaration') bind(node.id, scope, node);
    if (node.type === 'ClassDeclaration') bind(node.id, scope, node);
    if (isFunction(node)) {
      scope = { parent: scope, functionScope: true, bindings: new Map() };
      if (node.type === 'FunctionExpression') bind(node.id, scope, node);
      node.params.forEach(param => bind(param, scope));
    } else if (node.type === 'BlockStatement' || node.type === 'CatchClause'
      || ['ForStatement', 'ForInStatement', 'ForOfStatement', 'SwitchStatement'].includes(node.type)) {
      scope = { parent: scope, functionScope: false, bindings: new Map() };
      if (node.type === 'CatchClause') bind(node.param, scope);
    } else if (node.type === 'ClassDeclaration' || node.type === 'ClassExpression') {
      scope = { parent: scope, functionScope: false, bindings: new Map() };
      bind(node.id, scope, node);
    }
    scopes.set(node, scope);
    if (node.type === 'VariableDeclaration') {
      let destination = scope;
      if (node.kind === 'var') while (!destination.functionScope) destination = destination.parent;
      for (const declaration of node.declarations) bind(declaration.id, destination, declaration.init);
    }
    if (['ImportSpecifier', 'ImportDefaultSpecifier', 'ImportNamespaceSpecifier'].includes(node.type)) bind(node.local, scope);
    for (const child of children(node)) visit(child, scope, node);
  }
  visit(ast, root, null);
  function resolve(name, scope) {
    while (scope) {
      if (scope.bindings.has(name)) return scope.bindings.get(name);
      scope = scope.parent;
    }
    return null;
  }
  function chain(node) {
    if (node.type === 'ChainExpression') return chain(node.expression);
    if (node.type === 'Identifier') return !resolve(node.name, scopes.get(node)) ? node.name : null;
    if (node.type !== 'MemberExpression') return null;
    const prefix = chain(node.object);
    const member = propertyName(node);
    return prefix && member !== null ? `${prefix}.${member}` : null;
  }
  const browserFunctions = new WeakSet();
  function findBrowserCallbacks(node) {
    if (node.type === 'CallExpression' && chain(node.callee) === 'page.evaluate') {
      let callback = node.arguments[0];
      const seen = new Set();
      while (callback?.type === 'Identifier' && !seen.has(callback)) {
        seen.add(callback);
        callback = resolve(callback.name, scopes.get(callback));
      }
      if (callback && isFunction(callback)) browserFunctions.add(callback);
    }
    children(node).forEach(findBrowserCallbacks);
  }
  findBrowserCallbacks(ast);

  const add = (target, node, message, issueCode = 'EGO_PROGRAM_CONTRACT') => target.push({
    code: issueCode, message, line: node.loc.start.line, column: node.loc.start.column });
  function reference(node, parent) {
    if (declarations.has(node)) return false;
    if (parent?.type === 'MemberExpression' && parent.property === node && !parent.computed) return false;
    if (['Property', 'MethodDefinition', 'PropertyDefinition'].includes(parent?.type)
      && parent.key === node && !parent.computed && !(parent.shorthand && parent.value === node)) return false;
    if (['LabeledStatement', 'BreakStatement', 'ContinueStatement'].includes(parent?.type)) return false;
    if (parent?.type === 'UnaryExpression' && parent.operator === 'typeof') return false;
    return true;
  }
  function check(node, inBrowser = false, functionDepth = 0) {
    const browser = inBrowser || browserFunctions.has(node);
    const depth = functionDepth + (isFunction(node) ? 1 : 0);
    const parent = parents.get(node);
    if (['ImportDeclaration', 'ExportNamedDeclaration', 'ExportDefaultDeclaration', 'ExportAllDeclaration'].includes(node.type)) {
      add(issues, node, 'browser_run code runs inside an async function; use dynamic import() and return values instead of module import/export declarations.', 'EGO_PROGRAM_SYNTAX');
    }
    if (!browser && node.type === 'Identifier' && reference(node, parent)
      && !resolve(node.name, scopes.get(node))) {
      if (DOM_GLOBALS.has(node.name)) {
        add(depth ? warnings : issues, node,
          `${node.name} belongs inside page.evaluate(); pass browser arguments as its second parameter.`,
          depth ? 'EGO_CONTEXT_UNCERTAIN' : 'EGO_NODE_CONTEXT');
      } else if (node.name === 'ctx' && parent?.type === 'MemberExpression' && parent.object === node) {
        add(depth ? warnings : issues, node, 'ctx is not injected; browser_run provides task, page and input.',
          depth ? 'EGO_CONTEXT_UNCERTAIN' : 'EGO_NODE_CONTEXT');
      }
    }
    if (!browser && node.type === 'MemberExpression' && chain(node.object) === 'page'
      && UNSUPPORTED.has(propertyName(node))) {
      add(issues, node, `page.${propertyName(node)} is not an Ego Page API; use the installed Ego guide.`, 'EGO_UNSUPPORTED_API');
    }
    if (!browser && node.type === 'CallExpression') {
      const method = chain(node.callee);
      if (method) {
        const args = node.arguments.map(argument => argument.type === 'SpreadElement' ? UNKNOWN : literal(argument));
        // A spread can supply wheel arguments that are not statically visible.
        const callIssues = node.arguments.some(argument => argument.type === 'SpreadElement') ? [] : validateCall(method, args);
        callIssues.forEach(issue => add(issues, node, issue.message, issue.code));
      }
    }
    for (const child of children(node)) check(child, browser, depth);
  }
  check(ast);
  return { issues, warnings };
}

function assertProgram(code) {
  const result = inspectProgram(code);
  if (result.issues.length) {
    const error = new Error(result.issues.map(issue => `Line ${issue.line}: ${issue.message}`).join('\n'));
    error.code = 'EGO_PROGRAM_CONTRACT';
    error.issues = result.issues;
    error.executionStarted = false;
    throw error;
  }
  return result;
}

module.exports = { inspectProgram, assertProgram, validateCall, assertCall };
