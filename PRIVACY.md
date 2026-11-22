# SubClick Privacy Policy

**Last updated:** November 22, 2026

**SubClick** is built with privacy in mind. We do **not** run our own backend servers, we do **not** track your browsing history, and we do **not** sell or share personal data with advertisers.

## What Data the Extension Processes

1. **Subtitle text for translation (`websiteContent`)**
   - When subtitles are visible on supported video sites (`youtube.com` and `netflix.com`), the extension reads the displayed subtitle text so you can click words for instant translations (and optionally batch-preload the active subtitle line when preloading is enabled).
   - Subtitle words and sentences are sent directly from your browser to public translation endpoints (`translate.googleapis.com`, `clients5.google.com`, and fallback `api.mymemory.translated.net`) strictly to retrieve translations. Requests are sent without credentials (`credentials: "omit"`).
   - No cookies, account details, video URLs, or personal identifiers are attached by the extension to translation requests.

2. **Local browser storage (`storage.local`)**
   - Your extension settings (target language, subtitle size, auto-pause preferences), your saved vocabulary list (words, translations, context sentences, and video titles), and a local cache of recently translated words are stored **exclusively on your device** in browser storage (`chrome.storage.local` / `browser.storage.local`).
   - You can export or delete your saved vocabulary at any time from the extension popup, and uninstalling the extension removes all locally stored data.

## What Data We Do NOT Collect

- No user accounts, login credentials, email addresses, or personal identifiers
- No analytics, telemetry, crash beacons, or advertising trackers
- No browsing history outside active subtitle reading on YouTube and Netflix

## Third-Party Services

Translation queries are handled directly by third-party translation APIs (Google Translate endpoints and MyMemory). Those services may process incoming HTTP requests (such as IP address and the text to translate) under their respective privacy policies.

## Contact

If you have any questions about this privacy policy, please open an issue on the project repository or contact the developer listed on the Chrome Web Store / Mozilla Add-ons store page.
