/**
 * Clean Copy — Options page: license activation + Pro custom rules.
 * License is validated against the licensing API and cached in
 * chrome.storage.local. Rules apply on every copy when Pro is active.
 */

const L = CleanCopyLicense;
const LICENSE_KEYS = ['proLicense', 'proExpires', 'validatedAt'];

function deviceId() {
  // Non-identifying random device token, generated once and persisted locally.
  return new Promise((resolve) => {
    chrome.storage.local.get(['deviceId'], (data) => {
      if (L.isValidDeviceId(data.deviceId)) return resolve(data.deviceId);
      const d = L.newDeviceId();
      chrome.storage.local.set({ deviceId: d }, () => resolve(d));
    });
  });
}

function setStatus(el, msg, cls) {
  el.textContent = msg;
  el.className = 'status' + (cls ? ' ' + cls : '');
}

/* ── License ──────────────────────────────────────────────────── */

function showLicensed(expiresAt, note) {
  document.getElementById('lic-state').textContent = '✓ active';
  document.getElementById('lic-state').style.color = '#66bb6a';
  const st = document.getElementById('license-status');
  const base = expiresAt ? 'Pro active — valid until ' + String(expiresAt).slice(0, 10) + '.' : 'Pro active.';
  setStatus(st, note ? base + ' ' + note : base, 'ok');
  document.getElementById('license-key').value = '';
  document.getElementById('deactivate').hidden = false;
  document.getElementById('buy-pro').hidden = true;
}

function showUnlicensed(msg, keyStored) {
  document.getElementById('lic-state').textContent = 'not active';
  document.getElementById('lic-state').style.color = '';
  const st = document.getElementById('license-status');
  if (msg) setStatus(st, msg, 'error');
  document.getElementById('deactivate').hidden = !keyStored;
  document.getElementById('buy-pro').hidden = false;
}

function saveValid(key, res) {
  return new Promise((resolve) => chrome.storage.local.set(
    { proLicense: key, proExpires: res.expiresAt || '', validatedAt: Date.now() }, resolve));
}

function clearLicense() {
  return new Promise((resolve) => chrome.storage.local.remove(LICENSE_KEYS, resolve));
}

async function checkSavedLicense(stored) {
  const key = stored.proLicense;
  const res = await L.check(L.fetchPost, key, await deviceId());
  if (res.result === 'valid') {
    await saveValid(key, res);
    showLicensed(res.expiresAt);
    return true;
  }
  if (res.result === 'invalid') {
    // Expired, revoked, unknown or other product: drop the key locally.
    await clearLicense();
    showUnlicensed(res.message);
    return false;
  }
  // Temporary (offline / server error): keep Pro for up to 7 days after the
  // last successful validation, then lock it until a validation succeeds.
  if (L.isProActive(stored, Date.now())) {
    const until = new Date(stored.validatedAt + L.GRACE_MS).toISOString().slice(0, 10);
    showLicensed(stored.proExpires, 'The license server is unreachable, so Pro keeps working offline until ' + until + '.');
    return true;
  }
  showUnlicensed('Pro is paused: the license could not be checked for more than 7 days. ' + res.message, true);
  return false;
}

