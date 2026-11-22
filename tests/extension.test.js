'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const Constants = require('../src/shared/constants.js');
const Tokenizer = require('../src/content/tokenizer.js');
const Platforms = require('../src/content/platforms.js');
const Background = require('../src/background.js');

// Minimal lightweight DOM mock for testing YouTube & Netflix subtitle extractors
function el(tag, attrs = {}, children = []) {
  const node = {
    nodeType: 1,
    tagName: tag.toUpperCase(),
    className: attrs.className || '',
    id: attrs.id || '',
    dataset: attrs.dataset || {},
    attrs,
    childNodes: [],
    parentElement: null,
    classList: {
      contains(cls) {
        return (node.className || '').split(/\s+/).includes(cls);
      }
    },
    querySelectorAll(selector) {
      const results = [];
      const selectors = selector.split(',').map((s) => s.trim());
      function matchSingle(n, sel) {
        if (n.nodeType !== 1) return false;
        if (sel.startsWith('.')) {
          return n.classList.contains(sel.slice(1));
        }
        if (sel.startsWith('#')) {
          return n.id === sel.slice(1);
        }
        if (sel === '[data-uia="player"]') {
          return n.attrs['data-uia'] === 'player';
        }
        if (sel === '[data-uia="video-title"]') {
          return n.attrs['data-uia'] === 'video-title';
        }
        return n.tagName.toLowerCase() === sel.toLowerCase();
      }
      function visit(curr) {
        for (const child of curr.childNodes) {
          if (child.nodeType === 1) {
            if (selectors.some((s) => matchSingle(child, s))) {
              results.push(child);
            }
            visit(child);
          }
        }
      }
      visit(node);
      return results;
    },
    querySelector(selector) {
      return node.querySelectorAll(selector)[0] || null;
    }
  };

  for (const child of children) {
    const childNode = typeof child === 'string' ? { nodeType: 3, nodeValue: child } : child;
    childNode.parentElement = node;
    node.childNodes.push(childNode);
  }

  Object.defineProperty(node, 'textContent', {
    get() {
      let out = '';
      function read(n) {
        if (n.nodeType === 3) out += n.nodeValue;
        else if (n.childNodes) n.childNodes.forEach(read);
      }
      read(node);
      return out;
    }
  });

  return node;
}

