const fs = require('fs');
const vm = require('vm');

// Strip chrome API listeners; keep pure functions cleanText/htmlToMarkdown.
let src = fs.readFileSync('extension-clean-copy/background.js', 'utf8');
src = src.split('// Context menu')[0];

const sandbox = {};
vm.createContext(sandbox);
vm.runInContext(src, sandbox);

const assert = require('assert');
const t1 = sandbox.cleanText('  \u201Csmart\u201D  \u00A0  text\u200B  ');
assert.strictEqual(t1, '"smart" text', 'cleanText');
console.log('cleanText OK:', JSON.stringify(t1));

const md = sandbox.htmlToMarkdown(
  '<h2>Title</h2><p>Hello <strong>world</strong> and <a href="https://x.com">link</a>.</p>' +
  '<ul><li>one</li><li>two</li></ul><pre><code>if (a &lt; b) {}</code></pre>'
);
console.log('--- markdown output ---');
console.log(md);
assert(md.startsWith('## Title'), 'h2');
assert(/\*\*world\*\*/.test(md), 'bold');
assert(/\[link\]\(https:\/\/x\.com\)/.test(md), 'link');
assert(/- one/.test(md) && /- two/.test(md), 'list');
assert(/```/.test(md) && /if \(a < b\) \{\}/.test(md), 'code block + entity unescape');
console.log('htmlToMarkdown OK');
