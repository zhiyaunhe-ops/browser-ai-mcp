const blockedMethods = new Set(['Network.clearBrowserCookies', 'Storage.clearCookies']);
const protectedMethods = new WeakSet();

function assertCookieScope(method, params) {
  if (blockedMethods.has(method)) {
    const error = new Error(`Browser AI MCP blocked ${method} because it clears cookies for a whole browser profile. To clear the current site, call page.cdp("Storage.clearDataForOrigin", { origin: new URL(await page.url()).origin, storageTypes: "cookies" }). To remove one named cookie, use Network.deleteCookies with its name and URL.`);
    error.code = 'EGO_PROFILE_COOKIE_CLEAR_BLOCKED';
    throw error;
  }
  if (method === 'Target.sendMessageToTarget') assertMessageScope(params?.message);
}

function assertMessageScope(message) {
  if (typeof message !== 'string') return;
  let command;
  try {
    command = JSON.parse(message);
  } catch {
    throw new TypeError('Browser AI MCP requires valid JSON for a raw CDP message.');
  }
  assertCookieScope(command?.method, command?.params);
}

function protectMethod(receiver, name, createGuard, required = false) {
  let owner = receiver;
  while (owner && !Object.hasOwn(owner, name)) owner = Object.getPrototypeOf(owner);
  const descriptor = owner && Object.getOwnPropertyDescriptor(owner, name);
  if (typeof descriptor?.value !== 'function') {
    if (owner || required) throw new TypeError(`Browser AI MCP could not protect the Ego ${name} method.`);
    return;
  }
  if (protectedMethods.has(descriptor.value)) return;
  const guarded = createGuard(descriptor.value);
  Object.defineProperty(owner, name, { ...descriptor, value: guarded, configurable: false, writable: false });
  protectedMethods.add(guarded);
}

export function installCookieGuard(task, page, globals = globalThis) {
  const guardCdp = send => async function (method, params, ...rest) {
    assertCookieScope(method, params);
    return Reflect.apply(send, this, [method, params, ...rest]);
  };
  const guardTransport = send => function (message, ...rest) {
    assertMessageScope(message);
    return Reflect.apply(send, this, [message, ...rest]);
  };
  // SDK prototypes cover pages returned later by newPage(), pages() and adopt().
  protectMethod(task, 'cdp', guardCdp, true);
  protectMethod(page, 'cdp', guardCdp, true);
  protectMethod(globals, 'cdp', guardCdp);
  protectMethod(globals, 'sendCDPMessage', guardTransport);
  protectMethod(globals.ego, 'sendCDPMessage', guardTransport);
}
