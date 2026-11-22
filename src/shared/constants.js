(function (root) {
  'use strict';

  const STORAGE_KEYS = {
    SETTINGS: 'subclick_settings',
    VOCABULARY: 'subclick_vocabulary',
    WORD_CACHE: 'subclick_word_cache'
  };

  const LANGUAGES = [
    { code: 'en', name: 'English' },
    { code: 'es', name: 'Spanish (Español)' },
    { code: 'fr', name: 'French (Français)' },
    { code: 'de', name: 'German (Deutsch)' },
    { code: 'it', name: 'Italian (Italiano)' },
    { code: 'pt', name: 'Portuguese (Português)' },
    { code: 'nl', name: 'Dutch (Nederlands)' },
    { code: 'ru', name: 'Russian (Русский)' },
    { code: 'ja', name: 'Japanese (日本語)' },
    { code: 'ko', name: 'Korean (한국어)' },
    { code: 'zh-CN', name: 'Chinese Simplified (简体中文)' },
    { code: 'zh-TW', name: 'Chinese Traditional (繁體中文)' },
    { code: 'ar', name: 'Arabic (العربية)' },
    { code: 'hi', name: 'Hindi (हिन्दी)' },
    { code: 'tr', name: 'Turkish (Türkçe)' },
    { code: 'pl', name: 'Polish (Polski)' },
    { code: 'sv', name: 'Swedish (Svenska)' },
    { code: 'no', name: 'Norwegian (Norsk)' },
    { code: 'da', name: 'Danish (Dansk)' },
    { code: 'fi', name: 'Finnish (Suomi)' },
    { code: 'vi', name: 'Vietnamese (Tiếng Việt)' },
    { code: 'th', name: 'Thai (ไทย)' },
    { code: 'id', name: 'Indonesian (Bahasa Indonesia)' },
    { code: 'ms', name: 'Malay (Bahasa Melayu)' },
    { code: 'uk', name: 'Ukrainian (Українська)' },
    { code: 'el', name: 'Greek (Ελληνικά)' },
    { code: 'cs', name: 'Czech (Čeština)' },
    { code: 'ro', name: 'Romanian (Română)' },
    { code: 'hu', name: 'Hungarian (Magyar)' },
    { code: 'he', name: 'Hebrew (עברית)' },
    { code: 'fa', name: 'Persian (فارسی)' },
    { code: 'bn', name: 'Bengali (বাংলা)' }
  ];

  const DEFAULT_SETTINGS = {
    enabled: true,
    targetLang: 'en',
    sourceLang: 'auto',
    autoPause: true,
    autoResume: true,
    showSentenceTranslation: true,
    autoSaveWords: true,
    preloadSubtitles: true,
    subtitleSize: 'medium' // 'small' | 'medium' | 'large' | 'xlarge'
  };

  function resolveSettings(stored) {
    return Object.assign({}, DEFAULT_SETTINGS, stored || {});
  }

  function makeVocabId(word, sourceLang, targetLang) {
    return `${String(word || '').trim().toLowerCase()}::${String(sourceLang || 'auto').toLowerCase()}::${String(targetLang || 'en').toLowerCase()}`;
  }

  function escapeCsvField(value) {
    const str = String(value == null ? '' : value).replace(/\r?\n/g, ' ');
    if (/[",]/.test(str)) {
      return `"${str.replace(/"/g, '""')}"`;
    }
    return str;
  }

  function vocabularyToCsv(items) {
    const headers = [
      'Word',
      'Translation',
      'Part of Speech',
      'Alternatives',
      'Source Language',
      'Target Language',
      'Context Sentence',
      'Sentence Translation',
      'Platform',
      'Video Title',
      'Saved At'
    ];
    const rows = [headers.join(',')];
    for (const item of items || []) {
      const pos = Array.isArray(item.dictionary) && item.dictionary.length > 0
        ? item.dictionary.map((d) => d.pos).filter(Boolean).join('; ')
        : '';
      const alts = Array.isArray(item.dictionary) && item.dictionary.length > 0
        ? item.dictionary.flatMap((d) => d.terms || []).slice(0, 6).join('; ')
        : '';
      rows.push([
        escapeCsvField(item.word),
        escapeCsvField(item.translation),
        escapeCsvField(pos),
        escapeCsvField(alts),
        escapeCsvField(item.sourceLang),
        escapeCsvField(item.targetLang),
        escapeCsvField(item.sentence),
        escapeCsvField(item.sentenceTranslation),
        escapeCsvField(item.platform),
        escapeCsvField(item.videoTitle),
        escapeCsvField(item.savedAt)
      ].join(','));
    }
    return rows.join('\n');
  }

  const api = {
    STORAGE_KEYS,
    LANGUAGES,
    DEFAULT_SETTINGS,
    resolveSettings,
    makeVocabId,
    escapeCsvField,
    vocabularyToCsv
  };

  root.SubClickConstants = api;
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
})(typeof globalThis !== 'undefined' ? globalThis : window);
