/**
 * Clean Copy — license module tests. Run: node --test tools/license.test.js
 * No dependencies; the API is replaced by a scripted fake `post`.
 */
const test = require('node:test');
const assert = require('node:assert');
const L = require('../license.js');

const KEY = '0123456789abcdef0123456789abcdef';
const DEVICE = 'device-1';
const DAY = 24 * 60 * 60 * 1000;

/** Fake API: returns scripted responses in order and records every call. */
function fakeApi(responses) {
  const calls = [];
  const post = async (url, body) => {
    calls.push({ url, body });
    const r = responses.shift();
    if (!r) throw new Error('unexpected call to ' + url);
    if (r === 'network') throw new TypeError('Failed to fetch');
    return r;
  };
  return { post, calls };
}

test('normalizeKey trims and lowercases', () => {
  assert.strictEqual(L.normalizeKey('  0123456789ABCDEF0123456789ABCDEF \n'), KEY);
  assert.strictEqual(L.normalizeKey(null), '');
});

test('isValidKey requires exactly 32 hex chars', () => {
  assert.ok(L.isValidKey(KEY));
  assert.ok(!L.isValidKey(KEY.toUpperCase()));
  assert.ok(!L.isValidKey(KEY.slice(1)));
  assert.ok(!L.isValidKey(KEY + '0'));
  assert.ok(!L.isValidKey('g'.repeat(32)));
  assert.ok(!L.isValidKey('XXXX-XXXX-XXXX-XXXX'));
});

test('device ids are stable-length and within 128 chars', () => {
  const id = L.newDeviceId();
  assert.ok(L.isValidDeviceId(id));
  assert.notStrictEqual(id, L.newDeviceId());
  assert.ok(!L.isValidDeviceId(''));
  assert.ok(!L.isValidDeviceId('x'.repeat(129)));
});

test('buildRequest targets mahope.tools and always sends product', () => {
  for (const ep of ['activate', 'validate', 'deactivate']) {
    const r = L.buildRequest(ep, ' ' + KEY.toUpperCase() + ' ', DEVICE);
    assert.strictEqual(r.url, 'https://mahope.tools/api/license/' + ep);
    assert.deepStrictEqual(r.body, { license_key: KEY, device_id: DEVICE, product: 'clean-copy-pro' });
  }
  assert.throws(() => L.buildRequest('lookup', KEY, DEVICE));
  assert.ok(!/pages\.dev|lemonsqueezy/i.test(JSON.stringify(L)));
});

test('grace period: Pro stays active for 7 days after the last validation, then locks', () => {
  const t0 = Date.UTC(2026, 8, 1);
  const state = { proLicense: KEY, validatedAt: t0 };
  assert.ok(L.isProActive(state, t0));
  assert.ok(L.isProActive(state, t0 + 7 * DAY));
  assert.ok(!L.isProActive(state, t0 + 7 * DAY + 1));
  assert.ok(!L.isProActive({ proLicense: KEY }, t0), 'never validated = locked');
  assert.ok(!L.isProActive({ proLicense: '', validatedAt: t0 }, t0), 'no key = locked');
  assert.ok(!L.isProActive({ proLicense: KEY, validatedAt: t0 + 8 * DAY }, t0), 'far-future timestamp = locked');
});

test('needsRevalidation after a day, or when never validated', () => {
  const t0 = Date.UTC(2026, 8, 1);
  assert.ok(!L.needsRevalidation({ proLicense: KEY, validatedAt: t0 }, t0 + DAY - 1));
  assert.ok(L.needsRevalidation({ proLicense: KEY, validatedAt: t0 }, t0 + DAY));
  assert.ok(L.needsRevalidation({ proLicense: KEY }, t0));
  assert.ok(!L.needsRevalidation({}, t0));
});

test('activate: success sends product and returns expiry', async () => {
  const api = fakeApi([{ status: 200, data: { ok: true, activated: true, plan: 'clean-copy-pro', expires_at: '2027-09-24T00:00:00Z', devices_in_use: 1 } }]);
  const r = await L.activate(api.post, KEY.toUpperCase(), DEVICE);
  assert.deepStrictEqual(r, { result: 'valid', expiresAt: '2027-09-24T00:00:00Z', plan: 'clean-copy-pro' });
  assert.strictEqual(api.calls[0].url, 'https://mahope.tools/api/license/activate');
  assert.strictEqual(api.calls[0].body.product, 'clean-copy-pro');
  assert.strictEqual(api.calls[0].body.license_key, KEY);
});

