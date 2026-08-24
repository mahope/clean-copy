/**
 * Clean Copy — Background Service Worker
 * Context menu, keyboard shortcut, HTML→Markdown conversion,
 * clipboard via offscreen document, toast injected on demand.
 * Permissions: activeTab only — no host_permissions, no static content scripts.
 * Pro: custom cleanup rules from chrome.storage are applied after every copy.
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

/**
 * Strip remaining tags while tolerating ">" inside attribute values.
 * A naive /<[^>]*>/ stops at the first ">" even when it sits inside a
 * quoted attribute (Wikipedia's data-mw JSON, inline handlers), which
 * leaks raw markup/JSON into the output and eats real text after it.
 */
function stripTagsSafe(html) {
  let out = '';
  let i = 0;
  const n = html.length;
  while (i < n) {
    const lt = html.indexOf('<', i);
    if (lt === -1) { out += html.slice(i); break; }
    out += html.slice(i, lt);
    // Find the real end of this tag: scan forward, respecting quotes.
    let j = lt + 1, quote = null;
    while (j < n) {
      const ch = html[j];
      if (quote) {
        if (ch === quote) quote = null;
      } else if (ch === '"' || ch === "'") {
        quote = ch;
      } else if (ch === '>') {
        break;
      }
      j++;
    }
    if (j >= n) { out += html.slice(lt); break; } // unterminated tag: keep text
    i = j + 1;
  }
  return out;
}

function cleanText(text) {
  let cleaned = text;
  for (const rule of CLEAN_RULES) {
    cleaned = cleaned.replace(rule.pattern, rule.replacement);
  }
  return cleaned.trim();
}

