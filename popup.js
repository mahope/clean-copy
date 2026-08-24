/**
 * Clean Copy — Popup UI
 */
let selectedMode = 'plain';

document.addEventListener('DOMContentLoaded', () => {
  const modePlain = document.getElementById('mode-plain');
  const modeMarkdown = document.getElementById('mode-markdown');
  const copyBtn = document.getElementById('copy-btn');
  const statusDiv = document.getElementById('status');
  const proLink = document.getElementById('pro-link');

  chrome.storage.local.get(['copyMode'], (data) => {
    selectMode(data.copyMode === 'markdown' ? 'markdown' : 'plain');
  });

  function selectMode(mode) {
    selectedMode = mode;
    modePlain.classList.toggle('active', mode === 'plain');
    modeMarkdown.classList.toggle('active', mode === 'markdown');
    chrome.storage.local.set({ copyMode: mode });
  }

  modePlain.addEventListener('click', () => selectMode('plain'));
  modeMarkdown.addEventListener('click', () => selectMode('markdown'));

  copyBtn.addEventListener('click', async () => {
    statusDiv.textContent = '⏳ Processing...';
    statusDiv.className = 'status';

    chrome.runtime.sendMessage({ type: 'process-selection', mode: selectedMode }, (response) => {
      if (chrome.runtime.lastError) {
        statusDiv.textContent = '⚠ Error communicating with extension';
        statusDiv.className = 'status error';
        return;
      }
      if (response && response.error) {
        statusDiv.textContent = '⚠ ' + response.error;
        statusDiv.className = 'status error';
        return;
      }
      if (response && response.content) {
        // Popup closes on focus loss — write to clipboard here too so the
        // popup path works even if the offscreen channel hiccups.
        navigator.clipboard.writeText(response.content).then(() => {
          statusDiv.textContent = `✅ Copied! (${response.content.length} chars)`;
          statusDiv.className = 'status success';
          setTimeout(() => { statusDiv.textContent = ''; statusDiv.className = 'status'; }, 2500);
        }).catch(() => {
          statusDiv.textContent = '⚠ Could not access clipboard from popup';
          statusDiv.className = 'status error';
        });
      } else {
        statusDiv.textContent = '⚠ No content returned';
        statusDiv.className = 'status error';
      }
    });
  });

  const settingsBtn = document.getElementById('settings-btn');
  if (settingsBtn) {
    settingsBtn.addEventListener('click', () => {
      chrome.runtime.openOptionsPage();
    });
  }

  // Pro state drives the footer link label; click opens the options page.
  chrome.runtime.sendMessage({ type: 'get-pro-state' }, (state) => {
    const active = !!(state && state.active);
    proLink.innerHTML = active
      ? '✓ Pro active <span class="pro-badge">PRO</span>'
      : 'Pro $19/yr <span class="pro-badge">Soon</span>';
  });

  proLink.addEventListener('click', (e) => {
    e.preventDefault();
    chrome.runtime.openOptionsPage();
  });
});
