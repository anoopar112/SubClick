(function (root) {
  'use strict';

  const LETTER_REGEX = /\p{L}/u;
  const FALLBACK_WORD_REGEX = /(\p{L}[\p{L}\p{M}'’]*)/gu;

  let cachedSegmenter = null;
  let cachedLocale = null;

  function getSegmenter(locale) {
    if (typeof Intl === 'undefined' || typeof Intl.Segmenter !== 'function') {
      return null;
    }
    const normalizedLocale = locale && locale !== 'auto' ? locale : undefined;
    if (!cachedSegmenter || cachedLocale !== normalizedLocale) {
      try {
        cachedSegmenter = new Intl.Segmenter(normalizedLocale, { granularity: 'word' });
        cachedLocale = normalizedLocale;
      } catch (_) {
        cachedSegmenter = new Intl.Segmenter(undefined, { granularity: 'word' });
        cachedLocale = undefined;
      }
    }
    return cachedSegmenter;
  }

  /**
   * Tokenizes a single line of subtitle text into `{ text, isWord }` tokens.
   * Uses Unicode UAX #29 word segmentation via `Intl.Segmenter` (supporting
   * Latin, Cyrillic, Arabic, Devanagari, and non-whitespace CJK/Thai scripts).
   */
  function tokenizeLine(line, locale) {
    const input = String(line || '');
    if (!input) return [];

    const segmenter = getSegmenter(locale);
    if (segmenter) {
      const tokens = [];
      for (const seg of segmenter.segment(input)) {
        const text = seg.segment;
        const isWord = Boolean(seg.isWordLike) && LETTER_REGEX.test(text);
        if (!isWord && tokens.length > 0 && !tokens[tokens.length - 1].isWord) {
          tokens[tokens.length - 1].text += text;
        } else {
          tokens.push({ text, isWord });
        }
      }
      return tokens;
    }

    // Fallback regex tokenizer
    const tokens = [];
    let lastIndex = 0;
    let match;
    FALLBACK_WORD_REGEX.lastIndex = 0;
    while ((match = FALLBACK_WORD_REGEX.exec(input)) !== null) {
      if (match.index > lastIndex) {
        tokens.push({ text: input.slice(lastIndex, match.index), isWord: false });
      }
      tokens.push({ text: match[0], isWord: true });
      lastIndex = match.index + match[0].length;
    }
    if (lastIndex < input.length) {
      tokens.push({ text: input.slice(lastIndex), isWord: false });
    }
    return tokens;
  }

  /**
   * Tokenizes multi-line subtitle text into an array of token arrays (one per line).
   */
  function tokenizeSubtitle(text, locale) {
    if (!text) return [];
    const lines = String(text)
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean);
    return lines.map((line) => tokenizeLine(line, locale));
  }

  const api = {
    tokenizeLine,
    tokenizeSubtitle
  };

  root.SubClickTokenizer = api;
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
})(typeof globalThis !== 'undefined' ? globalThis : window);
