#!/usr/bin/env node
/**
 * Clean Copy — Chrome version logic tests.
 * Loads extension-clean-copy/background.js with a Chrome-API stub and
 * runs the same assertions as the Firefox port's test suite.
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const src = fs.readFileSync(path.join(__dirname, '..', 'background.js'), 'utf8');

const sandbox = {
  console,
  navigator: { clipboard: { writeText: async () => {} } },
  document: {
    createElement: () => ({ style: {}, select: () => {}, remove: () => {} }),
    body: { appendChild: () => {}, removeChild: () => {} },
  },
  chrome: {
    runtime: {
      lastError: null,
      onInstalled: { addListener: () => {} },
      onMessage: { addListener: () => {} },
      getURL: (p) => p,
      sendMessage: async () => {},
    },
    contextMenus: { create: () => {}, removeAll: (cb) => cb && cb(), onClicked: { addListener: () => {} } },
    commands: { onCommand: { addListener: () => {} } },
    scripting: { executeScript: async () => [] },
    tabs: { query: async () => [] },
    storage: { local: { get: async () => ({}), set: async () => {} }, onChanged: { addListener: () => {} } },
    notifications: { create: () => {} },
    offscreen: { hasDocument: async () => true, createDocument: async () => {} },
  },
};
vm.createContext(sandbox);
vm.runInContext(src, sandbox);

let pass = 0, fail = 0;
function t(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) { pass++; } else { fail++; console.log(`FAIL ${name}\n  got: ${JSON.stringify(actual)}\n  exp: ${JSON.stringify(expected)}`); }
}

const { cleanText, htmlToMarkdown } = sandbox;

t('smart double quotes', cleanText('\u201Chello\u201D'), '"hello"');
t('em dash', cleanText('a\u2014b'), 'a -- b');
t('zero-width chars removed', cleanText('a\u200Bb\uFEFFc'), 'abc');
t('nbsp to space', cleanText('a\u00A0b'), 'a b');

t('h1', htmlToMarkdown('<h1>Title</h1>'), '# Title');
t('bold', htmlToMarkdown('<strong>hi</strong>'), '**hi**');
t('link', htmlToMarkdown('<a href="https://x.dk">X</a>'), '[X](https://x.dk)');
t('code block', htmlToMarkdown('<pre><code>let x = 1;\n&amp;&amp; true;</code></pre>'), '```\nlet x = 1;\n&& true;\n```');
t('entity decode', htmlToMarkdown('<p>A &amp; B &lt; C &gt; D &quot;E&quot; F&#39;s</p>'), 'A & B < C > D "E" F\'s');
t('nested list', htmlToMarkdown('<ul><li>a<ul><li>b</li></ul></li></ul>').trim(), '- a\n  - b');
t('nested list 3', htmlToMarkdown('<ul><li>a<ul><li>b<ul><li>c</li></ul></li></ul></li></ul>').trim(), '- a\n  - b\n    - c');
t('ordered list', htmlToMarkdown('<ol><li>one</li><li>two</li></ol>').trim(), '1. one\n2. two');
t('invisible word joiners stripped', cleanText('Guard\u2060ian artic\u2062le'), 'Guardian article');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
