# Clean Copy

Copy any selected text as **clean, formatted Markdown** — right from your browser's right-click menu. No more messy pastes with broken styling, inline CSS junk, or lost formatting.

![Version](https://img.shields.io/badge/version-1.1.0-blue) ![Chrome](https://img.shields.io/badge/Chrome-MV3-green) ![License](https://img.shields.io/badge/license-MIT-lightgrey)

## What it does

Select text on any webpage → right-click → **Clean Copy**:

- Converts headings, bold, italic, links, lists (nested too), code blocks, blockquotes and tables to proper Markdown
- Strips ads, scripts, hidden elements and inline styling
- Unescapes HTML entities so `&amp;` becomes `&`
- Copies straight to your clipboard as clean Markdown

Keyboard shortcut: <kbd>Ctrl+Shift+C</kbd> (Windows/Linux) / <kbd>Cmd+Shift+C</kbd> (Mac)

The popup also lets you paste-and-clean: drop in dirty HTML or messy text and get clean Markdown out.

## Install (from source, ~30 seconds)

No build step. No dependencies. Plain JavaScript.

1. Download or clone this repository:
   ```bash
   git clone https://github.com/mahope/clean-copy.git
   ```
2. Open Chrome and go to `chrome://extensions`
3. Turn on **Developer mode** (top right)
4. Click **Load unpacked** and select the cloned folder
5. Done — select some text, right-click, choose **Clean Copy**

## Privacy

Clean Copy does exactly one thing on the page you're looking at, when you ask it to. There is:

- **No analytics, no tracking, no telemetry**
- **No network requests** — nothing leaves your browser
- No background content scripts running on every page (uses `activeTab` only)

Permissions explained: `activeTab` + `scripting` (read selection when you click), `clipboardWrite` (copy result), `contextMenus` (the right-click item), `offscreen` + `storage` (reliable clipboard handling).

## Running tests

```bash
node tools/test_clean_copy.js
```

Tests cover text cleaning, HTML→Markdown conversion (headings, nested lists, code blocks, entities) and edge cases.

## Links

- Landing page & download: https://hermes-passiv.pages.dev/clean-copy

## License

MIT
