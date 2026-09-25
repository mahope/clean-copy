/**
 * Clean Copy — license logic shared by the options page, the background
 * script and the tests. Pure functions plus a small check flow that takes an
 * injected `post(url, body)` so it runs the same in the browser and in Node.
 *
 * Contract: https://mahope.tools/api/license/{activate,validate,deactivate},
 * POST JSON { license_key, device_id, product }.
 *
 * UMD-ish: `<script>` / importScripts define `CleanCopyLicense`; Node gets
 * module.exports.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.CleanCopyLicense = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var API_BASE = 'https://mahope.tools/api/license/';
  var PRODUCT = 'clean-copy-pro';
  var BUY_URL = 'https://buy.stripe.com/6oU4gy76PgvgdBIdAXbMQ00';
  var DAY_MS = 24 * 60 * 60 * 1000;
  // Pro stays unlocked this long after the last successful validation when
  // the license server cannot be reached. After that Pro is locked until a
  // validation succeeds again.
  var GRACE_MS = 7 * DAY_MS;
  // Background re-validation interval (well inside the grace period).
  var REVALIDATE_MS = DAY_MS;
  var ENDPOINTS = ['activate', 'validate', 'deactivate'];

  function normalizeKey(raw) {
    return String(raw == null ? '' : raw).trim().toLowerCase();
  }

  function isValidKey(key) {
    return /^[a-f0-9]{32}$/.test(String(key));
  }

  function isValidDeviceId(id) {
    return typeof id === 'string' && id.length > 0 && id.length <= 128;
  }

  function newDeviceId() {
    var c = typeof crypto !== 'undefined' ? crypto : null;
    if (c && typeof c.randomUUID === 'function') return c.randomUUID();
    var bytes = new Uint8Array(16);
    if (c && typeof c.getRandomValues === 'function') c.getRandomValues(bytes);
    else for (var i = 0; i < 16; i++) bytes[i] = Math.floor(Math.random() * 256);
    return Array.from(bytes, function (b) { return b.toString(16).padStart(2, '0'); }).join('');
  }

  /** Build the request for one endpoint. Throws on a bad endpoint. */
  function buildRequest(endpoint, key, deviceId) {
    if (ENDPOINTS.indexOf(endpoint) === -1) throw new Error('Unknown license endpoint: ' + endpoint);
    return {
      url: API_BASE + endpoint,
      body: { license_key: normalizeKey(key), device_id: deviceId, product: PRODUCT },
    };
  }

  /** Network errors (status 0), 5xx and 429 are temporary: fail soft. */
  function isTemporary(status) {
    return !status || status >= 500 || status === 429;
  }

  function errorMessage(status, data) {
    var serverMsg = data && typeof data.error === 'string' ? data.error : '';
    if (isTemporary(status)) return 'The license server could not be reached. Try again in a few minutes.';
    if (status === 400) return 'That is not a valid license key. It is 32 characters, 0-9 and a-f, and is in your purchase email.';
    if (status === 404) return 'License key not found. Check for typos, or use the key from your purchase email.';
    if (status === 403) return serverMsg || 'This license has expired, been revoked, or is for another product.';
    if (status === 409) return 'Device limit reached for this license. Remove it on another device, then try again.';
    return serverMsg || 'License check failed (HTTP ' + status + ').';
  }

  /** Is the last successful validation recent enough to keep Pro unlocked? */
  function withinGrace(validatedAt, now) {
    if (typeof validatedAt !== 'number' || !isFinite(validatedAt)) return false;
    var age = now - validatedAt;
    return age <= GRACE_MS && age >= -GRACE_MS;
  }

  /** Pro is active when a key is stored and was validated within the grace period. */
  function isProActive(state, now) {
    return !!(state && isValidKey(state.proLicense) && withinGrace(state.validatedAt, now));
  }

  /** Should the background re-validate now? */
  function needsRevalidation(state, now) {
    if (!state || !isValidKey(state.proLicense)) return false;
    var v = state.validatedAt;
    if (typeof v !== 'number' || !isFinite(v)) return true;
    var age = now - v;
    return age < 0 || age >= REVALIDATE_MS;
  }

  async function call(post, endpoint, key, deviceId) {
    var req = buildRequest(endpoint, key, deviceId);
    try {
      var res = await post(req.url, req.body);
      return { status: res && res.status ? res.status : 0, data: (res && res.data) || {} };
    } catch (e) {
      return { status: 0, data: {} };
    }
  }

  function fromActivation(r) {
    if (r.status === 200 && r.data.ok && r.data.activated) {
      return { result: 'valid', expiresAt: r.data.expires_at || null, plan: r.data.plan || null };
    }
    if (isTemporary(r.status)) return { result: 'temporary', message: errorMessage(r.status, r.data) };
    return { result: 'invalid', status: r.status, message: errorMessage(r.status, r.data) };
  }

  /**
   * Activate a key on this device.
   * Returns { result: 'valid'|'invalid'|'temporary', expiresAt?, plan?, message? }.
   */
  async function activate(post, rawKey, deviceId) {
    var key = normalizeKey(rawKey);
    if (!isValidKey(key)) return { result: 'invalid', status: 400, message: errorMessage(400) };
    return fromActivation(await call(post, 'activate', key, deviceId));
  }

  /**
   * Validate a stored key. A key that is valid but not bound to this device
   * (reason 'not_activated') is activated again instead of being dropped.
   */
  async function check(post, rawKey, deviceId) {
    var key = normalizeKey(rawKey);
    if (!isValidKey(key)) return { result: 'invalid', status: 400, message: errorMessage(400) };
    var r = await call(post, 'validate', key, deviceId);
    if (r.status === 200 && r.data.ok && r.data.valid) {
      return { result: 'valid', expiresAt: r.data.expires_at || null, plan: r.data.plan || null };
    }
    if (r.status === 200 && r.data.ok && r.data.valid === false) {
      if (r.data.reason === 'not_activated') {
        return fromActivation(await call(post, 'activate', key, deviceId));
      }
      if (r.data.reason === 'device_limit') {
        return { result: 'invalid', status: 409, message: errorMessage(409) };
      }
      return { result: 'invalid', status: 200, message: 'This license is not valid anymore.' };
    }
    if (isTemporary(r.status)) return { result: 'temporary', message: errorMessage(r.status, r.data) };
    return { result: 'invalid', status: r.status, message: errorMessage(r.status, r.data) };
  }

  /** Free this device's seat. Best effort: never throws, returns true on success. */
  async function deactivate(post, rawKey, deviceId) {
    var key = normalizeKey(rawKey);
    if (!isValidKey(key) || !isValidDeviceId(deviceId)) return false;
    var r = await call(post, 'deactivate', key, deviceId);
    return r.status === 200 && !!r.data.ok;
  }

  /** `post` implementation on top of fetch (browser and Node 18+). */
  async function fetchPost(url, body) {
    var res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    var data = {};
    try { data = await res.json(); } catch (e) { data = {}; }
    return { status: res.status, data: data };
  }

  return {
    API_BASE: API_BASE,
    PRODUCT: PRODUCT,
    BUY_URL: BUY_URL,
    GRACE_MS: GRACE_MS,
    REVALIDATE_MS: REVALIDATE_MS,
    normalizeKey: normalizeKey,
    isValidKey: isValidKey,
    isValidDeviceId: isValidDeviceId,
    newDeviceId: newDeviceId,
    buildRequest: buildRequest,
    isTemporary: isTemporary,
    errorMessage: errorMessage,
    withinGrace: withinGrace,
    isProActive: isProActive,
    needsRevalidation: needsRevalidation,
    activate: activate,
    check: check,
    deactivate: deactivate,
    fetchPost: fetchPost,
  };
});
