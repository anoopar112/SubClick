(function () {
  'use strict';

  const Constants = globalThis.SubClickConstants;
  const STORAGE_KEYS = Constants.STORAGE_KEYS;

  const hasBrowserStorage =
    typeof browser !== 'undefined' &&
    browser.storage &&
    browser.storage.local &&
    typeof browser.storage.local.get === 'function';

  function storageGet(keys) {
    if (hasBrowserStorage) {
      return browser.storage.local.get(keys).catch(() => ({}));
    }
    return new Promise((resolve) => {
      chrome.storage.local.get(keys, (res) => resolve(res || {}));
    });
  }

  function storageSet(obj) {
    if (hasBrowserStorage) {
      return browser.storage.local.set(obj).catch(() => {});
    }
    return new Promise((resolve) => {
      chrome.storage.local.set(obj, () => resolve());
    });
  }

  const toggleEnabled = document.getElementById('toggle-enabled');
  const selectTargetLang = document.getElementById('select-target-lang');
  const selectSourceLang = document.getElementById('select-source-lang');
  const sizeSelector = document.getElementById('size-selector');
  const toggleAutoPause = document.getElementById('toggle-autopause');
  const toggleAutoResume = document.getElementById('toggle-autoresume');
  const toggleSentence = document.getElementById('toggle-sentence');
  const togglePreload = document.getElementById('toggle-preload');
  const toggleAutoSave = document.getElementById('toggle-autosave');

  const tabs = document.querySelectorAll('.tab');
  const panelSettings = document.getElementById('panel-settings');
  const panelVocab = document.getElementById('panel-vocab');
  const vocabCountBadge = document.getElementById('vocab-count');

  const vocabSearch = document.getElementById('vocab-search');
  const vocabListEl = document.getElementById('vocab-list');
  const btnExportCsv = document.getElementById('btn-export-csv');
  const btnExportJson = document.getElementById('btn-export-json');
  const btnClearVocab = document.getElementById('btn-clear-vocab');

  let currentSettings = Object.assign({}, Constants.DEFAULT_SETTINGS);
  let vocabularyItems = [];
  let clearConfirmArmed = false;
  let clearConfirmTimer = null;

  function populateLanguageDropdowns() {
    // Target language dropdown
    selectTargetLang.textContent = '';
    for (const lang of Constants.LANGUAGES) {
      const opt = document.createElement('option');
      opt.value = lang.code;
      opt.textContent = lang.name;
      selectTargetLang.appendChild(opt);
    }

    // Source language dropdown
    selectSourceLang.textContent = '';
    const autoOpt = document.createElement('option');
    autoOpt.value = 'auto';
    autoOpt.textContent = 'Auto-detect (Recommended)';
    selectSourceLang.appendChild(autoOpt);

    for (const lang of Constants.LANGUAGES) {
      const opt = document.createElement('option');
      opt.value = lang.code;
      opt.textContent = lang.name;
      selectSourceLang.appendChild(opt);
    }
  }

  function applySettingsToUi(settings) {
    toggleEnabled.checked = Boolean(settings.enabled);
    selectTargetLang.value = settings.targetLang || 'en';
    selectSourceLang.value = settings.sourceLang || 'auto';
    toggleAutoPause.checked = Boolean(settings.autoPause);
    toggleAutoResume.checked = Boolean(settings.autoResume);
    toggleSentence.checked = settings.showSentenceTranslation !== false;
    togglePreload.checked = settings.preloadSubtitles !== false;
    toggleAutoSave.checked = Boolean(settings.autoSaveWords);

    const activeSize = settings.subtitleSize || 'medium';
    const pills = sizeSelector.querySelectorAll('.size-pill');
    for (const pill of pills) {
      pill.classList.toggle('is-active', pill.dataset.size === activeSize);
    }
  }

  function saveSettingsPatch(patch) {
    currentSettings = Object.assign({}, currentSettings, patch);
    storageSet({ [STORAGE_KEYS.SETTINGS]: currentSettings });
  }

  function switchTab(tabName) {
    for (const tab of tabs) {
      const active = tab.dataset.tab === tabName;
      tab.classList.toggle('is-active', active);
      tab.setAttribute('aria-selected', String(active));
    }
    panelSettings.hidden = tabName !== 'settings';
    panelVocab.hidden = tabName !== 'vocab';
  }

  function renderVocabulary() {
    vocabCountBadge.textContent = String(vocabularyItems.length);

    const hasAny = vocabularyItems.length > 0;
    btnExportCsv.disabled = !hasAny;
    btnExportJson.disabled = !hasAny;
    btnClearVocab.disabled = !hasAny;

    const query = (vocabSearch.value || '').trim().toLowerCase();
    const filtered = query
      ? vocabularyItems.filter((item) => {
          return (
            String(item.word || '').toLowerCase().includes(query) ||
            String(item.translation || '').toLowerCase().includes(query) ||
            String(item.sentence || '').toLowerCase().includes(query) ||
            String(item.videoTitle || '').toLowerCase().includes(query)
          );
        })
      : vocabularyItems;

    vocabListEl.textContent = '';

    if (filtered.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'vocab-empty';
      empty.textContent = hasAny
        ? 'No saved words match your search.'
        : 'No saved words yet. Click any subtitle word on YouTube or Netflix to build your vocabulary!';
      vocabListEl.appendChild(empty);
      return;
    }

    for (const item of filtered) {
      const card = document.createElement('div');
      card.className = 'vocab-card';

      const top = document.createElement('div');
      top.className = 'vocab-card-top';

      const pair = document.createElement('div');
      pair.className = 'vocab-word-pair';

      const wordEl = document.createElement('span');
      wordEl.className = 'vocab-word';
      wordEl.textContent = item.word;

      const arrowEl = document.createElement('span');
      arrowEl.className = 'vocab-arrow';
      arrowEl.textContent = '→';

      const transEl = document.createElement('span');
      transEl.className = 'vocab-trans';
      transEl.textContent = item.translation;

      pair.appendChild(wordEl);
      pair.appendChild(arrowEl);
      pair.appendChild(transEl);

      const delBtn = document.createElement('button');
      delBtn.type = 'button';
      delBtn.className = 'vocab-delete';
      delBtn.title = 'Remove word';
      delBtn.textContent = '×';
      delBtn.addEventListener('click', () => {
        deleteVocabItem(item.id);
      });

      top.appendChild(pair);
      top.appendChild(delBtn);
      card.appendChild(top);

      if (item.sentence && item.sentence.trim().toLowerCase() !== String(item.word || '').trim().toLowerCase()) {
        const sentEl = document.createElement('div');
        sentEl.className = 'vocab-sentence';
        sentEl.textContent = item.sentence;
        card.appendChild(sentEl);

        if (item.sentenceTranslation) {
          const sentTransEl = document.createElement('div');
          sentTransEl.className = 'vocab-sentence-trans';
          sentTransEl.textContent = item.sentenceTranslation;
          card.appendChild(sentTransEl);
        }
      }

      const meta = document.createElement('div');
      meta.className = 'vocab-meta';

      if (item.sourceLang && item.targetLang) {
        const langPill = document.createElement('span');
        langPill.className = 'vocab-pill';
        langPill.textContent = `${item.sourceLang} → ${item.targetLang}`;
        meta.appendChild(langPill);
      }

      if (item.platform) {
        const platPill = document.createElement('span');
        platPill.className = 'vocab-pill';
        platPill.textContent = item.platform;
        meta.appendChild(platPill);
      }

      if (item.videoTitle) {
        const titleSpan = document.createElement('span');
        titleSpan.className = 'vocab-title';
        titleSpan.title = item.videoTitle;
        titleSpan.textContent = item.videoTitle;
        meta.appendChild(titleSpan);
      }

      card.appendChild(meta);
      vocabListEl.appendChild(card);
    }
  }

  function deleteVocabItem(id) {
    vocabularyItems = vocabularyItems.filter((item) => item && item.id !== id);
    storageSet({ [STORAGE_KEYS.VOCABULARY]: vocabularyItems }).then(() => {
      renderVocabulary();
    });
  }

  function triggerDownload(filename, mimeType, content) {
    const blob = new Blob([content], { type: mimeType });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
  }

  function resetClearConfirm() {
    clearConfirmArmed = false;
    btnClearVocab.textContent = 'Clear All';
    if (clearConfirmTimer) {
      clearTimeout(clearConfirmTimer);
      clearConfirmTimer = null;
    }
  }

  // Wire UI Events
  for (const tab of tabs) {
    tab.addEventListener('click', () => switchTab(tab.dataset.tab));
  }

  toggleEnabled.addEventListener('change', () => {
    saveSettingsPatch({ enabled: toggleEnabled.checked });
  });

  selectTargetLang.addEventListener('change', () => {
    saveSettingsPatch({ targetLang: selectTargetLang.value });
  });

  selectSourceLang.addEventListener('change', () => {
    saveSettingsPatch({ sourceLang: selectSourceLang.value });
  });

  sizeSelector.addEventListener('click', (e) => {
    const pill = e.target && e.target.closest ? e.target.closest('.size-pill') : null;
    if (!pill || !pill.dataset.size) return;
    saveSettingsPatch({ subtitleSize: pill.dataset.size });
    applySettingsToUi(currentSettings);
  });

  toggleAutoPause.addEventListener('change', () => {
    saveSettingsPatch({ autoPause: toggleAutoPause.checked });
  });

  toggleAutoResume.addEventListener('change', () => {
    saveSettingsPatch({ autoResume: toggleAutoResume.checked });
  });

  toggleSentence.addEventListener('change', () => {
    saveSettingsPatch({ showSentenceTranslation: toggleSentence.checked });
  });

  togglePreload.addEventListener('change', () => {
    saveSettingsPatch({ preloadSubtitles: togglePreload.checked });
  });

  toggleAutoSave.addEventListener('change', () => {
    saveSettingsPatch({ autoSaveWords: toggleAutoSave.checked });
  });

  vocabSearch.addEventListener('input', () => {
    renderVocabulary();
  });

  btnExportCsv.addEventListener('click', () => {
    if (!vocabularyItems.length) return;
    const csv = '\uFEFF' + Constants.vocabularyToCsv(vocabularyItems);
    const dateTag = new Date().toISOString().slice(0, 10);
    triggerDownload(`subclick-vocabulary-${dateTag}.csv`, 'text/csv;charset=utf-8', csv);
  });

  btnExportJson.addEventListener('click', () => {
    if (!vocabularyItems.length) return;
    const json = JSON.stringify(vocabularyItems, null, 2);
    const dateTag = new Date().toISOString().slice(0, 10);
    triggerDownload(`subclick-vocabulary-${dateTag}.json`, 'application/json;charset=utf-8', json);
  });

  btnClearVocab.addEventListener('click', () => {
    if (!vocabularyItems.length) return;
    if (!clearConfirmArmed) {
      clearConfirmArmed = true;
      btnClearVocab.textContent = 'Confirm?';
      clearConfirmTimer = setTimeout(resetClearConfirm, 3000);
      return;
    }
    resetClearConfirm();
    vocabularyItems = [];
    storageSet({ [STORAGE_KEYS.VOCABULARY]: [] }).then(() => {
      renderVocabulary();
    });
  });

  // Initialize state from storage
  populateLanguageDropdowns();

  storageGet([STORAGE_KEYS.SETTINGS, STORAGE_KEYS.VOCABULARY]).then((res) => {
    currentSettings = Constants.resolveSettings(res && res[STORAGE_KEYS.SETTINGS]);
    vocabularyItems = res && Array.isArray(res[STORAGE_KEYS.VOCABULARY])
      ? res[STORAGE_KEYS.VOCABULARY]
      : [];
    applySettingsToUi(currentSettings);
    renderVocabulary();
  });

  const storageEvents =
    (typeof browser !== 'undefined' && browser.storage && browser.storage.onChanged) ||
    (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.onChanged) ||
    null;

  if (storageEvents && typeof storageEvents.addListener === 'function') {
    storageEvents.addListener((changes, areaName) => {
      if (areaName !== 'local') return;
      if (changes[STORAGE_KEYS.VOCABULARY]) {
        vocabularyItems = Array.isArray(changes[STORAGE_KEYS.VOCABULARY].newValue)
          ? changes[STORAGE_KEYS.VOCABULARY].newValue
          : [];
        renderVocabulary();
      }
    });
  }
})();