test('activate: bad format is rejected client-side without a request', async () => {
  const api = fakeApi([]);
  const r = await L.activate(api.post, 'not-a-key', DEVICE);
  assert.strictEqual(r.result, 'invalid');
  assert.strictEqual(api.calls.length, 0);
});

test('activate: 403/404/409 give clear messages, 503 and network are temporary', async () => {
  const cases = [
    [{ status: 404, data: { ok: false } }, 'invalid', /not found/i],
    [{ status: 403, data: { ok: false, error: 'This license key is for another product.' } }, 'invalid', /another product/],
    [{ status: 403, data: { ok: false } }, 'invalid', /expired|revoked/i],
    [{ status: 409, data: { ok: false } }, 'invalid', /device limit/i],
    [{ status: 503, data: { ok: false } }, 'temporary', /could not be reached/],
    ['network', 'temporary', /could not be reached/],
  ];
  for (const [resp, result, msg] of cases) {
    const r = await L.activate(fakeApi([resp]).post, KEY, DEVICE);
    assert.strictEqual(r.result, result, JSON.stringify(resp));
    assert.match(r.message, msg);
  }
});

test('check: valid key stays valid', async () => {
  const api = fakeApi([{ status: 200, data: { ok: true, valid: true, plan: 'clean-copy-pro', expires_at: '2027-09-24T00:00:00Z' } }]);
  const r = await L.check(api.post, KEY, DEVICE);
  assert.strictEqual(r.result, 'valid');
  assert.strictEqual(api.calls.length, 1);
  assert.strictEqual(api.calls[0].url, 'https://mahope.tools/api/license/validate');
  assert.strictEqual(api.calls[0].body.product, 'clean-copy-pro');
});

test('check: not_activated re-activates instead of dropping the key', async () => {
  const api = fakeApi([
    { status: 200, data: { ok: true, valid: false, reason: 'not_activated', devices_in_use: 0 } },
    { status: 200, data: { ok: true, activated: true, plan: 'clean-copy-pro', expires_at: '2027-09-24T00:00:00Z', devices_in_use: 1 } },
  ]);
  const r = await L.check(api.post, KEY, DEVICE);
  assert.strictEqual(r.result, 'valid');
  assert.deepStrictEqual(api.calls.map((c) => c.url.split('/').pop()), ['validate', 'activate']);
  assert.strictEqual(api.calls[1].body.product, 'clean-copy-pro');
});

test('check: not_activated + device limit on re-activation is invalid with a clear message', async () => {
  const api = fakeApi([
    { status: 200, data: { ok: true, valid: false, reason: 'not_activated' } },
    { status: 409, data: { ok: false, error: 'Device limit reached (5).' } },
  ]);
  const r = await L.check(api.post, KEY, DEVICE);
  assert.strictEqual(r.result, 'invalid');
  assert.match(r.message, /device limit/i);
});

test('check: expired (403) is invalid; 503/5xx/network are temporary', async () => {
  assert.strictEqual((await L.check(fakeApi([{ status: 403, data: { ok: false, error: 'License expired.' } }]).post, KEY, DEVICE)).result, 'invalid');
  assert.strictEqual((await L.check(fakeApi([{ status: 503, data: {} }]).post, KEY, DEVICE)).result, 'temporary');
  assert.strictEqual((await L.check(fakeApi([{ status: 502, data: {} }]).post, KEY, DEVICE)).result, 'temporary');
  assert.strictEqual((await L.check(fakeApi(['network']).post, KEY, DEVICE)).result, 'temporary');
});

test('deactivate: calls the API with product, never throws', async () => {
  const api = fakeApi([{ status: 200, data: { ok: true, deactivated: true, devices_in_use: 0 } }]);
  assert.strictEqual(await L.deactivate(api.post, KEY, DEVICE), true);
  assert.strictEqual(api.calls[0].url, 'https://mahope.tools/api/license/deactivate');
  assert.deepStrictEqual(api.calls[0].body, { license_key: KEY, device_id: DEVICE, product: 'clean-copy-pro' });
  assert.strictEqual(await L.deactivate(fakeApi(['network']).post, KEY, DEVICE), false);
  assert.strictEqual(await L.deactivate(fakeApi([]).post, 'bad', DEVICE), false);
});

test('buy link is the Clean Copy Pro Stripe payment link', () => {
  assert.strictEqual(L.BUY_URL, 'https://buy.stripe.com/6oU4gy76PgvgdBIdAXbMQ00');
});
