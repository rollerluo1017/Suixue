// 后台：加载离线词典，负责查词和视频字幕的高频词统计。
importScripts('lib/text.js', 'lib/store.js');

const UNKNOWN_RANK = 99999;
let dataPromise = null;

function loadData() {
  if (!dataPromise) {
    const load = (name) => fetch(chrome.runtime.getURL('data/' + name)).then((r) => r.json());
    dataPromise = Promise.all([load('dict.json'), load('lemma.json'), load('phrases.json')])
      .then(([dict, lemma, phrases]) => ({ dict, lemma, phrases }));
  }
  return dataPromise;
}

// 查一个单词：同时看它本身和原形，取更常用的排名
function resolve(data, raw) {
  let w = LLText.normalize(raw);
  if (w.endsWith("'s")) w = w.slice(0, -2);
  const own = data.dict[w];
  const base = data.lemma[w];
  const baseEntry = base ? data.dict[base] : null;
  if (!own && !baseEntry) return null;
  // are/does 这类功能词在词典里可能只收了冷僻义项，按最常用处理
  const rank = LLText.STOPWORDS.has(w) ? 1 : Math.min(own ? own[0] : UNKNOWN_RANK, baseEntry ? baseEntry[0] : UNKNOWN_RANK);
  const entry = own || baseEntry;
  return {
    word: own ? w : base,
    base: base || w,
    rank,
    phonetic: entry[1],
    meaning: entry[2],
    baseMeaning: own && baseEntry ? baseEntry[2] : null,
  };
}

function lemmaOf(data, word) {
  const w = LLText.normalize(word);
  return data.lemma[w] || w;
}

function define(data, text) {
  const clean = text.trim().replace(/\s+/g, ' ');
  const lower = LLText.normalize(clean);
  const tokens = LLText.tokenize(clean);
  const lemmed = tokens.map((t) => lemmaOf(data, t.word)).join(' ');
  for (const p of [lower, lemmed]) {
    if (data.phrases[p]) return { word: p, base: p, phrase: true, meaning: data.phrases[p][0], rank: 0 };
  }
  if (tokens.length === 1) return resolve(data, tokens[0].word);
  if (!tokens.length) return null;
  // 没收录的短语：逐词给出释义
  const parts = tokens.slice(0, 6).map((t) => resolve(data, t.word)).filter(Boolean);
  return { word: clean, base: lower, phrase: true, rank: 0, meaning: '', parts };
}

async function summarizeLines(data, lines, level) {
  const known = new Set(await LLStore.getKnown());
  const wordbook = await LLStore.getWordbook();
  const words = new Map();
  const phrases = new Map();
  for (const line of lines) {
    const tokens = LLText.tokenize(line);
    const lowered = tokens.map((t) => LLText.normalize(t.word));
    const lemmed = tokens.map((t) => lemmaOf(data, t.word));
    tokens.forEach((t, i) => {
      const w = lowered[i];
      if (LLText.STOPWORDS.has(w) || w.length < 3 || LLText.looksLikeProperNoun(line, t)) return;
      const info = resolve(data, w);
      if (!info) return;
      const key = info.base;
      const item = words.get(key) || { word: key, count: 0, rank: info.rank, example: line, forms: new Set() };
      item.count++;
      item.forms.add(w);
      words.set(key, item);
    });
    // 只统计词典里收录的 2～4 词短语，每个位置取最长的那个（as soon as possible 不再重复算 as soon as）
    for (let i = 0; i < lowered.length; i++) {
      for (let n = 4; n >= 2; n--) {
        if (i + n > lowered.length) continue;
        const raw = lowered.slice(i, i + n).join(' ');
        const p = data.phrases[raw] ? raw : lemmed.slice(i, i + n).join(' '); // picked up -> pick up
        if (!data.phrases[p] || /^(to|a|an|the) /.test(p)) continue;
        const item = phrases.get(p) || { phrase: p, count: 0, meaning: data.phrases[p][0], kind: data.phrases[p][1], example: line };
        item.count++;
        phrases.set(p, item);
        i += n - 1;
        break;
      }
    }
  }

  const wordList = [...words.values()].map((item) => {
    const info = resolve(data, item.word);
    return {
      word: item.word,
      count: item.count,
      rank: item.rank,
      phonetic: info ? info.phonetic : '',
      meaning: info ? info.meaning : '',
      example: item.example,
      forms: [...item.forms],
      isNew: level ? item.rank > level : true,
      known: known.has(item.word),
      saved: !!wordbook[item.word],
    };
  });
  wordList.sort((a, b) => b.isNew - a.isNew || b.count - a.count || b.rank - a.rank);

  // 短语难度：0 太常见不显示；1 动词短语/习语，总是显示；2 普通搭配，只有含较难的词才显示
  const phraseList = [...phrases.values()]
    .filter((p) => !known.has(p.phrase))
    .filter((p) => {
      if (p.kind === 0) return false;
      if (p.kind === 1 || !level) return true;
      const hardest = Math.max(...p.phrase.split(' ').map((w) => (resolve(data, w) || { rank: UNKNOWN_RANK }).rank));
      return hardest > level * 0.5;
    })
    .map((p) => ({ ...p, saved: !!wordbook[p.phrase] }))
    .sort((a, b) => a.kind - b.kind || b.count - a.count || b.phrase.split(' ').length - a.phrase.split(' ').length)
    .slice(0, 30);

  return { words: wordList.slice(0, 80), phrases: phraseList, totalWords: words.size, lineCount: lines.length };
}