function htmlToMarkdown(html) {
  let md = html;

  // Strip script/style/noscript/template content BEFORE any tag rules run —
  // otherwise JS/CSS text leaks into the output as plain text.
  md = md.replace(/<(script|style|noscript|template|head)\b[^>]*>[\s\S]*?<\/\1>/gi, '');

  // CDATA sections: keep the raw content instead of dropping everything.
  md = md.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1');

  // Strip SVG and MathML subtrees entirely — their internal markup/text
  // would otherwise leak into the output as noise. <math alt> is kept.
  md = md.replace(/<(svg|math)\b[^>]*>[\s\S]*?<\/\1>/gi,
    (m, tag) => {
      if (tag.toLowerCase() === 'math') {
        const alt = /alt="([^"]*)"/i.exec(m);
        if (alt && alt[1]) return '\n' + alt[1].trim() + '\n';
      }
      return '';
    });

  // Form controls that render as widgets, not text: keep only meaningful
  // text, each on its own line so options don't glue together.
  md = md.replace(/<select\b[^>]*>([\s\S]*?)<\/select>/gi, (_, body) => {
    const opts = [];
    const re = /<(?:option|optgroup)\b[^>]*>/gi;
    let m;
    while ((m = re.exec(body)) !== null) {
      const labelM = /label="([^"]*)"/i.exec(m[0]);
      // optgroup uses its label; option uses its text content
      if (labelM) { opts.push(labelM[1].trim()); continue; }
      const rest = body.slice(re.lastIndex);
      const text = /^([^<]*)/.exec(rest)[1];
      if (text.trim()) opts.push(text.trim());
    }
    return opts.length ? '\n' + opts.join('\n') + '\n' : '';
  });
  md = md.replace(/<(input|textarea)\b[^>]*>/gi, (m, tag) => {
    if (tag.toLowerCase() === 'textarea') {
      // textarea content is its value; handled below via paired match
      return m;
    }
    const val = /value="([^"]*)"/i.exec(m);
    return val && val[1] ? '\n' + val[1] + '\n' : '';
  });

  // iframe/object fallback content is kept as a separate block — without
  // this the fallback text glues onto whatever block follows the tag.
  md = md.replace(/<(iframe|object)\b[^>]*>([\s\S]*?)<\/\1>/gi,
    (_, tag, body) => {
      if (tag.toLowerCase() === 'object') {
        // drop nested <param> tags, keep visible fallback text as a block
        return '\n' + body.replace(/<param\b[^>]*>/gi, '') + '\n';
      }
      return '\n' + body + '\n';
    });

  // <details>/<summary>: keep the content, summary becomes a bold line so
  // collapsible sections don't lose their heading.
  md = md.replace(/<details[^>]*>([\s\S]*?)<\/details>/gi, (_, body) => {
    let out = '';
    const sum = body.match(/<summary[^>]*>([\s\S]*?)<\/summary>/i);
    if (sum) out += '**' + htmlToMarkdown(sum[1]).trim() + '**\n\n';
    out += htmlToMarkdown(body.replace(/<summary[^>]*>[\s\S]*?<\/summary>/i, ''));
    return '\n' + out + '\n\n';
  });

  // Definition lists: <dt> becomes a bold term line, <dd> an indented line.
  md = md.replace(/<dl[^>]*>([\s\S]*?)<\/dl>/gi, (_, body) => {
    const parts = [];
    const re = /<(dt|dd)[^>]*>([\s\S]*?)<\/\1>/gi;
    let m;
    while ((m = re.exec(body)) !== null) {
      const text = m[2].replace(/<[^>]*>/g, '').trim();
      if (!text) continue;
      parts.push(m[1].toLowerCase() === 'dt' ? '**' + text + '**' : ':   ' + text);
    }
    return parts.length ? '\n' + parts.join('\n') + '\n\n' : '';
  });

  // Figure captions: separate the caption from the image so it doesn't
  // glue onto the end of the ![](src) line.
  md = md.replace(/<figcaption[^>]*>([\s\S]*?)<\/figcaption>/gi,
    (_, cap) => '\n\n' + cap + '\n\n');

  // Blockquotes: convert innermost-first (like nested lists), prefixing every
  // line of the quoted content with "> " so Markdown quoting survives.
  let bqPrev;
  do {
    bqPrev = md;
    md = md.replace(/<blockquote[^>]*>((?:(?!<\/?blockquote)[\s\S])*)<\/blockquote>/gi,
      (_, body) => {
        const inner = htmlToMarkdown(body);
        const quoted = inner.split('\n').map(l => (l ? '> ' + l : '>')).join('\n');
        return '\n' + quoted + '\n';
      });
  } while (md !== bqPrev);

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

  md = md.replace(/<pre[^>]*>([\s\S]*?)<\/pre>/gis, (_, code) => {
    let lang = '';
    const langMatch = /<code[^>]*class=["'][^"']*\b(?:language-|lang-|brush:\s*)([a-zA-Z0-9+#_]+)\b[^"']*["'][^>]*>/i.exec(code)
      || /<pre[^>]*class=["'][^"']*\b(?:language-|lang-)([a-zA-Z0-9+#_]+)\b[^"']*["'][^>]*>/i.exec(code);
    if (langMatch) lang = langMatch[1].toLowerCase();
    code = code.replace(/<code[^>]*>/gi, '').replace(/<\/code>/gi, '');
    code = code.replace(/<br\s*\/?>/gi, '\n');
    return '```' + lang + '\n' + code.trim() + '\n```\n\n';
  });

  md = md.replace(/<code[^>]*>(.*?)<\/code>/gi, '`$1`');

  // Abbreviations: <abbr title="..."> becomes "Term (Title)" at the FIRST
  // occurrence in the output; later occurrences keep just the term so the
  // parenthetical isn't repeated on every use.
  const abbrSeen = new Set();
  md = md.replace(/<abbr[^>]*title="([^"]*)"[^>]*>([\s\S]*?)<\/abbr>|<abbr[^>]*>([\s\S]*?)<\/abbr>/gi,
    (m, title, term1, term2) => {
      const term = (term1 || '').trim() || (term2 || '').trim();
      if (!term) return '';
      const t = (title || '').trim();
      if (t && !abbrSeen.has(term.toLowerCase() + '|' + t)) {
        abbrSeen.add(term.toLowerCase() + '|' + t);
        return term + ' (' + t + ')';
      }
      return term;
    });

  // Tables: converted innermost-FIRST (like lists/blockquotes) so tables
  // nested inside cells survive instead of being torn apart by a lazy
  // outer match that stops at the inner </table>.
  let tblPrev;
  // Column alignment: collect text-align from th/td style/align attrs per column
  // (header row wins; first non-default declaration sets it). Returns ':---',
  // '---:', ':---:' or ' --- '.
  const alignOf = (tag) => {
    const style = (tag.match(/style\s*=\s*[\x22\x27]([^\x22\x27]*)[\x22\x27]/i) || [])[1] || '';
    const attr = (tag.match(/\balign\s*=\s*[\x22\x27]([^\x22\x27]*)[\x22\x27]/i) || [])[1] || '';
    const hay = (style.replace(/;/g, ' ') + ' ' + attr).toLowerCase();
    if (/text-align\s*:\s*(center|right|left)|\b(center|right|left)\b/.test(hay)) {
      if (/\bleft\b/.test(hay)) return ':---';
      if (/\bright\b/.test(hay)) return '---:';
      if (/\bcenter\b/.test(hay)) return ':---:';
    }
    return null;
  };
  const convertTable = (_, tableHtml) => {
    const cellText = (cellHtml) => {
      let t = htmlToMarkdown(cellHtml);
      return t.replace(/\s*\n+\s*/g, ' ').replace(/\|/g, '\\|').trim();
    };
    const rows = [];
    const aligns = [];
    const trRe = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
    let trm;
    while ((trm = trRe.exec(tableHtml)) !== null) {
      const cells = [];
      const rowAligns = [];
      const cellRe = /<(th|td)\b([^>]*)>([\s\S]*?)<\/\1>/gi;
      let cm;
      while ((cm = cellRe.exec(trm[1])) !== null) {
        cells.push(cellText(cm[3]));
        const spanMatch = /colspan\s*=\s*[\x22\x27]?(\d+)[\x22\x27]?/i.exec(cm[2]);
        const span = Math.max(1, parseInt(spanMatch ? spanMatch[1] : '1', 10) || 1);
        for (let s = 0; s < span; s++) {
          if (s === 0) rowAligns.push(alignOf(cm[2]));
          else rowAligns.push(null);
        }
      }
      rows.push(cells);
      aligns.push(rowAligns);
    }
    if (rows.length === 0) return '';
    const cols = Math.max(...rows.map(r => r.length));
    rows.forEach(r => { while (r.length < cols) r.push(''); });
    aligns.forEach(a => { while (a.length < cols) a.push(null); });
    // Header alignment wins over body rows.
    const colAlign = Array(cols).fill(null);
    for (let c = 0; c < cols; c++) {
      for (const a of aligns) { if (a[c]) { colAlign[c] = a[c]; break; } }
    }
    const sepRow = Array.from({length: cols}, (_, i) => colAlign[i] || ' --- ');
    const out = ['| ' + rows[0].join(' | ') + ' |',
                 '|' + sepRow.join('|') + '|'];
    for (let i = 1; i < rows.length; i++) {
      out.push('| ' + rows[i].join(' | ') + ' |');
    }
    return '\n' + out.join('\n') + '\n\n';
  };
  do {
    tblPrev = md;
    md = md.replace(/<table[^>]*>((?:(?!<table[\s>]|<\/table)[\s\S])*)<\/table>/gi, convertTable);
  } while (md !== tblPrev);