test('manifest.json references existing files and valid configuration', () => {
  const manifestPath = path.join(ROOT, 'manifest.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));

  assert.equal(manifest.manifest_version, 3);
  assert.ok(fs.existsSync(path.join(ROOT, manifest.background.service_worker)));
  assert.ok(fs.existsSync(path.join(ROOT, manifest.action.default_popup)));

  for (const iconRel of Object.values(manifest.icons)) {
    assert.ok(fs.existsSync(path.join(ROOT, iconRel)), `Missing icon: ${iconRel}`);
  }

  for (const cs of manifest.content_scripts) {
    for (const jsFile of cs.js || []) {
      assert.ok(fs.existsSync(path.join(ROOT, jsFile)), `Missing content script: ${jsFile}`);
    }
    for (const cssFile of cs.css || []) {
      assert.ok(fs.existsSync(path.join(ROOT, cssFile)), `Missing stylesheet: ${cssFile}`);
    }
  }
});

test('Tokenizer splits multilingual subtitles into words and punctuation accurately', () => {
  const spanish = Tokenizer.tokenizeLine('¿Dónde está el baño, señor?', 'es');
  const spWords = spanish.filter((t) => t.isWord).map((t) => t.text);
  assert.deepEqual(spWords, ['Dónde', 'está', 'el', 'baño', 'señor']);
  assert.equal(spanish.map((t) => t.text).join(''), '¿Dónde está el baño, señor?');

  const english = Tokenizer.tokenizeLine("Don't wait 42 seconds — run!", 'en');
  const enWords = english.filter((t) => t.isWord).map((t) => t.text);
  assert.deepEqual(enWords, ["Don't", 'wait', 'seconds', 'run']);

  const japanese = Tokenizer.tokenizeLine('今日はいい天気ですね。', 'ja');
  const jaWords = japanese.filter((t) => t.isWord).map((t) => t.text);
  assert.ok(jaWords.length >= 4, `Expected segmented Japanese words, got: ${jaWords.join('|')}`);
  assert.ok(!jaWords.includes('。'));
});

test('Platforms detects YouTube and Netflix hostnames accurately', () => {
  assert.equal(Platforms.detectPlatform('www.youtube.com'), 'youtube');
  assert.equal(Platforms.detectPlatform('m.youtube.com'), 'youtube');
  assert.equal(Platforms.detectPlatform('www.netflix.com'), 'netflix');
  assert.equal(Platforms.detectPlatform('notyoutube.com'), null);
  assert.equal(Platforms.detectPlatform('example.org'), null);
});

test('Platforms extracts YouTube multi-line and multi-segment ASR captions', () => {
  const doc = el('document', {}, [
    el('div', { id: 'movie_player', className: 'html5-video-player' }, [
      el('div', { className: 'ytp-caption-window-container' }, [
        el('div', { className: 'caption-window' }, [
          el('span', { className: 'caption-visual-line' }, [
            el('span', { className: 'ytp-caption-segment' }, ['Bonjour ']),
            el('span', { className: 'ytp-caption-segment' }, ['tout le monde'])
          ]),
          el('span', { className: 'caption-visual-line' }, [
            el('span', { className: 'ytp-caption-segment' }, ['Comment ça va ?'])
          ])
        ])
      ])
    ])
  ]);

  const res = Platforms.extractYouTubeSubtitle(doc);
  assert.equal(res.text, 'Bonjour tout le monde\nComment ça va ?');
  assert.equal(res.hasImageSubtitles, false);
  assert.ok(res.player);
  assert.ok(res.container);

  const brDoc = el('document', {}, [
    el('div', { id: 'movie_player', className: 'html5-video-player' }, [
      el('div', { className: 'ytp-caption-window-container' }, [
        el('div', { className: 'caption-window' }, [
          el('span', { className: 'captions-text' }, [
            el('span', { className: 'ytp-caption-segment' }, ['Hello ']),
            el('span', { className: 'ytp-caption-segment' }, ['world']),
            el('br'),
            el('span', { className: 'ytp-caption-segment' }, ['Second line'])
          ])
        ])
      ])
    ])
  ]);
  assert.equal(Platforms.extractYouTubeSubtitle(brDoc).text, 'Hello world\nSecond line');
});

test('Platforms extracts Netflix timedtext with <br> line breaks and detects SVG forced subtitles', () => {
  const textDoc = el('document', {}, [
    el('div', { className: 'watch-video--player-view' }, [
      el('div', { className: 'player-timedtext' }, [
        el('div', { className: 'player-timedtext-text-container' }, [
          el('span', {}, ['Primera línea', el('br'), 'Segunda línea'])
        ])
      ])
    ])
  ]);

  const res = Platforms.extractNetflixSubtitle(textDoc);
  assert.equal(res.text, 'Primera línea\nSegunda línea');
  assert.equal(res.hasImageSubtitles, false);

  const svgDoc = el('document', {}, [
    el('div', { className: 'watch-video--player-view' }, [
      el('div', { className: 'player-timedtext' }, [
        el('svg', {}, [el('image')])
      ])
    ])
  ]);

  const svgRes = Platforms.extractNetflixSubtitle(svgDoc);
  assert.equal(svgRes.text, '');
  assert.equal(svgRes.hasImageSubtitles, true);
});

test('Translator runs word + sentence in parallel, refines homographs, and serves cache hits', async () => {
  Background._clearCacheForTests();
  const calls = [];

  const mockFetch = async (url) => {
    calls.push(url);
    const parsedUrl = new URL(url);
    const q = parsedUrl.searchParams.get('q');
    const sl = parsedUrl.searchParams.get('sl');

    if (q === 'Je veux du pain frais.') {
      assert.equal(sl, 'auto');
      return {
        ok: true,
        async json() {
          return {
            sentences: [{ trans: 'I want fresh bread.' }],
            src: 'fr'
          };
        }
      };
    }

    if (q === 'pain' && sl === 'auto') {
      // Simulate Google mistaking standalone "pain" for English
      return {
        ok: true,
        async json() {
          return {
            sentences: [{ trans: 'pain' }],
            src: 'en'
          };
        }
      };
    }

    if (q === 'pain' && sl === 'fr') {
      return {
        ok: true,
        async json() {
          return {
            sentences: [{ trans: 'bread' }],
            dict: [{ pos: 'noun', terms: ['bread', 'loaf'] }],
            src: 'fr'
          };
        }
      };
    }

    throw new Error('Unexpected query: ' + q + ' sl=' + sl);
  };

  const result = await Background.translateWordAndSentence(
    {
      word: 'pain',
      sentence: 'Je veux du pain frais.',
      sourceLang: 'auto',
      targetLang: 'en'
    },
    mockFetch
  );

  assert.equal(result.wordTranslation, 'bread');
  assert.equal(result.sentenceTranslation, 'I want fresh bread.');
  assert.equal(result.detectedLang, 'fr');
  assert.deepEqual(result.dictionary, [{ pos: 'noun', terms: ['bread', 'loaf'] }]);
  // Parallel initial (word+sentence) + homograph refinement = 3 calls
  assert.equal(calls.length, 3);

  // Second call for the same word + sentence should be served 100% from cache
  const cachedResult = await Background.translateWordAndSentence(
    {
      word: 'pain',
      sentence: 'Je veux du pain frais.',
      sourceLang: 'auto',
      targetLang: 'en'
    },
    mockFetch
  );
  assert.equal(cachedResult.wordTranslation, 'bread');
  assert.equal(calls.length, 3);
});

test('Translator deduplicates concurrent in-flight lookups (hover prefetch + immediate click)', async () => {
  Background._clearCacheForTests();
  let fetchCount = 0;

  const mockFetch = async () => {
    fetchCount++;
    await new Promise((r) => setTimeout(r, 20));
    return {
      ok: true,
      async json() {
        return {
          sentences: [{ trans: 'house' }],
          dict: [{ pos: 'noun', terms: ['house', 'home'] }],
          src: 'es'
        };
      }
    };
  };

  const [a, b] = await Promise.all([
    Background.fetchSingleTranslation('casa', 'es', 'en', true, mockFetch),
    Background.fetchSingleTranslation('casa', 'es', 'en', true, mockFetch)
  ]);

  assert.equal(fetchCount, 1);
  assert.equal(a.translation, 'house');
  assert.equal(b.translation, 'house');
});

test('Translator falls back through Google GTX -> Google clients5 -> MyMemory', async () => {
  Background._clearCacheForTests();

  // Case 1: GTX fails -> clients5 succeeds
  const clients5Fetch = async (url) => {
    if (url.includes('translate.googleapis.com')) {
      return { ok: false, status: 429 };
    }
    if (url.includes('clients5.google.com')) {
      return {
        ok: true,
        async json() {
          return [['butterfly', 'es']];
        }
      };
    }
    throw new Error('Unexpected URL: ' + url);
  };

  const c5Res = await Background.translateWordAndSentence(
    {
      word: 'mariposa',
      sentence: '',
      sourceLang: 'auto',
      targetLang: 'en'
    },
    clients5Fetch
  );
  assert.equal(c5Res.wordTranslation, 'butterfly');
  assert.equal(c5Res.detectedLang, 'es');

  // Case 2: Both Google endpoints fail -> MyMemory succeeds
  Background._clearCacheForTests();
  const mmFetch = async (url) => {
    if (url.includes('translate.googleapis.com') || url.includes('clients5.google.com')) {
      return { ok: false, status: 429 };
    }
    if (url.includes('api.mymemory.translated.net')) {
      return {
        ok: true,
        async json() {
          return {
            responseStatus: 200,
            quotaFinished: false,
            responseData: { translatedText: 'butterfly', detectedLanguage: 'es-ES' },
            matches: [
              { translation: 'butterfly' },
              { translation: 'moth' }
            ]
          };
        }
      };
    }
    throw new Error('Unexpected URL: ' + url);
  };

  const mmRes = await Background.translateWordAndSentence(
    {
      word: 'mariposa',
      sentence: '',
      sourceLang: 'es',
      targetLang: 'en'
    },
    mmFetch
  );

  assert.equal(mmRes.wordTranslation, 'butterfly');
  assert.equal(mmRes.detectedLang, 'es');
  assert.deepEqual(mmRes.dictionary, [{ pos: 'alternatives', terms: ['moth'] }]);

  // Case 3: MyMemory quota warning is rejected instead of shown as a fake translation
  assert.throws(() => {
    Background.parseMyMemoryResponse({
      responseStatus: 200,
      quotaFinished: true,
      responseData: { translatedText: 'MYMEMORY WARNING: YOU USED ALL AVAILABLE FREE TRANSLATIONS' }
    });
  });
});

test('Translator batch-preloads sentence + all subtitle words in 1 request, upgrades on enrichment, and persists cache', async () => {
  Background._clearCacheForTests();
  const Translator = require('../src/shared/translator.js');
  let fetchCalls = 0;

  const mockBatchFetch = async (url) => {
    fetchCalls++;
    if (url.includes('clients5.google.com')) {
      const parsed = new URL(url);
      const qs = parsed.searchParams.getAll('q');
      assert.deepEqual(qs, ['La mariposa vuela.', 'La', 'mariposa', 'vuela']);
      return {
        ok: true,
        async json() {
          return ['The butterfly flies.', 'The', 'butterfly', 'flies'];
        }
      };
    }
    if (url.includes('translate.googleapis.com')) {
      return {
        ok: true,
        async json() {
          return {
            sentences: [{ trans: 'butterfly' }],
            dict: [{ pos: 'noun', terms: ['butterfly', 'moth'] }],
            src: 'es'
          };
        }
      };
    }
    throw new Error('Unexpected URL: ' + url);
  };

  const batchRes = await Translator.translateBatch(
    [
      { text: 'La mariposa vuela.', isWord: false },
      { text: 'La', isWord: true },
      { text: 'mariposa', isWord: true },
      { text: 'vuela', isWord: true }
    ],
    'es',
    'en',
    mockBatchFetch
  );

  assert.equal(fetchCalls, 1);
  assert.equal(batchRes.items.length, 4);

  // Instant 0ms cache hit (exact AND capitalized variant for non-German)
  const instantWord = Translator.getCachedSingle('Mariposa', 'es', 'en', true);
  assert.equal(instantWord.translation, 'butterfly');
  assert.equal(instantWord.enriched, false);

  const instantSentence = Translator.getCachedSingle('La mariposa vuela.', 'es', 'en', false);
  assert.equal(instantSentence.translation, 'The butterfly flies.');

  // Enrichment upgrades the cached word with dictionary POS without blocking initial 0ms read
  const enriched = await Translator.translateSingle('mariposa', 'es', 'en', true, {
    fetchImpl: mockBatchFetch,
    requireEnriched: true
  });
  assert.equal(fetchCalls, 2);
  assert.equal(enriched.enriched, true);
  assert.deepEqual(enriched.dictionary, [{ pos: 'noun', terms: ['butterfly', 'moth'] }]);

  // Persistent cache export -> clear -> hydrate preserves words across sessions
  const exported = Translator.exportPersistentCache(100);
  assert.ok(exported.length >= 3);
  Translator.clearCache();
  assert.equal(Translator.getCachedSingle('mariposa', 'es', 'en', true), undefined);

  Translator.hydratePersistentCache(exported);
  const restored = Translator.getCachedSingle('mariposa', 'es', 'en', true);
  assert.equal(restored.translation, 'butterfly');
  assert.equal(restored.enriched, true);
  assert.deepEqual(restored.dictionary, [{ pos: 'noun', terms: ['butterfly', 'moth'] }]);
});

test('Platforms dispatches Xray-safe primitive string events for Netflix playback control', () => {
  const dispatched = [];
  const prevWindow = global.window;
  const prevCustomEvent = global.CustomEvent;

  global.CustomEvent = function (type, init) {
    return { type, detail: init && init.detail };
  };
  global.window = {
    dispatchEvent(evt) {
      dispatched.push(evt);
    }
  };

  try {
    Platforms.pauseVideo('netflix', null, null);
    Platforms.playVideo('netflix', null, null);
  } finally {
    global.window = prevWindow;
    global.CustomEvent = prevCustomEvent;
  }

  assert.equal(dispatched.length, 2);
  assert.equal(dispatched[0].type, 'subclick:netflix-control');
  assert.equal(dispatched[0].detail, 'pause');
  assert.equal(dispatched[1].detail, 'play');
});

test('Packager generates store-ready Chrome and Firefox MV3 builds and zip archives', () => {
  const { buildAll } = require('../scripts/package.js');
  const out = buildAll();

  assert.ok(fs.existsSync(out.chrome.zipPath), 'Missing Chrome zip');
  assert.ok(fs.existsSync(out.firefox.zipPath), 'Missing Firefox zip');

  const chromeManifest = JSON.parse(
    fs.readFileSync(path.join(out.chrome.outDir, 'manifest.json'), 'utf8')
  );
  assert.equal(chromeManifest.background.service_worker, 'src/background.js');
  assert.equal(chromeManifest.background.scripts, undefined);
  assert.equal(chromeManifest.browser_specific_settings, undefined);

  const firefoxManifest = JSON.parse(
    fs.readFileSync(path.join(out.firefox.outDir, 'manifest.json'), 'utf8')
  );
  assert.equal(firefoxManifest.background.service_worker, undefined);
  assert.deepEqual(firefoxManifest.background.scripts, [
    'src/shared/constants.js',
    'src/shared/translator.js',
    'src/background.js'
  ]);
  assert.ok(firefoxManifest.browser_specific_settings.gecko.id);
  assert.equal(firefoxManifest.browser_specific_settings.gecko.strict_min_version, '140.0');
  assert.deepEqual(
    firefoxManifest.browser_specific_settings.gecko.data_collection_permissions.required,
    ['websiteContent']
  );

  // Verify every script referenced in Firefox manifest exists in dist/firefox
  for (const rel of firefoxManifest.background.scripts) {
    assert.ok(fs.existsSync(path.join(out.firefox.outDir, rel)), `Missing Firefox bg script: ${rel}`);
  }
});

test('Constants exports clean CSV with escaped quotes and commas', () => {
  const csv = Constants.vocabularyToCsv([
    {
      word: 'pan',
      translation: 'bread, loaf',
      dictionary: [{ pos: 'noun', terms: ['bread', 'loaf'] }],
      sourceLang: 'es',
      targetLang: 'en',
      sentence: 'Ella dijo: "Quiero pan"',
      sentenceTranslation: 'She said: "I want bread"',
      platform: 'Netflix',
      videoTitle: 'La Casa de Papel',
      savedAt: '2026-11-18T08:45:00.000Z'
    }
  ]);

  const lines = csv.split('\n');
  assert.equal(lines.length, 2);
  assert.ok(lines[1].includes('"bread, loaf"'));
  assert.ok(lines[1].includes('"Ella dijo: ""Quiero pan"""'));
});
