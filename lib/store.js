// 本地存储：设置、单词本、已认识的词。全部保存在 chrome.storage.local，不联网。
(function (root) {
  const DEFAULT_SETTINGS = {
    level: null,          // 词汇量估计；词频排名超过它的词算生词
    highlight: true,      // 阅读时高亮生词
    disabledSites: [],    // 不高亮的网站
  };

  async function getSettings() {
    const { settings } = await chrome.storage.local.get('settings');
    return { ...DEFAULT_SETTINGS, ...(settings || {}) };
  }

  async function saveSettings(patch) {
    const settings = { ...(await getSettings()), ...patch };
    await chrome.storage.local.set({ settings });
    return settings;
  }

  async function getWordbook() {
    const { wordbook } = await chrome.storage.local.get('wordbook');
    return wordbook || {};
  }

  // item: {word, phonetic, meaning, sentence, url, title, source: 'reading' | 'video'}
  async function addWords(items) {
    const wordbook = await getWordbook();
    const now = Date.now();
    for (const item of items) {
      const key = item.word.toLowerCase();
      const old = wordbook[key];
      wordbook[key] = {
        ...item,
        addedAt: old ? old.addedAt : now,
        count: (old ? old.count || 1 : 0) + 1,
      };
    }
    await chrome.storage.local.set({ wordbook });
    return wordbook;
  }

  async function removeWord(word) {
    const wordbook = await getWordbook();
    delete wordbook[word.toLowerCase()];
    await chrome.storage.local.set({ wordbook });
  }

  async function getKnown() {
    const { known } = await chrome.storage.local.get('known');
    return known || [];
  }

  async function setKnown(word, isKnown) {
    const known = new Set(await getKnown());
    if (isKnown) known.add(word.toLowerCase());
    else known.delete(word.toLowerCase());
    await chrome.storage.local.set({ known: [...known] });
  }

  root.LLStore = { getSettings, saveSettings, getWordbook, addWords, removeWord, getKnown, setKnown };
})(typeof self !== 'undefined' ? self : this);
