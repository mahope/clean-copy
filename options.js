/**
 * Clean Copy — Options page: license activation + Pro custom rules.
 * License is validated against the licensing API and cached in
 * chrome.storage.local. Rules apply on every copy when Pro is active.
 */

const LICENSE_API = 'https://hermes-passiv.pages.dev/api/license/validate';
const ACTIVATE_API = 'https://hermes-passiv.pages.dev/api/license/activate';

function deviceId() {
  // Non-identifying random device token, persisted locally only.
  return new Promise((resolve) => {
    chrome.storage.local.get(['deviceId'], (data) => {
      if (data.deviceId) return resolve(data.deviceId);
      const d = (crypto.randomUUID ? crypto.randomUUID() : String(Math.random()).slice(2) + Date.now());
      chrome.storage.local.set({ deviceId: d }, () => resolve(d));
    });
  });
}

function setStatus(el, msg, cls) {
  el.textContent = msg;
  el.className = 'status' + (cls ? ' ' + cls : '');
}

/* ── License ──────────────────────────────────────────────────── */

function showLicensed(expiresAt, keyStored) {
  document.getElementById('lic-state').textContent = '✓ active';
  document.getElementById('lic-state').style.color = '#66bb6a';
  const st = document.getElementById('license-status');
  setStatus(st, expiresAt ? 'Pro active — valid until ' + String(expiresAt).slice(0, 10) : 'Pro active.', 'ok');
  document.getElementById('license-key').value = '';
  document.getElementById('deactivate').hidden = !keyStored;
  document.getElementById('rules-list').disabled = false;
}

function showUnlicensed(msg) {
  document.getElementById('lic-state').textContent = 'not active';
  document.getElementById('lic-state').style.color = '';
  const st = document.getElementById('license-status');
  if (msg) setStatus(st, msg, 'error');
  document.getElementById('deactivate').hidden = true;
}

async function checkSavedLicense(key) {
  try {
    const res = await fetch(LICENSE_API, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ license_key: key, device_id: await deviceId() })
    });
    const j = await res.json().catch(() => ({}));
    if (res.status === 200 && j.ok && j.valid) {
      chrome.storage.local.set({ proLicense: key, proExpires: j.expires_at || '' });
      showLicensed(j.expires_at, true);
      return;
    }
    // Saved key no longer valid (revoked / expired / device moved).
    chrome.storage.local.remove(['proLicense', 'proExpires']);
    showUnlicensed(
      j.reason === 'device_limit' ? 'Device limit reached for this license.'
        : (j.error || 'Saved license is not valid anymore.')
    );
  } catch {
    // Offline: keep the saved license usable rather than locking the user out.
    showLicensed('', true);
  }
}

document.addEventListener('DOMContentLoaded', () => {
  const form = document.getElementById('license-form');
  const keyInput = document.getElementById('license-key');
  const licStatus = document.getElementById('license-status');

  chrome.storage.local.get(['proLicense'], (data) => {
    if (data.proLicense) checkSavedLicense(data.proLicense);
    else showUnlicensed();
    loadRules(data.proLicense ? true : false);
  });

  form.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const key = keyInput.value.trim().toLowerCase();
    if (!key) return;
    setStatus(licStatus, 'Checking license…');
    try {
      const res = await fetch(ACTIVATE_API, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ license_key: key, device_id: await deviceId() })
      });
      const j = await res.json().catch(() => ({}));
      if (res.status === 200 && j.ok && j.activated) {
        chrome.storage.local.set({ proLicense: key, proExpires: j.expires_at || '' });
        showLicensed(j.expires_at, true);
        loadRules(true);
      } else {
        showUnlicensed(j.error || 'Activation failed.');
        loadRules(false);
      }
    } catch {
      setStatus(licStatus, 'Network error — check your connection.', 'error');
    }
  });

  document.getElementById('deactivate').addEventListener('click', () => {
    // Local removal only — does not free a seat remotely.
    chrome.storage.local.remove(['proLicense', 'proExpires']);
    showUnlicensed('License removed from this device.');
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
