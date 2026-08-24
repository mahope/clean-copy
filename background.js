/**
 * Clean Copy — Background Service Worker
 * Context menu, keyboard shortcut, HTML→Markdown conversion,
 * clipboard via offscreen document, toast injected on demand.
 * Permissions: activeTab only — no host_permissions, no static content scripts.
 */

const CLEAN_RULES = [
  { pattern: /[\u201C\u201D]/g, replacement: '"' },
  { pattern: /[\u2018\u2019]/g, replacement: "'" },
  { pattern: /\u2014/g, replacement: ' -- ' },
  { pattern: /\u2013/g, replacement: ' - ' },
  { pattern: /[\u200B\u200C\u200D\uFEFF]/g, replacement: '' },
  { pattern: /\u00A0/g, replacement: ' ' },
  // Collapse runs of spaces but never touch whitespace at line starts,
  // so Markdown list indentation survives.
  { pattern: /([^\n \t])[ \t]{2,}/g, replacement: '$1 ' },
  { pattern: /\n{3,}/g, replacement: '\n\n' },
];

function cleanText(text) {
  let cleaned = text;
  for (const rule of CLEAN_RULES) {
    cleaned = cleaned.replace(rule.pattern, rule.replacement);
  }
  return cleaned.trim();
}

function htmlToMarkdown(html) {
  let md = html;

  md = md.replace(/<h1[^>]*>(.*?)<\/h1>/gi, '# $1\n\n');
  md = md.replace(/<h2[^>]*>(.*?)<\/h2>/gi, '## $1\n\n');
  md = md.replace(/<h3[^>]*>(.*?)<\/h3>/gi, '### $1\n\n');
  md = md.replace(/<h4[^>]*>(.*?)<\/h4>/gi, '#### $1\n\n');
  md = md.replace(/<h5[^>]*>(.*?)<\/h5>/gi, '##### $1\n\n');
  md = md.replace(/<h6[^>]*>(.*?)<\/h6>/gi, '###### $1\n\n');

  md = md.replace(/<(?:b|strong)[^>]*>(.*?)<\/(?:b|strong)>/gi, '**$1**');
  md = md.replace(/<(?:i|em)[^>]*>(.*?)<\/(?:i|em)>/gi, '*$1*');
  md = md.replace(/<a[^>]*href="([^"]*)"[^>]*>(.*?)<\/a>/gi, '[$2]($1)');
  md = md.replace(/<img[^>]*src="([^"]*)"[^>]*alt="([^"]*)"[^>]*>/gi, '![$2]($1)');
  md = md.replace(/<img[^>]*src="([^"]*)"[^>]*>/gi, '![]($1)');

  md = md.replace(/<pre[^>]*>(.*?)<\/pre>/gis, (_, code) => {
    code = code.replace(/<code[^>]*>/gi, '').replace(/<\/code>/gi, '');
    code = code.replace(/<br\s*\/?>/gi, '\n');
    code = code.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/>/g, '>');
    return '```\n' + code.trim() + '\n```\n\n';
  });

  md = md.replace(/<code[^>]*>(.*?)<\/code>/gi, '`$1`');

  // Lists: convert innermost lists repeatedly until none remain,
  // so arbitrarily deep nesting produces one "- " per item.
  const convertList = (_, openTag, body) => {
    const ordered = /^<ol/i.test(openTag);
    let idx = 0;
    const items = [];
    const re = /<li[^>]*>([\s\S]*?)<\/li>/gi;
    let m;
    while ((m = re.exec(body)) !== null) {
      idx += 1;
      const marker = ordered ? `${idx}. ` : '- ';
      // Re-indent sub-list lines that are already converted, then trim
      // the item's own leading/trailing whitespace. Sub-list markers get
      // two-space indentation relative to the parent item.
      const inner = m[1].replace(/^\s+/, '').replace(/\s+$/, '')
        // Sub-list lines: keep any existing indentation and add two
        // spaces per level so nesting depth survives conversion.
        .replace(/\n([ \t]*)- /g, (all, ws) => '\n  ' + ws + '- ')
        .replace(/\n([ \t]*)(\d+)\. /g, (all, ws, n) => '\n  ' + ws + n + '. ');
      items.push(marker + inner);
    }
    return '\n' + items.join('\n') + '\n';
  };
  let prev;
  do {
    prev = md;
    md = md.replace(/(<(?:ul|ol)[^>]*>)((?:(?!<\/?(?:ul|ol)[^>]*>)[\s\S])*)<\/(?:ul|ol)>/gi, convertList);
  } while (md !== prev);

  md = md.replace(/<p[^>]*>(.*?)<\/p>/gi, '$1\n\n');
  md = md.replace(/<br\s*\/?>/gi, '\n');
  md = md.replace(/<hr\s*\/?>/gi, '---\n\n');

  md = md.replace(/<[^>]*>/g, '');
  md = md.replace(/&amp;/g, '&');
  md = md.replace(/&lt;/g, '<');
  md = md.replace(/&gt;/g, '>');
  md = md.replace(/&quot;/g, '"');
  md = md.replace(/&#39;/g, "'");

  md = md.replace(/\n{4,}/g, '\n\n');
  // Collapse runs of spaces, but preserve indentation at line starts
  // (nested Markdown lists need it).
  md = md.replace(/([^\n \t])[ ]{2,}/g, '$1 ');

  return cleanText(md);
}
/** Extract selection text/html from a tab via scripting API */
async function processSelection(tabId, mode) {
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId },
      func: (extractHtml) => {
        const sel = window.getSelection();
        if (!sel || !sel.toString().trim()) {
          return { error: 'No text selected. Select text on the page first.' };
        }
        if (extractHtml && sel.rangeCount > 0) {
          const range = sel.getRangeAt(0);
          const container = document.createElement('div');
          container.appendChild(range.cloneContents());
          return { html: container.innerHTML, text: sel.toString() };
        }
        return { text: sel.toString() };
      },
      args: [mode === 'markdown']
    });

    if (!results || !results[0] || !results[0].result ||
        (results[0].result && results[0].result.error)) {
      return { error: (results[0] && results[0].result && results[0].result.error) || 'Could not access page selection.' };
    }

    const { html, text } = results[0].result;
    if (!text || !text.trim()) {
      return { error: 'No text selected. Select text on the page first.' };
    }
    if (mode === 'markdown' && html) {
      return { content: htmlToMarkdown(html) };
    }
    return { content: cleanText(text) };
  } catch (err) {
    return { error: `Could not process: ${err.message}` };
  }
}

