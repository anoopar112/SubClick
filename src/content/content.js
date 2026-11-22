(function () {
  'use strict';

  const Constants = globalThis.SubClickConstants;
  const Translator = globalThis.SubClickTranslator;
  const Tokenizer = globalThis.SubClickTokenizer;
  const Platforms = globalThis.SubClickPlatforms;

  if (!Constants || !Tokenizer || !Platforms) {
    return;
  }

  const platform = Platforms.detectPlatform(window.location.hostname);
  if (!platform) {
    return;
  }

  // Cross-browser extension API compatibility (Chrome MV3 + WebKit WKWebExtension / Nook / Safari)
  const hasBrowserRuntime =
    typeof browser !== 'undefined' &&
    browser.runtime &&
    typeof browser.runtime.sendMessage === 'function';
  const hasChromeRuntime =
    typeof chrome !== 'undefined' &&
    chrome.runtime &&
    typeof chrome.runtime.sendMessage === 'function';

  const hasBrowserStorage =
    typeof browser !== 'undefined' &&
    browser.storage &&
    browser.storage.local &&
    typeof browser.storage.local.get === 'function';
  const hasChromeStorage =
    typeof chrome !== 'undefined' &&
    chrome.storage &&
    chrome.storage.local &&
    typeof chrome.storage.local.get === 'function';

  function storageGet(keys) {
    if (hasBrowserStorage) {
      return browser.storage.local.get(keys).catch(() => ({}));
    }
    if (hasChromeStorage) {
      return new Promise((resolve) => {
        try {
          chrome.storage.local.get(keys, (res) => resolve(res || {}));
        } catch (_) {
          resolve({});
        }
      });
    }
    return Promise.resolve({});
  }

  function storageSet(obj) {
    if (hasBrowserStorage) {
      return browser.storage.local.set(obj).catch(() => {});
    }
    if (hasChromeStorage) {
      return new Promise((resolve) => {
        try {
          chrome.storage.local.set(obj, () => resolve());
        } catch (_) {
          resolve();
        }
      });
    }
    return Promise.resolve();
  }

  function sendRuntimeMessageOnce(message, timeoutMs) {
    const ms = timeoutMs || 4500;
    return new Promise((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (!settled) {
          settled = true;
          reject(new Error('Background worker timed out'));
        }
      }, ms);

      const finish = (err, val) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (err) reject(err);
        else resolve(val);
      };

      if (hasBrowserRuntime) {
        try {
          browser.runtime
            .sendMessage(message)
            .then((res) => finish(null, res))
            .catch((err) => finish(err || new Error('Runtime messaging failed')));
        } catch (err) {
          finish(err);
        }
        return;
      }

      if (hasChromeRuntime) {
        try {
          chrome.runtime.sendMessage(message, (res) => {
            if (chrome.runtime.lastError) {
              finish(new Error(chrome.runtime.lastError.message || 'Extension communication error'));
            } else {
              finish(null, res);
            }
          });
        } catch (err) {
          finish(err);
        }
        return;
      }

      finish(new Error('Extension runtime unavailable'));
    });
  }

  async function sendRuntimeMessage(message) {
    const res = await sendRuntimeMessageOnce(message, 4500);
    if (res !== undefined && res !== null) {
      return res;
    }
    // WebKit WKWebExtension / MV3 service worker cold wake-up retry
    await new Promise((r) => setTimeout(r, 80));
    const retryRes = await sendRuntimeMessageOnce(message, 4500);
    if (retryRes !== undefined && retryRes !== null) {
      return retryRes;
    }
    throw new Error('Background service worker returned empty response');
  }

  // Smart Dual-Transport Translation Client (Direct CORS fetch + Background Worker fallback)
  const smartInflight = new Map();
  let preferredTransport = Translator ? 'direct' : 'background';
  let persistCacheTimer = null;

  function schedulePersistWordCache() {
    if (!Translator || typeof Translator.exportPersistentCache !== 'function') return;
    if (persistCacheTimer) return;
    persistCacheTimer = setTimeout(() => {
      persistCacheTimer = null;
      const snapshot = Translator.exportPersistentCache(3500);
      if (snapshot.length > 0) {
        storageSet({ [Constants.STORAGE_KEYS.WORD_CACHE]: snapshot });
      }
    }, 3000);
  }

  function getCachedSingleResult(text, sl, tl, includeDictionary) {
    if (Translator && typeof Translator.getCachedSingle === 'function') {
      return Translator.getCachedSingle(text, sl, tl, includeDictionary);
    }
    return undefined;
  }

  function cacheSingleResult(text, sl, tl, includeDictionary, result) {
    if (Translator && typeof Translator.putCachedSingle === 'function') {
      Translator.putCachedSingle(text, sl, tl, includeDictionary, result);
    }
    if (includeDictionary && result && result.translation) {
      schedulePersistWordCache();
    }
  }

  async function translateViaDirect(text, sl, tl, includeDictionary, requireEnriched) {
    if (!Translator) {
      throw new Error('Direct translator unavailable');
    }
    return Translator.translateSingle(text, sl, tl, includeDictionary, { requireEnriched });
  }

  async function translateViaBackground(text, sl, tl, includeDictionary, requireEnriched) {
    const response = await sendRuntimeMessage({
      type: 'TRANSLATE_SINGLE',
      payload: {
        text,
        sourceLang: sl,
        targetLang: tl,
        includeDictionary,
        requireEnriched: Boolean(requireEnriched)
      }
    });
    if (!response || !response.ok || !response.data) {
      const err = new Error((response && response.error) || 'Background translation failed');
      if (response && response.isRateLimit) err.isRateLimit = true;
      throw err;
    }
    return response.data;
  }

  async function fetchSingleSmart(text, sourceLang, targetLang, includeDictionary, options) {
    const clean = String(text || '').trim();
    if (!clean) {
      return { translation: '', romanization: '', dictionary: [], detectedLang: '', enriched: true };
    }

    const opts = options || {};
    const requireEnriched = Boolean(opts.requireEnriched);
    const sl = sourceLang || 'auto';
    const tl = targetLang || 'en';

    const cached = getCachedSingleResult(clean, sl, tl, includeDictionary);
    if (cached && (!requireEnriched || cached.enriched)) {
      return cached;
    }

    const key = `${requireEnriched ? 'e' : 'n'}|${includeDictionary ? 'd' : 's'}|${sl}|${tl}|${clean}`;
    if (smartInflight.has(key)) {
      return smartInflight.get(key);
    }

    const promise = (async () => {
      const order =
        preferredTransport === 'direct'
          ? ['direct', 'background']
          : ['background', 'direct'];

      let lastErr = null;
      for (const mode of order) {
        try {
          const res =
            mode === 'direct'
              ? await translateViaDirect(clean, sl, tl, includeDictionary, requireEnriched)
              : await translateViaBackground(clean, sl, tl, includeDictionary, requireEnriched);

          preferredTransport = mode;
          cacheSingleResult(clean, sl, tl, includeDictionary, res);
          return res;
        } catch (err) {
          lastErr = err;
        }
      }

      throw lastErr || new Error('Translation service unreachable');
    })();

    smartInflight.set(key, promise);
    try {
      return await promise;
    } finally {
      smartInflight.delete(key);
    }
  }

  async function fetchBatchSmart(entries, sourceLang, targetLang) {
    if (!Array.isArray(entries) || entries.length === 0) {
      return { items: [], detectedLang: sourceLang || '' };
    }

    const sl = sourceLang || 'auto';
    const tl = targetLang || 'en';
    const order =
      preferredTransport === 'direct'
        ? ['direct', 'background']
        : ['background', 'direct'];

    let lastErr = null;
    for (const mode of order) {
      try {
        let batchRes;
        if (mode === 'direct') {
          if (!Translator || typeof Translator.translateBatch !== 'function') {
            throw new Error('Direct batch translator unavailable');
          }
          batchRes = await Translator.translateBatch(entries, sl, tl);
        } else {
          const response = await sendRuntimeMessage({
            type: 'TRANSLATE_BATCH',
            payload: { entries, sourceLang: sl, targetLang: tl }
          });
          if (!response || !response.ok || !response.data) {
            const err = new Error((response && response.error) || 'Background batch failed');
            if (response && response.isRateLimit) err.isRateLimit = true;
            throw err;
          }
          batchRes = response.data;
        }

        preferredTransport = mode;

        // Ensure local Translator cache holds every batch result (especially when background ran it)
        let cachedWordCount = 0;
        for (const item of (batchRes && batchRes.items) || []) {
          cacheSingleResult(item.text, sl, tl, item.isWord, item.result);
          if (item.isWord) cachedWordCount++;
        }
        if (cachedWordCount > 0) {
          schedulePersistWordCache();
        }
        return batchRes;
      } catch (err) {
        lastErr = err;
      }
    }

    throw lastErr || new Error('Batch preload failed');
  }

  // Script group detector to automatically reset sessionDetectedLang if caption track script changes
  function detectScriptGroup(text) {
    const sample = String(text || '');
    if (/[\u3040-\u30ff\u4e00-\u9fff\uac00-\ud7af]/.test(sample)) return 'cjk';
    if (/[\u0400-\u04ff]/.test(sample)) return 'cyrillic';
    if (/[\u0600-\u06ff]/.test(sample)) return 'arabic';
    if (/[\u0900-\u097f]/.test(sample)) return 'devanagari';
    if (/[\u0e00-\u0e7f]/.test(sample)) return 'thai';
    if (/[\u0590-\u05ff]/.test(sample)) return 'hebrew';
    if (/[\u0370-\u03ff]/.test(sample)) return 'greek';
    if (/[A-Za-z\u00c0-\u024f]/.test(sample)) return 'latin';
    return '';
  }

  let settings = Object.assign({}, Constants.DEFAULT_SETTINGS);
  let savedVocabIds = new Set();

  let rootEl = null;
  let subtitleWrapEl = null;
  let subtitleBoxEl = null;
  let tooltipEl = null;

  let currentPlayer = null;
  let currentNativeContainer = null;
  let watchedVideoEl = null;

  let lastVideoUrl = window.location.href;
  let sessionDetectedLang = '';
  let lastScriptGroup = '';

  let lastRenderedText = '';
  let currentSentenceText = '';
  let currentSubtitleWords = [];
  let isTooltipOpen = false;
  let activeWordSpan = null;
  let pausedByExtension = false;
  let activeRequestId = 0;
  let currentVocabEntry = null;
  let isCurrentWordSaved = false;
  let syncScheduled = false;
  let hoverPrefetchTimer = null;

  // Background subtitle preloader state (with pacing + automatic rate-limit circuit breaker)
  const PRELOAD_DEBOUNCE_MS = 120;
  const PRELOAD_MIN_INTERVAL_MS = 750;
  const PRELOAD_BACKOFF_MS = 3 * 60 * 1000;
  let preloadTimer = null;
  let lastPreloadSentAt = 0;
  let preloadPausedUntil = 0;
  let consecutivePreloadFailures = 0;
  let preloadGeneration = 0;

  const STOP_EVENTS = [
    'click',
    'dblclick',
    'mousedown',
    'mouseup',
    'pointerdown',
    'pointerup',
    'touchstart',
    'touchend'
  ];

  function stopEvent(e) {
    e.stopPropagation();
  }

  function checkVideoNavigation() {
    if (window.location.href !== lastVideoUrl) {
      lastVideoUrl = window.location.href;
      sessionDetectedLang = '';
      lastScriptGroup = '';
      consecutivePreloadFailures = 0;
    }
  }

  function getEffectiveWordSourceLang() {
    if (settings.sourceLang && settings.sourceLang !== 'auto') {
      return settings.sourceLang;
    }
    return sessionDetectedLang || 'auto';
  }

  function scheduleSubtitlePreload(sentence, words, immediate) {
    if (!settings.enabled || settings.preloadSubtitles === false) return;
    if (!sentence && (!words || words.length === 0)) return;
    if (document.hidden && !immediate) return;
    if (Date.now() < preloadPausedUntil) return;

    if (preloadTimer) {
      clearTimeout(preloadTimer);
      preloadTimer = null;
    }

    const gen = ++preloadGeneration;
    const elapsedSinceLast = Date.now() - lastPreloadSentAt;
    const paceWait = immediate ? 0 : Math.max(0, PRELOAD_MIN_INTERVAL_MS - elapsedSinceLast);
    const delay = immediate ? 0 : Math.max(PRELOAD_DEBOUNCE_MS, paceWait);

    preloadTimer = setTimeout(() => {
      preloadTimer = null;
      if (gen !== preloadGeneration) return;
      if (!settings.enabled || settings.preloadSubtitles === false) return;
      if (document.hidden && !immediate) return;
      runSubtitleBatchPreload(sentence, words, gen);
    }, delay);
  }

  async function runSubtitleBatchPreload(sentence, words, gen) {
    const cleanSentence = String(sentence || '').trim();
    const targetLang = settings.targetLang || 'en';
    const configuredSource = settings.sourceLang || 'auto';
    const uniqueWords = Array.from(new Set((words || []).map((w) => String(w || '').trim()).filter(Boolean)));

    if (!cleanSentence && uniqueWords.length === 0) return;

    // Detect mid-video script switch (e.g. English -> Japanese) when in auto mode
    const scriptGroup = detectScriptGroup(cleanSentence || uniqueWords.join(' '));
    if (configuredSource === 'auto' && lastScriptGroup && scriptGroup && scriptGroup !== lastScriptGroup) {
      sessionDetectedLang = '';
    }
    if (scriptGroup) {
      lastScriptGroup = scriptGroup;
    }

    let effectiveLang = configuredSource !== 'auto' ? configuredSource : sessionDetectedLang;

    try {
      // Phase 1 (first subtitle of a video in auto mode): detect language from the full sentence once
      if (!effectiveLang || effectiveLang === 'auto') {
        if (!cleanSentence) return;
        lastPreloadSentAt = Date.now();
        const sentRes = await fetchSingleSmart(cleanSentence, 'auto', targetLang, false);
        if (gen !== preloadGeneration) return;
        if (sentRes && sentRes.detectedLang) {
          sessionDetectedLang = sentRes.detectedLang;
          effectiveLang = sentRes.detectedLang;
          // Also store sentence under detected language for direct lookups
          cacheSingleResult(cleanSentence, effectiveLang, targetLang, false, sentRes);
        }
        if (!effectiveLang || effectiveLang === 'auto') {
          return;
        }
      }

      // Skip batching if source language equals target language (nothing to translate)
      if (effectiveLang.toLowerCase() === targetLang.toLowerCase()) {
        return;
      }

      // Phase 2: Batch sentence + all uncached words of this subtitle in ONE ~41ms HTTP request!
      const batchEntries = [];
      if (
        settings.showSentenceTranslation !== false &&
        cleanSentence &&
        !getCachedSingleResult(cleanSentence, effectiveLang, targetLang, false) &&
        !getCachedSingleResult(cleanSentence, 'auto', targetLang, false)
      ) {
        batchEntries.push({ text: cleanSentence, isWord: false });
      }

      for (const word of uniqueWords) {
        if (!getCachedSingleResult(word, effectiveLang, targetLang, true)) {
          batchEntries.push({ text: word, isWord: true });
        }
      }

      if (batchEntries.length === 0) {
        return;
      }

      lastPreloadSentAt = Date.now();
      await fetchBatchSmart(batchEntries, effectiveLang, targetLang);
      consecutivePreloadFailures = 0;
    } catch (err) {
      consecutivePreloadFailures++;
      if ((err && err.isRateLimit) || consecutivePreloadFailures >= 3) {
        preloadPausedUntil = Date.now() + PRELOAD_BACKOFF_MS;
        consecutivePreloadFailures = 0;
      }
    }
  }

  function prefetchSentence(sentence) {
    const clean = String(sentence || '').trim();
    if (!clean || !settings.enabled) return;
    const sl = getEffectiveWordSourceLang();
    const tl = settings.targetLang || 'en';
    if (
      getCachedSingleResult(clean, sl, tl, false) ||
      getCachedSingleResult(clean, 'auto', tl, false)
    ) {
      return;
    }

    fetchSingleSmart(clean, settings.sourceLang || 'auto', tl, false)
      .then((res) => {
        if (res && res.detectedLang && (!settings.sourceLang || settings.sourceLang === 'auto')) {
          sessionDetectedLang = res.detectedLang;
        }
      })
      .catch(() => {});
  }

  function prefetchWord(word) {
    const clean = String(word || '').trim();
    if (!clean || !settings.enabled) return;
    const sl = getEffectiveWordSourceLang();
    const tl = settings.targetLang || 'en';
    if (getCachedSingleResult(clean, sl, tl, true)) return;

    fetchSingleSmart(clean, sl, tl, true).catch(() => {});
  }

  function ensureOverlayElements() {
    if (rootEl) return;

    rootEl = document.createElement('div');
    rootEl.id = 'subclick-root';
    rootEl.className = 'subclick-root';
    rootEl.dataset.size = settings.subtitleSize || 'medium';

    subtitleWrapEl = document.createElement('div');
    subtitleWrapEl.className = 'subclick-subtitle-wrap';

    subtitleBoxEl = document.createElement('div');
    subtitleBoxEl.className = 'subclick-subtitle-box';

    tooltipEl = document.createElement('div');
    tooltipEl.className = 'subclick-tooltip';
    tooltipEl.hidden = true;

    for (const evtName of STOP_EVENTS) {
      subtitleBoxEl.addEventListener(evtName, stopEvent, false);
      tooltipEl.addEventListener(evtName, stopEvent, false);
    }

    subtitleBoxEl.addEventListener('click', onSubtitleBoxClick, false);

    // Hovering subtitle box immediately triggers preload if not yet finished
    subtitleBoxEl.addEventListener(
      'pointerenter',
      () => {
        if (currentSentenceText) {
          if (settings.preloadSubtitles !== false && Date.now() >= preloadPausedUntil) {
            scheduleSubtitlePreload(currentSentenceText, currentSubtitleWords, true);
          } else {
            prefetchSentence(currentSentenceText);
          }
        }
      },
      false
    );

    subtitleBoxEl.addEventListener(
      'pointerover',
      (e) => {
        const wordSpan = e.target && e.target.closest ? e.target.closest('.subclick-word') : null;
        if (hoverPrefetchTimer) {
          clearTimeout(hoverPrefetchTimer);
          hoverPrefetchTimer = null;
        }
        if (!wordSpan) return;
        const word = (wordSpan.dataset.word || wordSpan.textContent || '').trim();
        if (!word) return;

        hoverPrefetchTimer = setTimeout(() => {
          hoverPrefetchTimer = null;
          prefetchWord(word);
        }, 40);
      },
      false
    );

    subtitleBoxEl.addEventListener(
      'pointerleave',
      () => {
        if (hoverPrefetchTimer) {
          clearTimeout(hoverPrefetchTimer);
          hoverPrefetchTimer = null;
        }
      },
      false
    );

    subtitleBoxEl.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        const wordSpan = e.target && e.target.closest ? e.target.closest('.subclick-word') : null;
        if (wordSpan) {
          e.preventDefault();
          e.stopPropagation();
          handleWordActivated(wordSpan);
        }
      }
    });

    subtitleWrapEl.appendChild(subtitleBoxEl);
    rootEl.appendChild(subtitleWrapEl);
    rootEl.appendChild(tooltipEl);
  }

  function restoreNativeContainer() {
    if (currentNativeContainer) {
      currentNativeContainer.classList.remove('subclick-native-hidden');
    }
    const staleHidden = document.querySelectorAll('.subclick-native-hidden');
    for (let i = 0; i < staleHidden.length; i++) {
      staleHidden[i].classList.remove('subclick-native-hidden');
    }
  }

  function mountRootIntoPlayer(player) {
    ensureOverlayElements();
    if (!player) {
      if (rootEl.parentElement) {
        rootEl.remove();
      }
      currentPlayer = null;
      return;
    }

    if (currentPlayer !== player || rootEl.parentElement !== player) {
      currentPlayer = player;
      const computedPos = window.getComputedStyle(player).position;
      if (computedPos === 'static') {
        player.style.position = 'relative';
      }
      player.appendChild(rootEl);
    }

    attachVideoListener(player);
  }

  function attachVideoListener(player) {
    const video = Platforms.getActiveVideo(player, document);
    if (video === watchedVideoEl) return;

    if (watchedVideoEl) {
      watchedVideoEl.removeEventListener('play', onNativeVideoPlay);
    }
    watchedVideoEl = video;
    if (watchedVideoEl) {
      watchedVideoEl.addEventListener('play', onNativeVideoPlay);
    }
  }

  function onNativeVideoPlay() {
    if (isTooltipOpen) {
      pausedByExtension = false;
      closeTooltip({ shouldResume: false });
      scheduleSync();
    }
  }

  function renderSubtitleText(text) {
    ensureOverlayElements();
    subtitleBoxEl.textContent = '';

    if (!text) {
      lastRenderedText = '';
      currentSentenceText = '';
      currentSubtitleWords = [];
      return;
    }

    const wordsInCue = [];
    const tokenizedLines = Tokenizer.tokenizeSubtitle(text, settings.sourceLang);
    for (const tokens of tokenizedLines) {
      const lineEl = document.createElement('span');
      lineEl.className = 'subclick-line';

      for (const tok of tokens) {
        if (tok.isWord) {
          const wordEl = document.createElement('span');
          wordEl.className = 'subclick-word';
          wordEl.dataset.word = tok.text;
          wordEl.tabIndex = 0;
          wordEl.textContent = tok.text;
          lineEl.appendChild(wordEl);
          wordsInCue.push(tok.text);
        } else {
          lineEl.appendChild(document.createTextNode(tok.text));
        }
      }

      subtitleBoxEl.appendChild(lineEl);
    }

    lastRenderedText = text;
    currentSentenceText = text.replace(/\s*\n\s*/g, ' ').trim();
    currentSubtitleWords = wordsInCue;

    // Immediately schedule whole-subtitle batch preload so clicking ANY word is 0ms instant!
    if (settings.preloadSubtitles !== false) {
      scheduleSubtitlePreload(currentSentenceText, currentSubtitleWords, false);
    }
  }

  function syncSubtitles() {
    syncScheduled = false;
    checkVideoNavigation();

    if (!settings.enabled) {
      if (isTooltipOpen) {
        closeTooltip({ shouldResume: false });
      }
      restoreNativeContainer();
      if (subtitleBoxEl) {
        subtitleBoxEl.textContent = '';
        lastRenderedText = '';
        currentSentenceText = '';
        currentSubtitleWords = [];
      }
      return;
    }

    const state = Platforms.extractSubtitleState(platform, document);

    if (state.container !== currentNativeContainer) {
      if (currentNativeContainer) {
        currentNativeContainer.classList.remove('subclick-native-hidden');
      }
      currentNativeContainer = state.container;
    }

    mountRootIntoPlayer(state.player);

    if (!state.player) {
      restoreNativeContainer();
      return;
    }

    if (isTooltipOpen) {
      if (currentNativeContainer && !state.hasImageSubtitles) {
        currentNativeContainer.classList.add('subclick-native-hidden');
      }
      return;
    }

    if (state.hasImageSubtitles && !state.text) {
      restoreNativeContainer();
      if (lastRenderedText !== '') {
        renderSubtitleText('');
      }
      return;
    }

    if (state.text) {
      if (currentNativeContainer) {
        currentNativeContainer.classList.add('subclick-native-hidden');
      }
      if (state.text !== lastRenderedText) {
        renderSubtitleText(state.text);
      }
    } else {
      if (currentNativeContainer) {
        currentNativeContainer.classList.remove('subclick-native-hidden');
      }
      if (lastRenderedText !== '') {
        renderSubtitleText('');
      }
    }
  }

  function scheduleSync() {
    if (syncScheduled) return;
    syncScheduled = true;
    requestAnimationFrame(syncSubtitles);
  }

  function onSubtitleBoxClick(e) {
    const wordSpan = e.target && e.target.closest ? e.target.closest('.subclick-word') : null;
    if (!wordSpan) return;
    e.preventDefault();
    e.stopPropagation();
    handleWordActivated(wordSpan);
  }

  function buildVocabEntry(viewModel) {
    const sourceCode = viewModel.detectedLang || settings.sourceLang || 'auto';
    const targetCode = viewModel.targetLang || settings.targetLang || 'en';
    const vocabId = Constants.makeVocabId(viewModel.word, sourceCode, targetCode);
    return {
      id: vocabId,
      word: viewModel.word,
      translation: viewModel.wordTranslation,
      romanization: viewModel.romanization || '',
      dictionary: viewModel.dictionary || [],
      sourceLang: sourceCode,
      targetLang: targetCode,
      sentence: viewModel.sentence || viewModel.word,
      sentenceTranslation: viewModel.sentenceTranslation || '',
      platform: platform === 'youtube' ? 'YouTube' : 'Netflix',
      videoTitle: Platforms.getVideoTitle(platform, document),
      savedAt: new Date().toISOString()
    };
  }

  function handleWordActivated(wordSpan, isRetry) {
    const word = (wordSpan.dataset.word || wordSpan.textContent || '').trim();
    if (!word) return;

    if (!isRetry && isTooltipOpen && activeWordSpan === wordSpan) {
      closeTooltip({ shouldResume: true });
      return;
    }

    if (activeWordSpan) {
      activeWordSpan.classList.remove('subclick-word--active');
    }
    activeWordSpan = wordSpan;
    activeWordSpan.classList.add('subclick-word--active');

    if (!isTooltipOpen && settings.autoPause && Platforms.isVideoPlaying(currentPlayer, document)) {
      pausedByExtension = true;
      Platforms.pauseVideo(platform, currentPlayer, document);
    }

    isTooltipOpen = true;
    currentVocabEntry = null;
    isCurrentWordSaved = false;

    const reqId = ++activeRequestId;
    const sentence = currentSentenceText || word;
    const targetLang = settings.targetLang || 'en';
    const sentenceSourceLang = settings.sourceLang || 'auto';
    const wordSourceLang = getEffectiveWordSourceLang();
    const hasDistinctSentence =
      Boolean(sentence) && sentence.trim().toLowerCase() !== word.trim().toLowerCase();
    const showSentence = settings.showSentenceTranslation !== false && hasDistinctSentence;
    const shouldFetchSentence =
      showSentence || (sentenceSourceLang === 'auto' && hasDistinctSentence);

    // Check synchronous cache first (preloaded batch / persistent disk cache / hover prefetch) -> 0ms!
    const cachedWord =
      getCachedSingleResult(word, wordSourceLang, targetLang, true) ||
      (wordSourceLang !== 'auto' ? getCachedSingleResult(word, 'auto', targetLang, true) : null);

    const cachedSentence = shouldFetchSentence
      ? getCachedSingleResult(sentence, wordSourceLang, targetLang, false) ||
        getCachedSingleResult(sentence, sentenceSourceLang, targetLang, false)
      : null;

    const viewModel = {
      word,
      wordTranslation: cachedWord ? cachedWord.translation : '',
      romanization: cachedWord ? cachedWord.romanization : '',
      dictionary: cachedWord ? cachedWord.dictionary : [],
      sentence: showSentence ? sentence : '',
      sentenceTranslation: cachedSentence ? cachedSentence.translation : '',
      sentencePending: showSentence && !cachedSentence,
      detectedLang:
        (cachedSentence && cachedSentence.detectedLang) ||
        (cachedWord && cachedWord.detectedLang) ||
        (wordSourceLang !== 'auto' ? wordSourceLang : ''),
      targetLang
    };

    const syncVocabStateAndRender = (autoPersist) => {
      if (reqId !== activeRequestId || !isTooltipOpen) return;
      currentVocabEntry = buildVocabEntry(viewModel);
      if (settings.autoSaveWords) {
        isCurrentWordSaved = true;
        savedVocabIds.add(currentVocabEntry.id);
        if (autoPersist) {
          saveVocabEntry(currentVocabEntry);
        }
      } else {
        isCurrentWordSaved = savedVocabIds.has(currentVocabEntry.id);
      }
      renderTooltipResult(viewModel, wordSpan);
    };

    if (cachedWord) {
      // 0ms INSTANT render with zero loading spinner!
      syncVocabStateAndRender(true);

      // Silently enrich batch-preloaded words with POS dictionary & romanization in the background
      if (!cachedWord.enriched) {
        const enrichLang = viewModel.detectedLang || wordSourceLang || 'auto';
        fetchSingleSmart(word, enrichLang, targetLang, true, { requireEnriched: true })
          .then((enrichedRes) => {
            if (reqId !== activeRequestId || !isTooltipOpen) return;
            if (!enrichedRes || !enrichedRes.translation) return;

            const changed =
              enrichedRes.translation !== viewModel.wordTranslation ||
              enrichedRes.romanization !== viewModel.romanization ||
              (enrichedRes.dictionary && enrichedRes.dictionary.length > 0);

            if (changed) {
              viewModel.wordTranslation = enrichedRes.translation;
              viewModel.romanization = enrichedRes.romanization || '';
              viewModel.dictionary = enrichedRes.dictionary || [];
              if (enrichedRes.detectedLang) {
                viewModel.detectedLang = enrichedRes.detectedLang;
              }
              syncVocabStateAndRender(true);
            }
          })
          .catch(() => {
            // Keep instant translation if enrichment fails
          });
      }

      // Self-heal mid-video caption track switch if preloaded translation equals source word
      if (
        sentenceSourceLang === 'auto' &&
        hasDistinctSentence &&
        cachedWord.translation.toLowerCase() === word.toLowerCase()
      ) {
        fetchSingleSmart(sentence, 'auto', targetLang, false)
          .then(async (probe) => {
            if (reqId !== activeRequestId || !isTooltipOpen) return;
            const actualLang = probe && probe.detectedLang ? probe.detectedLang.toLowerCase() : '';
            if (actualLang && actualLang !== 'auto' && actualLang !== String(wordSourceLang).toLowerCase()) {
              sessionDetectedLang = actualLang;
              const corrected = await fetchSingleSmart(word, actualLang, targetLang, true);
              if (reqId !== activeRequestId || !isTooltipOpen) return;
              viewModel.wordTranslation = corrected.translation;
              viewModel.romanization = corrected.romanization || '';
              viewModel.dictionary = corrected.dictionary || [];
              viewModel.detectedLang = actualLang;
              if (showSentence && probe.translation) {
                viewModel.sentenceTranslation = probe.translation;
                viewModel.sentencePending = false;
              }
              syncVocabStateAndRender(true);
            }
          })
          .catch(() => {});
      }
    } else {
      showTooltipLoading(word, wordSpan);
    }

    // Launch uncached word & sentence requests in PARALLEL (never sequential waterfall!)
    const wordPromise = cachedWord
      ? Promise.resolve(cachedWord)
      : fetchSingleSmart(word, wordSourceLang, targetLang, true);

    const sentencePromise = !shouldFetchSentence
      ? Promise.resolve(null)
      : cachedSentence
        ? Promise.resolve(cachedSentence)
        : fetchSingleSmart(sentence, sentenceSourceLang, targetLang, false).catch(() => null);

    let initialWordRes = cachedWord || null;

    if (!cachedWord) {
      wordPromise
        .then((wRes) => {
          if (reqId !== activeRequestId || !isTooltipOpen) return;
          initialWordRes = wRes;
          viewModel.wordTranslation = wRes.translation;
          viewModel.romanization = wRes.romanization || '';
          viewModel.dictionary = wRes.dictionary || [];
          if (!viewModel.detectedLang && wRes.detectedLang) {
            viewModel.detectedLang = wRes.detectedLang;
          }
          syncVocabStateAndRender(true);
        })
        .catch((err) => {
          if (reqId !== activeRequestId || !isTooltipOpen) return;
          const reason =
            err && err.message ? err.message : 'Unable to reach translation service';
          renderTooltipError(word, reason, wordSpan);
        });
    }

    if (shouldFetchSentence && !cachedSentence) {
      sentencePromise.then(async (sRes) => {
        if (reqId !== activeRequestId || !isTooltipOpen) return;
        viewModel.sentencePending = false;

        if (sRes) {
          if (sRes.detectedLang && (!settings.sourceLang || settings.sourceLang === 'auto')) {
            sessionDetectedLang = sRes.detectedLang;
          }
          if (showSentence && sRes.translation) {
            viewModel.sentenceTranslation = sRes.translation;
          }
          if (sRes.detectedLang) {
            viewModel.detectedLang = sRes.detectedLang;
          }
        }

        if (!initialWordRes) {
          try {
            initialWordRes = await wordPromise;
          } catch (_) {
            return;
          }
        }
        if (reqId !== activeRequestId || !isTooltipOpen) return;

        const sentLang =
          sRes && sRes.detectedLang ? String(sRes.detectedLang).trim().toLowerCase() : '';
        const wordLang =
          initialWordRes && initialWordRes.detectedLang
            ? String(initialWordRes.detectedLang).trim().toLowerCase()
            : '';

        if (
          sentenceSourceLang === 'auto' &&
          wordSourceLang === 'auto' &&
          sentLang &&
          sentLang !== 'auto' &&
          wordLang !== sentLang
        ) {
          syncVocabStateAndRender(false);
          try {
            const refined = await fetchSingleSmart(word, sentLang, targetLang, true);
            if (reqId !== activeRequestId || !isTooltipOpen) return;
            viewModel.wordTranslation = refined.translation;
            viewModel.romanization = refined.romanization || '';
            viewModel.dictionary = refined.dictionary || [];
            viewModel.detectedLang = sentLang;
            syncVocabStateAndRender(true);
            return;
          } catch (_) {
            // Keep initial word translation
          }
        }

        syncVocabStateAndRender(Boolean(showSentence && viewModel.sentenceTranslation));
      });
    }
  }

  function positionTooltipNearWord(wordSpan) {
    if (!tooltipEl || !rootEl || !wordSpan) return;

    const rootRect = rootEl.getBoundingClientRect();
    const wordRect = wordSpan.getBoundingClientRect();
    if (rootRect.width === 0 || rootRect.height === 0) return;

    tooltipEl.style.left = '0px';
    tooltipEl.style.top = 'auto';
    tooltipEl.style.bottom = '0px';

    const tipRect = tooltipEl.getBoundingClientRect();
    const margin = 14;

    const wordCenterX = wordRect.left - rootRect.left + wordRect.width / 2;
    let left = wordCenterX - tipRect.width / 2;
    left = Math.max(margin, Math.min(left, rootRect.width - tipRect.width - margin));

    const spaceAbove = wordRect.top - rootRect.top;
    if (spaceAbove >= tipRect.height + 20) {
      const bottomOffset = rootRect.bottom - wordRect.top + 10;
      tooltipEl.style.bottom = `${Math.round(bottomOffset)}px`;
      tooltipEl.style.top = 'auto';
    } else {
      const topOffset = Math.min(
        rootRect.height - tipRect.height - margin,
        Math.max(margin, wordRect.bottom - rootRect.top + 10)
      );
      tooltipEl.style.top = `${Math.round(topOffset)}px`;
      tooltipEl.style.bottom = 'auto';
    }

    tooltipEl.style.left = `${Math.round(left)}px`;
  }

  function buildTooltipHeader(word, langPairText, romanization, showSaveButton) {
    const header = document.createElement('div');
    header.className = 'subclick-tip-header';

    const wordGroup = document.createElement('div');
    wordGroup.className = 'subclick-tip-word-group';

    const sourceRow = document.createElement('div');
    sourceRow.className = 'subclick-tip-source-row';

    const wordTitle = document.createElement('span');
    wordTitle.className = 'subclick-tip-word';
    wordTitle.textContent = word;
    sourceRow.appendChild(wordTitle);

    if (langPairText) {
      const badge = document.createElement('span');
      badge.className = 'subclick-tip-lang-badge';
      badge.textContent = langPairText;
      sourceRow.appendChild(badge);
    }

    wordGroup.appendChild(sourceRow);

    if (romanization) {
      const romanEl = document.createElement('div');
      romanEl.className = 'subclick-tip-roman';
      romanEl.textContent = romanization;
      wordGroup.appendChild(romanEl);
    }

    const actions = document.createElement('div');
    actions.className = 'subclick-tip-actions';

    if (showSaveButton) {
      const saveBtn = document.createElement('button');
      saveBtn.type = 'button';
      saveBtn.className = 'subclick-btn-save' + (isCurrentWordSaved ? ' is-saved' : '');
      saveBtn.textContent = isCurrentWordSaved ? '★ Saved' : '☆ Save';
      saveBtn.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        if (!currentVocabEntry) return;
        if (isCurrentWordSaved) {
          isCurrentWordSaved = false;
          savedVocabIds.delete(currentVocabEntry.id);
          removeVocabEntry(currentVocabEntry.id);
        } else {
          isCurrentWordSaved = true;
          savedVocabIds.add(currentVocabEntry.id);
          saveVocabEntry(currentVocabEntry);
        }
        saveBtn.classList.toggle('is-saved', isCurrentWordSaved);
        saveBtn.textContent = isCurrentWordSaved ? '★ Saved' : '☆ Save';
      });
      actions.appendChild(saveBtn);
    }

    const closeBtn = document.createElement('button');
    closeBtn.type = 'button';
    closeBtn.className = 'subclick-btn-close';
    closeBtn.title = 'Close (Esc)';
    closeBtn.setAttribute('aria-label', 'Close translation');
    closeBtn.textContent = '×';
    closeBtn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      closeTooltip({ shouldResume: true });
    });
    actions.appendChild(closeBtn);

    header.appendChild(wordGroup);
    header.appendChild(actions);
    return header;
  }

  function showTooltipLoading(word, wordSpan) {
    ensureOverlayElements();
    tooltipEl.textContent = '';
    tooltipEl.hidden = false;

    const targetUpper = String(settings.targetLang || 'en').toUpperCase();
    tooltipEl.appendChild(buildTooltipHeader(word, `→ ${targetUpper}`, '', false));

    const loading = document.createElement('div');
    loading.className = 'subclick-tip-loading';
    const spinner = document.createElement('span');
    spinner.className = 'subclick-spinner';
    const label = document.createElement('span');
    label.textContent = 'Translating…';
    loading.appendChild(spinner);
    loading.appendChild(label);

    tooltipEl.appendChild(loading);
    positionTooltipNearWord(wordSpan);
  }

  function renderTooltipError(word, errorMsg, wordSpan) {
    if (!tooltipEl) return;
    tooltipEl.textContent = '';
    tooltipEl.hidden = false;

    tooltipEl.appendChild(buildTooltipHeader(word, '', '', false));

    const errBox = document.createElement('div');
    errBox.className = 'subclick-tip-error';

    const msgSpan = document.createElement('span');
    msgSpan.textContent = errorMsg;
    errBox.appendChild(msgSpan);

    const retryBtn = document.createElement('button');
    retryBtn.type = 'button';
    retryBtn.className = 'subclick-btn-retry';
    retryBtn.textContent = 'Retry';
    retryBtn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (wordSpan) {
        handleWordActivated(wordSpan, true);
      }
    });
    errBox.appendChild(retryBtn);

    tooltipEl.appendChild(errBox);

    appendTooltipFooter();
    positionTooltipNearWord(wordSpan);
  }

  function renderTooltipResult(data, wordSpan) {
    if (!tooltipEl) return;
    tooltipEl.textContent = '';
    tooltipEl.hidden = false;

    const src = (data.detectedLang || settings.sourceLang || 'auto').toUpperCase();
    const tgt = (data.targetLang || settings.targetLang || 'en').toUpperCase();
    const langPair = src && src !== 'AUTO' ? `${src} → ${tgt}` : `→ ${tgt}`;

    tooltipEl.appendChild(
      buildTooltipHeader(data.word, langPair, data.romanization, true)
    );

    const mainTrans = document.createElement('div');
    mainTrans.className = 'subclick-tip-main-trans';
    mainTrans.textContent = data.wordTranslation || '—';
    tooltipEl.appendChild(mainTrans);

    if (Array.isArray(data.dictionary) && data.dictionary.length > 0) {
      const dictContainer = document.createElement('div');
      dictContainer.className = 'subclick-tip-dict';

      for (const group of data.dictionary) {
        const row = document.createElement('div');
        row.className = 'subclick-dict-row';

        if (group.pos) {
          const posEl = document.createElement('span');
          posEl.className = 'subclick-dict-pos';
          posEl.textContent = group.pos;
          row.appendChild(posEl);
        }

        const termsEl = document.createElement('span');
        termsEl.className = 'subclick-dict-terms';
        termsEl.textContent = (group.terms || []).join(', ');
        row.appendChild(termsEl);

        dictContainer.appendChild(row);
      }
      tooltipEl.appendChild(dictContainer);
    }

    if (
      settings.showSentenceTranslation !== false &&
      data.sentence &&
      data.sentence.trim().toLowerCase() !== data.word.trim().toLowerCase() &&
      (data.sentenceTranslation || data.sentencePending)
    ) {
      const sentBox = document.createElement('div');
      sentBox.className = 'subclick-tip-sentence-box';

      const sentOrig = document.createElement('div');
      sentOrig.className = 'subclick-tip-sentence-orig';
      sentOrig.textContent = data.sentence;
      sentBox.appendChild(sentOrig);

      if (data.sentenceTranslation) {
        const sentTrans = document.createElement('div');
        sentTrans.className = 'subclick-tip-sentence-trans';
        sentTrans.textContent = data.sentenceTranslation;
        sentBox.appendChild(sentTrans);
      } else {
        const pendingEl = document.createElement('div');
        pendingEl.className = 'subclick-tip-sentence-pending';
        pendingEl.textContent = 'Translating sentence…';
        sentBox.appendChild(pendingEl);
      }

      tooltipEl.appendChild(sentBox);
    }

    appendTooltipFooter();
    positionTooltipNearWord(wordSpan);
  }

  function appendTooltipFooter() {
    if (!pausedByExtension) return;

    const footer = document.createElement('div');
    footer.className = 'subclick-tip-footer';

    const status = document.createElement('span');
    status.textContent = 'Video paused';

    const resumeBtn = document.createElement('button');
    resumeBtn.type = 'button';
    resumeBtn.className = 'subclick-btn-resume';
    resumeBtn.textContent = 'Resume ▶';
    resumeBtn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      closeTooltip({ shouldResume: true, forceResume: true });
    });

    footer.appendChild(status);
    footer.appendChild(resumeBtn);
    tooltipEl.appendChild(footer);
  }

  function closeTooltip(options) {
    const opts = options || {};
    isTooltipOpen = false;
    activeRequestId++;

    if (activeWordSpan) {
      activeWordSpan.classList.remove('subclick-word--active');
      activeWordSpan = null;
    }

    if (tooltipEl) {
      tooltipEl.hidden = true;
      tooltipEl.textContent = '';
    }

    const shouldPlay =
      opts.forceResume ||
      (opts.shouldResume && pausedByExtension && settings.autoResume);

    pausedByExtension = false;

    if (shouldPlay) {
      Platforms.playVideo(platform, currentPlayer, document);
    }

    scheduleSync();
  }

  // Vocabulary persistence helpers (non-blocking for UI)
  async function getVocabularyList() {
    const res = await storageGet([Constants.STORAGE_KEYS.VOCABULARY]);
    return res && Array.isArray(res[Constants.STORAGE_KEYS.VOCABULARY])
      ? res[Constants.STORAGE_KEYS.VOCABULARY]
      : [];
  }

  async function saveVocabEntry(entry) {
    const list = await getVocabularyList();
    const filtered = list.filter((item) => item && item.id !== entry.id);
    filtered.unshift(entry);
    const capped = filtered.slice(0, 2000);
    await storageSet({ [Constants.STORAGE_KEYS.VOCABULARY]: capped });
  }

  async function removeVocabEntry(id) {
    const list = await getVocabularyList();
    const filtered = list.filter((item) => item && item.id !== id);
    await storageSet({ [Constants.STORAGE_KEYS.VOCABULARY]: filtered });
  }

  // Global dismissal listeners
  document.addEventListener(
    'keydown',
    (e) => {
      if (e.key === 'Escape' && isTooltipOpen) {
        e.stopPropagation();
        closeTooltip({ shouldResume: true });
      }
    },
    true
  );

  document.addEventListener(
    'pointerdown',
    (e) => {
      if (!isTooltipOpen) return;
      const target = e.target;
      if (tooltipEl && tooltipEl.contains(target)) return;
      if (subtitleBoxEl && subtitleBoxEl.contains(target)) return;

      const wasPausedByExt = pausedByExtension;
      const clickedInteractiveUi =
        target &&
        target.closest &&
        target.closest(
          'button, a, input, [role="button"], [role="slider"], .ytp-chrome-bottom, [data-uia*="control"], [data-uia*="timeline"]'
        );

      closeTooltip({ shouldResume: false });

      if (wasPausedByExt && settings.autoResume && !clickedInteractiveUi) {
        setTimeout(() => {
          if (!isTooltipOpen && !Platforms.isVideoPlaying(currentPlayer, document)) {
            Platforms.playVideo(platform, currentPlayer, document);
          }
        }, 90);
      }
    },
    true
  );

  // Settings, vocabulary ID index, and persistent on-device word cache initialization
  async function loadInitialState() {
    const res = await storageGet([
      Constants.STORAGE_KEYS.SETTINGS,
      Constants.STORAGE_KEYS.VOCABULARY,
      Constants.STORAGE_KEYS.WORD_CACHE
    ]);
    settings = Constants.resolveSettings(res && res[Constants.STORAGE_KEYS.SETTINGS]);
    const vocabList =
      res && Array.isArray(res[Constants.STORAGE_KEYS.VOCABULARY])
        ? res[Constants.STORAGE_KEYS.VOCABULARY]
        : [];
    savedVocabIds = new Set(vocabList.map((item) => item && item.id).filter(Boolean));

    if (Translator && typeof Translator.hydratePersistentCache === 'function') {
      Translator.hydratePersistentCache(res && res[Constants.STORAGE_KEYS.WORD_CACHE]);
    }

    if (rootEl) {
      rootEl.dataset.size = settings.subtitleSize || 'medium';
    }
    scheduleSync();
  }

  const storageEvents =
    (typeof browser !== 'undefined' && browser.storage && browser.storage.onChanged) ||
    (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.onChanged) ||
    null;

  if (storageEvents && typeof storageEvents.addListener === 'function') {
    storageEvents.addListener((changes, areaName) => {
      if (areaName !== 'local') return;
      if (changes[Constants.STORAGE_KEYS.SETTINGS]) {
        const prevSource = settings.sourceLang;
        const prevTarget = settings.targetLang;
        const prevPreload = settings.preloadSubtitles;
        settings = Constants.resolveSettings(changes[Constants.STORAGE_KEYS.SETTINGS].newValue);
        if (rootEl) {
          rootEl.dataset.size = settings.subtitleSize || 'medium';
        }
        if (prevSource !== settings.sourceLang) {
          sessionDetectedLang = '';
          if (lastRenderedText) {
            renderSubtitleText(lastRenderedText);
          }
        } else if (
          (prevTarget !== settings.targetLang || (!prevPreload && settings.preloadSubtitles)) &&
          currentSentenceText
        ) {
          scheduleSubtitlePreload(currentSentenceText, currentSubtitleWords, true);
        }
        scheduleSync();
      }
      if (changes[Constants.STORAGE_KEYS.VOCABULARY]) {
        const list = Array.isArray(changes[Constants.STORAGE_KEYS.VOCABULARY].newValue)
          ? changes[Constants.STORAGE_KEYS.VOCABULARY].newValue
          : [];
        savedVocabIds = new Set(list.map((item) => item && item.id).filter(Boolean));
      }
    });
  }

  const domObserver = new MutationObserver((mutations) => {
    for (let i = 0; i < mutations.length; i++) {
      const target = mutations[i].target;
      if (rootEl && (target === rootEl || rootEl.contains(target))) {
        continue;
      }
      scheduleSync();
      return;
    }
  });

  function preconnectTranslationHosts() {
    if (!document.head) return;
    const hosts = [
      { id: 'subclick-preconnect-c5', href: 'https://clients5.google.com' },
      { id: 'subclick-preconnect-gt', href: 'https://translate.googleapis.com' }
    ];
    for (const h of hosts) {
      if (document.getElementById(h.id)) continue;
      const link = document.createElement('link');
      link.id = h.id;
      link.rel = 'preconnect';
      link.href = h.href;
      link.crossOrigin = 'anonymous';
      document.head.appendChild(link);
    }
  }

  function startObserving() {
    preconnectTranslationHosts();
    loadInitialState();
    if (document.documentElement) {
      domObserver.observe(document.documentElement, {
        childList: true,
        subtree: true,
        characterData: true
      });
    }

    document.addEventListener('fullscreenchange', scheduleSync);
    window.addEventListener('yt-navigate-finish', scheduleSync);
    window.addEventListener('popstate', scheduleSync);
    window.addEventListener('resize', () => {
      if (isTooltipOpen && activeWordSpan) {
        positionTooltipNearWord(activeWordSpan);
      }
    });

    setInterval(scheduleSync, 500);
  }

  startObserving();
})();