// ---------- 本地语音识别（没有字幕的视频） ----------
// 识别在 asr/offscreen.html 里进行，这里只记录每个标签页转写出的句子。

async function getAsr() {
  const { asr } = await chrome.storage.session.get('asr');
  return asr || null;
}

async function setAsr(patch) {
  const asr = { ...(await getAsr()), ...patch };
  await chrome.storage.session.set({ asr });
  return asr;
}

async function ensureOffscreen() {
  const url = chrome.runtime.getURL('asr/offscreen.html');
  const existing = await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'], documentUrls: [url] });
  if (existing.length) return;
  await chrome.offscreen.createDocument({
    url: 'asr/offscreen.html',
    reasons: ['USER_MEDIA'],
    justification: '录下当前标签页的声音，在本机转成文字，用来统计视频高频词',
  });
}

async function handleAsr(msg) {
  switch (msg.type) {
    case 'asrStart': {
      await ensureOffscreen();
      await setAsr({ tabId: msg.tabId, url: msg.url, lines: [], status: 'loading', running: true, error: null });
      chrome.action.setBadgeText({ tabId: msg.tabId, text: '听' });
      chrome.action.setBadgeBackgroundColor({ tabId: msg.tabId, color: '#dc2626' });
      // offscreen 页面刚创建时脚本可能还没加载完，稍等重试
      for (let i = 0; i < 30; i++) {
        try {
          const res = await chrome.runtime.sendMessage({ target: 'offscreen', type: 'start', streamId: msg.streamId, tabId: msg.tabId });
          if (res && res.error) await setAsr({ running: false, status: 'error', error: res.error });
          return res;
        } catch (e) {
          await new Promise((r) => setTimeout(r, 100));
        }
      }
      await setAsr({ running: false, status: 'error', error: '识别模块没有启动' });
      return { error: '识别模块没有启动' };
    }
    case 'asrStop':
      return chrome.runtime.sendMessage({ target: 'offscreen', type: 'stop' }).catch(() => null);
    case 'asrState': {
      const asr = await getAsr();
      return asr && asr.tabId === msg.tabId ? asr : null;
    }
    case 'asrText': {
      const asr = await getAsr();
      if (asr && asr.tabId === msg.tabId) await setAsr({ lines: [...asr.lines, msg.text], status: 'ready' });
      return;
    }
    case 'asrStatus':
      return setAsr({ status: msg.status, error: msg.error || null });
    case 'asrStopped':
      chrome.action.setBadgeText({ tabId: msg.tabId, text: '' });
      return setAsr({ running: false });
  }
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.target === 'offscreen') return false; // 发给 offscreen 页面的，不归这里回复
  if (msg.type.startsWith('asr')) {
    handleAsr(msg).then(sendResponse, (err) => sendResponse({ error: String(err) }));
    return true;
  }
  (async () => {
    const data = await loadData();
    switch (msg.type) {
      case 'lookupMany': {
        // 返回 {原词小写: 排名}，只包含词典里有的词
        const out = {};
        for (const w of msg.words) {
          const info = resolve(data, w);
          if (info) out[w] = [info.rank, info.base];
        }
        return out;
      }
      case 'define':
        return define(data, msg.text);
      case 'summarize':
        return summarizeLines(data, msg.lines, msg.level);
    }
  })().then(sendResponse, (err) => sendResponse({ error: String(err) }));
  return true;
});

chrome.runtime.onInstalled.addListener(async (details) => {
  if (details.reason === 'install') {
    chrome.tabs.create({ url: chrome.runtime.getURL('pages/test.html') });
  }
});