// Lists: convert innermost lists repeatedly until none remain,
  // so arbitrarily deep nesting produces one "- " per item.
  const convertList = (_, openTag, body) => {
    const ordered = /^<ol/i.test(openTag);
    // <ol start="3"> continues numbering from the given value.
    let idx = 0;
    const startAttr = /start\s*=\s*["']?(\d+)["']?/i.exec(openTag);
    if (ordered && startAttr) idx = Math.max(0, parseInt(startAttr[1], 10) - 1);
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
    if (items.length === 0) {
      // Malformed markup (e.g. "<ul>" directly inside "<ul>") has no <li>
      // children. Return the body untouched so its content survives
      // instead of being silently dropped.
      return '\n' + body + '\n';
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

  // Strip remaining tags. Tolerate ">" inside attribute values (e.g. the
  // JSON in Wikipedia's data-mw attributes): a naive <[^>]*> would stop at
  // the inner ">", leak raw markup/JSON into the output and eat real text.
  md = stripTagsSafe(md);
  var ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: '\u00A0',
    copy: '\u00A9', reg: '\u00AE', trade: '\u2122', hellip: '\u2026', mdash: '\u2014', ndash: '\u2013',
    lsquo: '\u2018', rsquo: '\u2019', ldquo: '\u201C', rdquo: '\u201D',
    eacute: '\u00E9', egrave: '\u00E8', agrave: '\u00E0', ccedil: '\u00E7', uuml: '\u00FC', ouml: '\u00F6', auml: '\u00E4',
    aring: '\u00E5', oslash: '\u00F8', aelig: '\u00E6', ntilde: '\u00F1', iuml: 'ï', szlig: '\u00DF', euro: '\u20AC', deg: '\u00B0' };
  md = md.replace(/&(#[0-9]+|#x[0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]*);/g, function (ent, body) {
    if (body[0] === '#') {
      var code = body[1] === 'x' || body[1] === 'X' ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : ent;
    }
    return Object.prototype.hasOwnProperty.call(ENTITIES, body) ? ENTITIES[body] : ent;
  });
  // Last pass: don't let decoded entities re-expand (parity with the
  // extension's background.js, which has always done this).
  md = md.replace(/&amp;/g, '&');

  md = md.replace(/\n{4,}/g, '\n\n');
  // Collapse runs of spaces, but preserve indentation at line starts
  // (nested Markdown lists need it).
  md = md.replace(/([^\n \t])[ ]{2,}/g, '$1 ');

  return cleanText(md);
}

/* ── Pro: custom cleanup rules ────────────────────────────────────
 * Rules live in chrome.storage.local ({customRules:[...]}), edited on
 * the options page. They are compiled once per storage version and
 * applied to the final output after normal cleaning. A rule that
 * fails to compile is skipped silently — copying must never break. */

let proState = { active: false, compiled: [], version: 0 };

function compileRules(rules) {
  if (!Array.isArray(rules)) return [];
  return rules.map((r) => {
    try {
      const flags = r.caseSensitive === false ? 'gi' : 'g';
      const re = r.regex ? new RegExp(r.find, flags)
        : new RegExp(r.find.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), flags);
      return { re, replace: String(r.replace == null ? '' : r.replace) };
    } catch (e) {
      return null; // skip broken rules — copy keeps working
    }
  }).filter(Boolean);
}

