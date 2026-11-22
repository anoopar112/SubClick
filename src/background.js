'use strict';

if (typeof importScripts === 'function') {
  const scriptsToLoad = [
    ['shared/constants.js', '/src/shared/constants.js'],
    ['shared/translator.js', '/src/shared/translator.js']
  ];
  for (const candidates of scriptsToLoad) {
    for (const rel of candidates) {
      try {
        importScripts(rel);
        break;
      } catch (_) {
        // Try next path candidate
      }
    }
  }
}

const Translator =
  globalThis.SubClickTranslator ||
  (typeof require === 'function' ? require('./shared/translator.js') : null);

async function handleTranslationMessage(message) {
  if (!Translator) {
    return { ok: false, error: 'Translator module failed to load' };
  }

  const payload = (message && message.payload) || {};

  try {
    if (message.type === 'TRANSLATE_SINGLE') {
      const data = await Translator.translateSingle(
        payload.text,
        payload.sourceLang,
        payload.targetLang,
        Boolean(payload.includeDictionary),
        { requireEnriched: Boolean(payload.requireEnriched) }
      );
      return { ok: true, data };
    }

    if (message.type === 'TRANSLATE_BATCH') {
      const data = await Translator.translateBatch(
        payload.entries,
        payload.sourceLang,
        payload.targetLang
      );
      return { ok: true, data };
    }

    if (message.type === 'TRANSLATE_WORD_AND_SENTENCE') {
      const data = await Translator.translateWordAndSentence(payload);
      return { ok: true, data };
    }

    return null;
  } catch (err) {
    return {
      ok: false,
      isRateLimit: Boolean(err && err.isRateLimit),
      error: err && err.message ? err.message : 'Translation request failed'
    };
  }
}

function isHandledMessage(message) {
  return Boolean(
    message &&
      (message.type === 'TRANSLATE_SINGLE' ||
        message.type === 'TRANSLATE_BATCH' ||
        message.type === 'TRANSLATE_WORD_AND_SENTENCE' ||
        message.type === 'SUBCLICK_PING')
  );
}

// Register listener compatible with both WebKit WKWebExtension (`browser` Promise API)
// and Chromium MV3 (`chrome` callback + `return true` API).
if (
  typeof browser !== 'undefined' &&
  browser.runtime &&
  browser.runtime.onMessage &&
  typeof browser.runtime.onMessage.addListener === 'function'
) {
  browser.runtime.onMessage.addListener((message) => {
    if (!isHandledMessage(message)) {
      return undefined;
    }
    if (message.type === 'SUBCLICK_PING') {
      return Promise.resolve({ ok: true });
    }
    return handleTranslationMessage(message);
  });
} else if (
  typeof chrome !== 'undefined' &&
  chrome.runtime &&
  chrome.runtime.onMessage &&
  typeof chrome.runtime.onMessage.addListener === 'function'
) {
  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (!isHandledMessage(message)) {
      return false;
    }
    if (message.type === 'SUBCLICK_PING') {
      sendResponse({ ok: true });
      return false;
    }
    handleTranslationMessage(message).then(sendResponse);
    return true; // Keep async message channel open in Chromium
  });
}

if (typeof module !== 'undefined' && module.exports && Translator) {
  module.exports = {
    parseGoogleDjResponse: Translator.parseGoogleDjResponse,
    parseGoogleArrayResponse: Translator.parseGoogleArrayResponse,
    parseGoogleClients5Response: Translator.parseGoogleClients5Response,
    parseGoogleClients5BatchResponse: Translator.parseGoogleClients5BatchResponse,
    parseMyMemoryResponse: Translator.parseMyMemoryResponse,
    fetchSingleTranslation: Translator.translateSingle,
    translateBatch: Translator.translateBatch,
    translateWordAndSentence: Translator.translateWordAndSentence,
    hydratePersistentCache: Translator.hydratePersistentCache,
    exportPersistentCache: Translator.exportPersistentCache,
    handleTranslationMessage,
    _clearCacheForTests: Translator.clearCache
  };
}
