# SubClick — YouTube & Netflix Subtitle Word Translator

A zero-build Chrome Extension (Manifest V3) that makes subtitles on **YouTube** and **Netflix** interactive. Click any word in a subtitle to automatically pause playback, view its context-aware translation (with part-of-speech dictionary entries, romanization, and full-sentence translation), and save words to your personal vocabulary list.

## Features

- **Works on YouTube & Netflix** (including theater mode, fullscreen, auto-generated captions, and multi-line cues)
- **Zero API Key Required** — Uses built-in free translation (`translate.googleapis.com` with automatic fallback to `api.mymemory.translated.net`) and an LRU cache for instant repeat lookups
- **Context-Aware Homograph Disambiguation** — Detects the language of the full subtitle sentence first so cross-language lookalikes (e.g., French *pain*, Spanish *pan*, German *Gift*) translate accurately
- **Unicode Word Segmentation** — Powered by `Intl.Segmenter` to support Latin, Cyrillic, Arabic, Devanagari, and non-whitespace CJK/Thai scripts
- **Smart Auto-Pause & Auto-Resume** — Pauses when you click a word (including via Netflix's internal Cadmium `videoPlayer` bridge to prevent player state desync) and resumes when you close the card
- **Personal Vocabulary List** — Browse, search, delete, or export your saved words as **CSV** (Anki / Excel ready) or **JSON** from the extension popup

## Build Store Packages (Chrome & Firefox)

```bash
node scripts/package.js
```

This generates clean, store-ready bundles in `dist/`:
- `dist/subclick-chrome-v1.0.0.zip` (and unpacked `dist/chrome/`) for Chrome Web Store
- `dist/subclick-firefox-v1.0.0.zip` (and unpacked `dist/firefox/`) for Mozilla Add-ons (AMO)

## Install Locally

### Chrome / Brave / Edge / Nook
1. Open `chrome://extensions` (or your browser's Extensions settings).
2. Enable **Developer mode**.
3. Click **Load unpacked** and select this folder (or `dist/chrome/`).

### Firefox
1. Run `node scripts/package.js` to generate `dist/firefox/`.
2. Open `about:debugging#/runtime/this-firefox`.
3. Click **Load Temporary Add-on…** and select `dist/firefox/manifest.json`.

## Usage

1. Open any video on **YouTube** or **Netflix** and enable subtitles / closed captions (`CC`) in the video player.
2. Hover over any word in the subtitle to highlight it, and **click the word** to pause the video and open its translation card.
3. Click another word in the sentence to inspect it, toggle `★ Saved` to manage vocabulary, or press `Esc` / `×` / `Resume ▶` to continue watching.

## Project Structure

- `manifest.json` — Chrome Extension Manifest V3 configuration
- `src/background.js` — Translation service worker with sentence-context language detection, dictionary parsing, fallback provider, and LRU cache
- `src/shared/constants.js` — Default settings, language catalog, and CSV/vocabulary helpers
- `src/content/tokenizer.js` — Multilingual `Intl.Segmenter` subtitle word tokenizer
- `src/content/netflix-bridge.js` — `MAIN`-world bridge for Netflix's `videoPlayer` session pause/play API
- `src/content/platforms.js` — YouTube & Netflix DOM subtitle extractors and playback adapters
- `src/content/content.js` & `src/content/content.css` — Interactive subtitle overlay and floating translation card
- `src/popup/` — Extension popup UI for settings and searchable/exportable vocabulary list
- `tests/extension.test.js` — Automated unit tests

## Run Tests

```bash
node --test tests/extension.test.js
```