function applyCompiled(text) {
  let out = text;
  for (const c of proState.compiled) out = out.replace(c.re, c.replace);
  return cleanText(out);
}

chrome.storage.local.get(['proLicense', 'customRules'], (d) => {
  proState.active = !!d.proLicense;
  proState.compiled = proState.active ? compileRules(d.customRules) : [];
});
chrome.storage.onChanged.addListener((changes) => {
  if (changes.customRules || changes.proLicense) {
    chrome.storage.local.get(['proLicense', 'customRules'], (d) => {
      proState.active = !!d.proLicense;
      proState.compiled = proState.active ? compileRules(d.customRules) : [];
    });
  }
});

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

/** Apply Pro custom rules to a finished conversion result. */
function withProRules(result) {
  if (!result || result.error || !proState.active || !result.content) return result;
  return { ...result, content: applyCompiled(result.content), proApplied: true };
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
  const result = withProRules(await processSelection(tabId, mode));
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

// Messages from popup + options page (batch conversion)
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.type === 'process-selection') {
    chrome.tabs.query({ active: true, currentWindow: true }).then(async (tabs) => {
      if (tabs.length === 0) {
        sendResponse({ error: 'No active tab.' });
        return;
      }
      const result = withProRules(await processSelection(tabs[0].id, request.mode || 'plain'));
      sendResponse(result);
    });
    return true;
  }
  if (request.type === 'get-pro-state') {
    sendResponse({ active: proState.active });
    return false;
  }
});