/**
 * Copy to clipboard via offscreen document.
 * Robust: reuses existing document, waits for it to be ready before sending.
 */
async function copyToClipboard(text) {
  try {
    // Has contextIds check: createDocument throws if one already exists — handle that.
    const hasOffscreen = await chrome.offscreen.hasDocument?.();
    if (!hasOffscreen) {
      await chrome.offscreen.createDocument({
        url: chrome.runtime.getURL('offscreen.html'),
        reasons: ['CLIPBOARD'],
        justification: 'Copy cleaned text to clipboard'
      });
    }
    // Wait until the offscreen page signals readiness (avoids lost messages).
    await new Promise((resolve) => {
      const timeout = setTimeout(resolve, 1500); // safety net
      const listener = (msg) => {
        if (msg.type === 'offscreen-ready') {
          clearTimeout(timeout);
          chrome.runtime.onMessage.removeListener(listener);
          resolve();
        }
      };
      chrome.runtime.onMessage.addListener(listener);
      chrome.runtime.sendMessage({ type: 'ping-offscreen' }).catch(() => {});
    });
    const response = await chrome.runtime.sendMessage({ type: 'copy', text });
    if (!response || !response.success) throw new Error('Offscreen copy failed');
    return true;
  } catch (err) {
    console.error('Clipboard error:', err);
    return false;
  }
}

/** Inject a transient toast into the tab (requires activeTab access) */
async function showToast(tabId, message, isError = false) {
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      func: (msg, err) => {
        const existing = document.querySelector('.clean-copy-toast');
        if (existing) existing.remove();
        const toast = document.createElement('div');
        toast.textContent = msg;
        toast.style.cssText = `
          position: fixed; bottom: 24px; left: 50%; transform: translateX(-50%);
          padding: 10px 20px; border-radius: 8px;
          background: ${err ? '#ef5350' : '#1a1a2e'}; color: #fff;
          font-size: 13px; z-index: 2147483647;
          box-shadow: 0 4px 12px rgba(0,0,0,0.3); transition: opacity .3s;
          font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;`;
        document.body.appendChild(toast);
        setTimeout(() => {
          toast.style.opacity = '0';
          setTimeout(() => toast.remove(), 300);
        }, 2000);
      },
      args: [message, isError]
    });
  } catch {
    // Restricted pages (chrome://, Web Store) — silently skip the toast.
  }
}

async function doCopy(tabId, mode) {
  const result = await processSelection(tabId, mode);
  if (result.error) {
    await showToast(tabId, result.error, true);
    return false;
  }
  const ok = await copyToClipboard(result.content);
  if (ok) {
    await showToast(tabId, mode === 'markdown' ? '✨ Copied as Markdown' : '✅ Copied as clean text');
  } else {
    await showToast(tabId, '⚠ Could not copy to clipboard', true);
  }
  return ok;
}

// Context menu
chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({
      id: 'copy-plain',
      title: 'Copy as Clean Text',
      contexts: ['selection']
    });
    chrome.contextMenus.create({
      id: 'copy-markdown',
      title: 'Copy as Markdown',
      contexts: ['selection']
    });
  });
});

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (!tab || !tab.id) return;
  const mode = info.menuItemId === 'copy-markdown' ? 'markdown' : 'plain';
  await doCopy(tab.id, mode);
});

chrome.commands.onCommand.addListener(async (command) => {
  if (command === 'copy-as-markdown') {
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tabs.length === 0) return;
    await doCopy(tabs[0].id, 'markdown');
  }
});

// Messages from popup
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.type === 'process-selection') {
    chrome.tabs.query({ active: true, currentWindow: true }).then(async (tabs) => {
      if (tabs.length === 0) {
        sendResponse({ error: 'No active tab.' });
        return;
      }
      const result = await processSelection(tabs[0].id, request.mode || 'plain');
      sendResponse(result);
    });
    return true;
  }
});