document.addEventListener('DOMContentLoaded', () => {
  const form = document.getElementById('license-form');
  const keyInput = document.getElementById('license-key');
  const licStatus = document.getElementById('license-status');
  document.getElementById('buy-pro').href = L.BUY_URL;

  chrome.storage.local.get(LICENSE_KEYS, (data) => {
    if (data.proLicense) {
      loadRules(L.isProActive(data, Date.now()));
      setStatus(licStatus, 'Checking license…');
      checkSavedLicense(data).then((active) => loadRules(active));
    } else {
      showUnlicensed();
      loadRules(false);
    }
  });

  form.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const key = L.normalizeKey(keyInput.value);
    if (!key) return;
    if (!L.isValidKey(key)) {
      setStatus(licStatus, L.errorMessage(400), 'error');
      return;
    }
    setStatus(licStatus, 'Checking license…');
    const res = await L.activate(L.fetchPost, key, await deviceId());
    if (res.result === 'valid') {
      await saveValid(key, res);
      showLicensed(res.expiresAt);
      loadRules(true);
    } else {
      setStatus(licStatus, res.message, 'error');
    }
  });

  document.getElementById('deactivate').addEventListener('click', async () => {
    const data = await new Promise((resolve) => chrome.storage.local.get(['proLicense'], resolve));
    // Free the seat on the server (best effort), then remove locally regardless.
    const freed = data.proLicense ? await L.deactivate(L.fetchPost, data.proLicense, await deviceId()) : false;
    await clearLicense();
    showUnlicensed(freed ? 'License removed from this device.'
      : 'License removed from this device. The server could not be reached, so the device slot may still count as used.');
    loadRules(false);
  });

  /* ── Custom rules ─────────────────────────────────────────── */

  const listEl = document.getElementById('rules-list');
  const rulesStatus = document.getElementById('rules-status');

  function ruleRow(rule) {
    const row = document.createElement('div');
    row.className = 'rule-row';

    const find = document.createElement('input');
    find.type = 'text'; find.className = 'find'; find.placeholder = 'Find…';
    find.value = rule.find || '';

    const rep = document.createElement('input');
    rep.type = 'text'; rep.className = 'replace'; rep.placeholder = 'Replace with…';
    rep.value = rule.replace || '';

    const reLbl = document.createElement('label');
    reLbl.className = 'inline'; reLbl.title = 'Treat "Find" as a regular expression';
    const reChk = document.createElement('input');
    reChk.type = 'checkbox'; reChk.checked = !!rule.regex;
    reLbl.appendChild(reChk); reLbl.appendChild(document.createTextNode('regex'));

    const del = document.createElement('button');
    del.type = 'button'; del.textContent = '✕'; del.className = 'danger';
    del.addEventListener('click', () => row.remove());

    row.append(find, rep, reLbl, del);
    find.dataset.field = 'find'; rep.dataset.field = 'replace'; reChk.dataset.field = 'regex';
    return row;
  }

  function collectRules() {
    const rules = [];
    listEl.querySelectorAll('.rule-row').forEach((row) => {
      const get = (f) => row.querySelector(`[data-field="${f}"]`);
      const find = get('find').value.trim();
      if (!find) return;
      rules.push({ find, replace: get('replace').value, regex: get('regex').checked });
    });
    return rules;
  }

  window.loadRules = function (proActive) {
    chrome.storage.local.get(['customRules'], (d) => {
      listEl.innerHTML = '';
      (d.customRules || [{ find: '', replace: '' }]).forEach((r) => listEl.appendChild(ruleRow(r)));
      if (!proActive) {
        listEl.querySelectorAll('input, button.danger').forEach((el) => { el.disabled = true; });
        document.getElementById('save-rules').disabled = true;
        setStatus(rulesStatus, 'Activate Pro to edit rules.', '');
      } else {
        listEl.querySelectorAll('input, button.danger').forEach((el) => { el.disabled = false; });
        document.getElementById('save-rules').disabled = false;
        setStatus(rulesStatus, '');
      }
    });
  };

  document.getElementById('add-rule').addEventListener('click', () => {
    listEl.appendChild(ruleRow({}));
    listEl.querySelector('.rule-row:last-child input.find')?.focus();
  });

  document.getElementById('save-rules').addEventListener('click', () => {
    const rules = collectRules();
    // Client-side validation so bad regexes never reach the copy path.
    for (let i = 0; i < rules.length; i++) {
      if (!rules[i].regex) continue;
      try { new RegExp(rules[i].find); } catch (e) {
        setStatus(rulesStatus, `Rule ${i + 1}: invalid pattern "${rules[i].find}"`, 'error');
        return;
      }
    }
    chrome.storage.local.set({ customRules: rules }, () => {
      setStatus(rulesStatus, rules.length ? `✓ ${rules.length} rule(s) saved.` : 'Rules cleared.', 'ok');
    });
  });
});
