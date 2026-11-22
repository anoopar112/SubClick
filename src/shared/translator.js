(function (root) {
  'use strict';

  const MAX_CACHE_ENTRIES = 5000;
  const DEFAULT_TIMEOUT_MS = 3500;
  const PROVIDER_COOLDOWN_MS = 60 * 1000;
  const MAX_BATCH_ITEMS = 30;
  const MAX_BATCH_URL_CHARS = 1500;

  const translationCache = new Map();
  const inflightRequests = new Map();
  const providerCooldownUntil = new Map();

  function normalizeLangCode(lang) {
    if (!lang) return '';
    return String(lang).trim().toLowerCase();
  }

  function makeCacheKey(text, sourceLang, targetLang, includeDictionary) {
    const clean = String(text || '').trim();
    const sl = normalizeLangCode(sourceLang) || 'auto';
    const tl = normalizeLangCode(targetLang) || 'en';
    return `${includeDictionary ? 'd' : 's'}|${sl}|${tl}|${clean}`;
  }

  function cacheGet(key) {
    if (!translationCache.has(key)) return undefined;
    const val = translationCache.get(key);
    translationCache.delete(key);
    translationCache.set(key, val);
    return val;
  }

  function cacheSet(key, value) {
    const existing = translationCache.get(key);
    // Never downgrade an already-enriched dictionary entry to an unenriched batch entry
    if (existing && existing.enriched && value && !value.enriched) {
      return;
    }
    if (translationCache.has(key)) {
      translationCache.delete(key);
    } else if (translationCache.size >= MAX_CACHE_ENTRIES) {
      const oldestKey = translationCache.keys().next().value;
      translationCache.delete(oldestKey);
    }
    translationCache.set(key, value);
  }

  function getCachedSingle(text, sourceLang, targetLang, includeDictionary) {
    const clean = String(text || '').trim();
    if (!clean) return undefined;

    const sl = normalizeLangCode(sourceLang) || 'auto';
    const key = makeCacheKey(clean, sl, targetLang, includeDictionary);
    const exact = cacheGet(key);
    if (exact) return exact;

    // For non-German single words, allow case-insensitive cache reuse (e.g. "Hola" <-> "hola")
    if (includeDictionary && sl !== 'de') {
      const lower = clean.toLowerCase();
      if (lower !== clean) {
        const lowerKey = makeCacheKey(lower, sl, targetLang, includeDictionary);
        const lowerHit = cacheGet(lowerKey);
        if (lowerHit) return lowerHit;
      }
    }

    return undefined;
  }

  function putCachedSingle(text, sourceLang, targetLang, includeDictionary, result) {
    if (!result || !result.translation) return;
    const clean = String(text || '').trim();
    if (!clean) return;
    const sl = normalizeLangCode(sourceLang) || 'auto';

    cacheSet(makeCacheKey(clean, sl, targetLang, includeDictionary), result);

    if (sl === 'auto' && result.detectedLang) {
      const detected = normalizeLangCode(result.detectedLang);
      cacheSet(makeCacheKey(clean, detected, targetLang, includeDictionary), result);
      if (includeDictionary && detected !== 'de' && clean.toLowerCase() !== clean) {
        cacheSet(makeCacheKey(clean.toLowerCase(), detected, targetLang, includeDictionary), result);
      }
    } else if (includeDictionary && sl !== 'de' && clean.toLowerCase() !== clean) {
      cacheSet(makeCacheKey(clean.toLowerCase(), sl, targetLang, includeDictionary), result);
    }
  }

  function isProviderCoolingDown(name) {
    const until = providerCooldownUntil.get(name);
    if (!until) return false;
    if (Date.now() >= until) {
      providerCooldownUntil.delete(name);
      return false;
    }
    return true;
  }

  function markProviderFailed(name) {
    providerCooldownUntil.set(name, Date.now() + PROVIDER_COOLDOWN_MS);
  }

  function markProviderHealthy(name) {
    providerCooldownUntil.delete(name);
  }

  async function fetchJsonWithTimeout(url, fetchImpl, timeoutMs) {
    const doFetch = fetchImpl || fetch;
    const ms = typeof timeoutMs === 'number' ? timeoutMs : DEFAULT_TIMEOUT_MS;
    const hasAbort = typeof AbortController === 'function';
    const controller = hasAbort ? new AbortController() : null;
    const timer = controller ? setTimeout(() => controller.abort(), ms) : null;

    try {
      const init = {
        method: 'GET',
        credentials: 'omit'
      };
      if (controller) {
        init.signal = controller.signal;
      }
      const res = await doFetch(url, init);
      if (!res || !res.ok) {
        const status = res ? res.status : 'no-response';
        const err = new Error(`HTTP ${status}`);
        err.status = status;
        if (status === 429) err.isRateLimit = true;
        throw err;
      }
      return await res.json();
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  /**
   * Parses Google Translate `dj=1` JSON payload.
   */
  function parseGoogleDjResponse(data) {
    if (!data || typeof data !== 'object') {
      throw new Error('Invalid Google Translate JSON response');
    }

    const sentences = Array.isArray(data.sentences) ? data.sentences : [];
    let translation = '';
    let romanization = '';

    for (const seg of sentences) {
      if (seg && typeof seg.trans === 'string') {
        translation += seg.trans;
      }
      if (seg && typeof seg.src_translit === 'string' && seg.src_translit.trim()) {
        romanization += (romanization ? ' ' : '') + seg.src_translit.trim();
      }
    }

    const dictionary = [];
    if (Array.isArray(data.dict)) {
      for (const group of data.dict.slice(0, 4)) {
        const pos = typeof group.pos === 'string' ? group.pos : '';
        let terms = [];
        if (Array.isArray(group.terms)) {
          terms = group.terms.filter((t) => typeof t === 'string' && t.trim());
        } else if (Array.isArray(group.entry)) {
          terms = group.entry
            .map((e) => e && e.word)
            .filter((t) => typeof t === 'string' && t.trim());
        }
        const uniqueTerms = Array.from(new Set(terms)).slice(0, 5);
        if (uniqueTerms.length > 0) {
          dictionary.push({ pos, terms: uniqueTerms });
        }
      }
    }

    return {
      translation: translation.trim(),
      romanization: romanization.trim(),
      dictionary,
      detectedLang: typeof data.src === 'string' ? data.src : '',
      enriched: true
    };
  }

  /**
   * Fallback parser if Google returns legacy nested-array payload instead of dj=1 object.
   */
  function parseGoogleArrayResponse(data) {
    if (!Array.isArray(data)) {
      throw new Error('Invalid Google Translate array response');
    }

    let translation = '';
    let romanization = '';

    if (Array.isArray(data[0])) {
      for (const seg of data[0]) {
        if (Array.isArray(seg)) {
          if (typeof seg[0] === 'string') translation += seg[0];
          if (typeof seg[3] === 'string' && seg[3].trim()) {
            romanization += (romanization ? ' ' : '') + seg[3].trim();
          }
        }
      }
    }

    const dictionary = [];
    if (Array.isArray(data[1])) {
      for (const group of data[1].slice(0, 4)) {
        if (Array.isArray(group)) {
          const pos = typeof group[0] === 'string' ? group[0] : '';
          const terms = Array.isArray(group[1])
            ? Array.from(new Set(group[1].filter((t) => typeof t === 'string' && t.trim()))).slice(0, 5)
            : [];
          if (terms.length > 0) {
            dictionary.push({ pos, terms });
          }
        }
      }
    }

    return {
      translation: translation.trim(),
      romanization: romanization.trim(),
      dictionary,
      detectedLang: typeof data[2] === 'string' ? data[2] : '',
      enriched: true
    };
  }

  /**
   * Parses Google `clients5.google.com/translate_a/t?client=dict-chrome-ex` single response.
   */
  function parseGoogleClients5Response(data) {
    if (!Array.isArray(data) || data.length === 0) {
      throw new Error('Invalid Google clients5 response');
    }

    let translation = '';
    let detectedLang = '';

    if (typeof data[0] === 'string') {
      translation = data[0];
    } else if (Array.isArray(data[0])) {
      translation = typeof data[0][0] === 'string' ? data[0][0] : '';
      detectedLang = typeof data[0][1] === 'string' ? data[0][1] : '';
    }

    if (!translation.trim()) {
      throw new Error('Empty Google clients5 translation');
    }

    return {
      translation: translation.trim(),
      romanization: '',
      dictionary: [],
      detectedLang,
      enriched: false
    };
  }

  /**
   * Parses Google `clients5.google.com/translate_a/t` multi-query batch response.
   */
  function parseGoogleClients5BatchResponse(data, expectedLength, fallbackLang) {
    if (!Array.isArray(data) || data.length !== expectedLength) {
      throw new Error('Mismatched Google clients5 batch length');
    }

    return data.map((entry) => {
      if (typeof entry === 'string') {
        return {
          translation: entry.trim(),
          romanization: '',
          dictionary: [],
          detectedLang: fallbackLang || '',
          enriched: false
        };
      }
      if (Array.isArray(entry)) {
        return {
          translation: typeof entry[0] === 'string' ? entry[0].trim() : '',
          romanization: '',
          dictionary: [],
          detectedLang: typeof entry[1] === 'string' ? entry[1] : (fallbackLang || ''),
          enriched: false
        };
      }
      return {
        translation: '',
        romanization: '',
        dictionary: [],
        detectedLang: fallbackLang || '',
        enriched: false
      };
    });
  }

  /**
   * Parses MyMemory free public translation API payload.
   */
  function parseMyMemoryResponse(data) {
    if (!data || typeof data !== 'object') {
      throw new Error('Invalid MyMemory response');
    }

    if (data.quotaFinished === true) {
      throw new Error('MyMemory daily quota reached');
    }

    if (typeof data.responseStatus === 'number' && data.responseStatus !== 200) {
      throw new Error(data.responseDetails || `MyMemory status ${data.responseStatus}`);
    }

    const translated = data.responseData && typeof data.responseData.translatedText === 'string'
      ? data.responseData.translatedText.trim()
      : '';

    if (!translated || /^MYMEMORY WARNING/i.test(translated)) {
      throw new Error(translated || 'Empty MyMemory translation response');
    }

    const detectedLang =
      data.responseData && typeof data.responseData.detectedLanguage === 'string'
        ? data.responseData.detectedLanguage.split('-')[0].toLowerCase()
        : '';

    const dictionary = [];
    if (Array.isArray(data.matches)) {
      const alts = Array.from(
        new Set(
          data.matches
            .map((m) => (m && typeof m.translation === 'string' ? m.translation.trim() : ''))
            .filter((t) => t && t.toLowerCase() !== translated.toLowerCase())
        )
      ).slice(0, 4);
      if (alts.length > 0) {
        dictionary.push({ pos: 'alternatives', terms: alts });
      }
    }

    return {
      translation: translated,
      romanization: '',
      dictionary,
      detectedLang,
      enriched: true
    };
  }

  async function queryGoogleGtx(cleanText, sl, tl, includeDictionary, fetchImpl, timeoutMs) {
    const params = new URLSearchParams({
      client: 'gtx',
      sl,
      tl,
      dj: '1',
      q: cleanText
    });
    const url = includeDictionary
      ? `https://translate.googleapis.com/translate_a/single?${params.toString()}&dt=t&dt=bd&dt=rm`
      : `https://translate.googleapis.com/translate_a/single?${params.toString()}&dt=t`;

    const data = await fetchJsonWithTimeout(url, fetchImpl, timeoutMs);
    const parsed = Array.isArray(data)
      ? parseGoogleArrayResponse(data)
      : parseGoogleDjResponse(data);

    if (!parsed.translation) {
      throw new Error('Empty Google GTX translation');
    }
    return parsed;
  }

  async function queryGoogleClients5(cleanText, sl, tl, _includeDictionary, fetchImpl, timeoutMs) {
    const params = new URLSearchParams({
      client: 'dict-chrome-ex',
      sl,
      tl,
      q: cleanText
    });
    const url = `https://clients5.google.com/translate_a/t?${params.toString()}`;
    const data = await fetchJsonWithTimeout(url, fetchImpl, timeoutMs);
    return parseGoogleClients5Response(data);
  }

  async function queryMyMemory(cleanText, sl, tl, _includeDictionary, fetchImpl, timeoutMs) {
    const mmSource = sl === 'auto' ? 'Autodetect' : sl;
    const params = new URLSearchParams({
      q: cleanText,
      langpair: `${mmSource}|${tl}`
    });
    const url = `https://api.mymemory.translated.net/get?${params.toString()}`;
    const data = await fetchJsonWithTimeout(url, fetchImpl, timeoutMs);
    return parseMyMemoryResponse(data);
  }

  const PROVIDERS = [
    { name: 'google-gtx', query: queryGoogleGtx },
    { name: 'google-clients5', query: queryGoogleClients5 },
    { name: 'mymemory', query: queryMyMemory }
  ];

  async function translateSingle(text, sourceLang, targetLang, includeDictionary, options) {
    const cleanText = String(text || '').trim();
    if (!cleanText) {
      return { translation: '', romanization: '', dictionary: [], detectedLang: '', enriched: true };
    }

    const opts = typeof options === 'function' ? { fetchImpl: options } : (options || {});
    const fetchImpl = opts.fetchImpl;
    const timeoutMs = opts.timeoutMs;
    const requireEnriched = Boolean(opts.requireEnriched);
    const useCooldown = !fetchImpl;

    const sl = normalizeLangCode(sourceLang) || 'auto';
    const tl = normalizeLangCode(targetLang) || 'en';
    const cacheKey = makeCacheKey(cleanText, sl, tl, includeDictionary);

    const cached = getCachedSingle(cleanText, sl, tl, includeDictionary);
    if (cached && (!requireEnriched || cached.enriched)) {
      return cached;
    }

    const inflightKey = requireEnriched ? `enrich|${cacheKey}` : cacheKey;
    if (inflightRequests.has(inflightKey)) {
      return inflightRequests.get(inflightKey);
    }

    const promise = (async () => {
      const orderedProviders = useCooldown
        ? [
            ...PROVIDERS.filter((p) => !isProviderCoolingDown(p.name)),
            ...PROVIDERS.filter((p) => isProviderCoolingDown(p.name))
          ]
        : PROVIDERS;

      const errors = [];
      let sawRateLimit = false;

      for (const provider of orderedProviders) {
        // When enriching an already-translated word, skip clients5 since it lacks dictionary/romanization
        if (requireEnriched && provider.name === 'google-clients5') {
          continue;
        }
        try {
          const parsed = await provider.query(cleanText, sl, tl, includeDictionary, fetchImpl, timeoutMs);
          if (useCooldown) markProviderHealthy(provider.name);
          putCachedSingle(cleanText, sl, tl, includeDictionary, parsed);
          return parsed;
        } catch (err) {
          if (err && err.isRateLimit) sawRateLimit = true;
          if (useCooldown) markProviderFailed(provider.name);
          const msg = err && err.message ? err.message : String(err || 'failed');
          errors.push(`${provider.name}: ${msg}`);
        }
      }

      const finalErr = new Error(`All translation services failed (${errors[0] || 'network error'})`);
      if (sawRateLimit) finalErr.isRateLimit = true;
      throw finalErr;
    })();

    inflightRequests.set(inflightKey, promise);
    try {
      return await promise;
    } finally {
      inflightRequests.delete(inflightKey);
    }
  }

  /**
   * Batch-translates an entire subtitle sentence + all its uncached words in ONE single
   * HTTP request (~41-75ms) when explicit source language is known.
   *
   * `entries` is an array of `{ text, isWord }` objects.
   * Returns `{ items: [{ text, isWord, result }], detectedLang }`.
   */
  async function translateBatch(entries, sourceLang, targetLang, options) {
    const opts = typeof options === 'function' ? { fetchImpl: options } : (options || {});
    const fetchImpl = opts.fetchImpl;
    const timeoutMs = opts.timeoutMs;
    const useCooldown = !fetchImpl;

    const sl = normalizeLangCode(sourceLang) || 'auto';
    const tl = normalizeLangCode(targetLang) || 'en';

    // Deduplicate and enforce safe URL budget
    const seen = new Set();
    const batchEntries = [];
    let estimatedChars = 120;

    for (const raw of entries || []) {
      const text = String((raw && raw.text) || '').trim();
      const isWord = Boolean(raw && raw.isWord);
      if (!text) continue;
      const dedupeKey = `${isWord ? 'w' : 's'}|${text}`;
      if (seen.has(dedupeKey)) continue;

      const cached = getCachedSingle(text, sl, tl, isWord);
      if (cached) continue;

      const addedLen = encodeURIComponent(text).length + 4;
      if (batchEntries.length >= MAX_BATCH_ITEMS || estimatedChars + addedLen > MAX_BATCH_URL_CHARS) {
        break;
      }
      seen.add(dedupeKey);
      estimatedChars += addedLen;
      batchEntries.push({ text, isWord });
    }

    if (batchEntries.length === 0) {
      return { items: [], detectedLang: sl === 'auto' ? '' : sl };
    }

    const batchKey = `batch|${sl}|${tl}|${batchEntries.map((e) => e.text).join('\u0001')}`;
    if (inflightRequests.has(batchKey)) {
      return inflightRequests.get(batchKey);
    }

    const promise = (async () => {
      const texts = batchEntries.map((e) => e.text);
      let parsedList = null;
      let detectedLang = sl === 'auto' ? '' : sl;
      let lastErr = null;

      // Primary ultra-fast batch provider: clients5.google.com (~41ms, exact array alignment)
      if (!useCooldown || !isProviderCoolingDown('google-clients5')) {
        try {
          const params = new URLSearchParams({
            client: 'dict-chrome-ex',
            sl,
            tl
          });
          for (const t of texts) {
            params.append('q', t);
          }
          const url = `https://clients5.google.com/translate_a/t?${params.toString()}`;
          const data = await fetchJsonWithTimeout(url, fetchImpl, timeoutMs);
          parsedList = parseGoogleClients5BatchResponse(data, texts.length, detectedLang);
          if (useCooldown) markProviderHealthy('google-clients5');
        } catch (err) {
          lastErr = err;
          if (useCooldown) markProviderFailed('google-clients5');
        }
      }

      // Fallback batch provider: translate.googleapis.com newline batch (~74ms)
      if (!parsedList && (!useCooldown || !isProviderCoolingDown('google-gtx'))) {
        try {
          // Only safe if none of the inputs contain internal newlines
          const safeTexts = texts.map((t) => t.replace(/\r?\n/g, ' '));
          const params = new URLSearchParams({
            client: 'gtx',
            sl,
            tl,
            dj: '1',
            q: safeTexts.join('\n')
          });
          const url = `https://translate.googleapis.com/translate_a/single?${params.toString()}&dt=t`;
          const data = await fetchJsonWithTimeout(url, fetchImpl, timeoutMs);
          const full = Array.isArray(data)
            ? parseGoogleArrayResponse(data)
            : parseGoogleDjResponse(data);
          const lines = full.translation.split('\n');
          if (lines.length === texts.length) {
            detectedLang = full.detectedLang || detectedLang;
            parsedList = lines.map((line) => ({
              translation: line.trim(),
              romanization: '',
              dictionary: [],
              detectedLang,
              enriched: false
            }));
            if (useCooldown) markProviderHealthy('google-gtx');
          } else {
            throw new Error('Newline batch alignment mismatch');
          }
        } catch (err) {
          lastErr = err;
          if (useCooldown) markProviderFailed('google-gtx');
        }
      }

      if (!parsedList) {
        throw lastErr || new Error('Batch translation failed');
      }

      const items = [];
      for (let i = 0; i < batchEntries.length; i++) {
        const entry = batchEntries[i];
        const result = parsedList[i];
        if (result && result.translation) {
          if (!detectedLang && result.detectedLang) {
            detectedLang = result.detectedLang;
          }
          putCachedSingle(entry.text, sl, tl, entry.isWord, result);
          items.push({ text: entry.text, isWord: entry.isWord, result });
        }
      }

      return { items, detectedLang };
    })();

    inflightRequests.set(batchKey, promise);
    try {
      return await promise;
    } finally {
      inflightRequests.delete(batchKey);
    }
  }

  /**
   * Translates a clicked subtitle word and its full sentence IN PARALLEL for minimum latency.
   */
  async function translateWordAndSentence(payload, fetchImpl) {
    const word = String(payload.word || '').trim();
    const sentence = String(payload.sentence || '').trim();
    const sourceLang = payload.sourceLang || 'auto';
    const targetLang = payload.targetLang || 'en';
    const hasDistinctSentence = Boolean(sentence) && sentence.toLowerCase() !== word.toLowerCase();
    const includeSentence = payload.includeSentence !== false && hasDistinctSentence;

    if (!word) {
      throw new Error('No word provided for translation');
    }

    const shouldFetchSentence = includeSentence || (sourceLang === 'auto' && hasDistinctSentence);
    const wordPromise = translateSingle(word, sourceLang, targetLang, true, fetchImpl);
    const sentencePromise = shouldFetchSentence
      ? translateSingle(sentence, sourceLang, targetLang, false, fetchImpl).catch(() => ({
          translation: '',
          detectedLang: ''
        }))
      : Promise.resolve({ translation: '', detectedLang: '' });

    let [wordRes, sentenceRes] = await Promise.all([wordPromise, sentencePromise]);

    const sentLang = normalizeLangCode(sentenceRes.detectedLang);
    const wordLang = normalizeLangCode(wordRes.detectedLang);
    if (
      sourceLang === 'auto' &&
      sentLang &&
      sentLang !== 'auto' &&
      wordLang !== sentLang
    ) {
      try {
        wordRes = await translateSingle(word, sentLang, targetLang, true, fetchImpl);
      } catch (_) {
        // Keep initial word translation
      }
    }

    return {
      word,
      wordTranslation: wordRes.translation,
      romanization: wordRes.romanization,
      dictionary: wordRes.dictionary,
      sentence: includeSentence ? sentence : '',
      sentenceTranslation: includeSentence ? sentenceRes.translation : '',
      detectedLang:
        sentenceRes.detectedLang ||
        wordRes.detectedLang ||
        (sourceLang === 'auto' ? '' : sourceLang),
      targetLang
    };
  }

  /**
   * Hydrates in-memory word cache from compact persisted entries loaded from storage.local.
   * Format: Array<[cacheKey, translation, detectedLang, romanization, dictionary, enrichedFlag]>
   */
  function hydratePersistentCache(entries) {
    if (!Array.isArray(entries)) return 0;
    let count = 0;
    for (const row of entries) {
      if (!Array.isArray(row) || row.length < 2) continue;
      const key = row[0];
      const translation = row[1];
      if (typeof key !== 'string' || typeof translation !== 'string' || !translation) continue;
      cacheSet(key, {
        translation,
        detectedLang: typeof row[2] === 'string' ? row[2] : '',
        romanization: typeof row[3] === 'string' ? row[3] : '',
        dictionary: Array.isArray(row[4]) ? row[4] : [],
        enriched: Boolean(row[5])
      });
      count++;
    }
    return count;
  }

  /**
   * Exports the most recently used word translations (`d|...`) in a compact array for storage.local.
   */
  function exportPersistentCache(maxEntries) {
    const limit = typeof maxEntries === 'number' ? maxEntries : 3500;
    const wordRows = [];
    for (const [key, val] of translationCache.entries()) {
      if (!key.startsWith('d|') || !val || !val.translation) continue;
      wordRows.push([
        key,
        val.translation,
        val.detectedLang || '',
        val.romanization || '',
        Array.isArray(val.dictionary) ? val.dictionary : [],
        val.enriched ? 1 : 0
      ]);
    }
    // Keep most-recently-used tail
    if (wordRows.length > limit) {
      return wordRows.slice(wordRows.length - limit);
    }
    return wordRows;
  }

  function clearCache() {
    translationCache.clear();
    inflightRequests.clear();
    providerCooldownUntil.clear();
  }

  const api = {
    makeCacheKey,
    getCachedSingle,
    putCachedSingle,
    parseGoogleDjResponse,
    parseGoogleArrayResponse,
    parseGoogleClients5Response,
    parseGoogleClients5BatchResponse,
    parseMyMemoryResponse,
    translateSingle,
    translateBatch,
    translateWordAndSentence,
    hydratePersistentCache,
    exportPersistentCache,
    clearCache
  };

  root.SubClickTranslator = api;
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
})(typeof globalThis !== 'undefined' ? globalThis : window);
