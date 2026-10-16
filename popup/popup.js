const $ = (id) => document.getElementById(id);
let tab = null;
let summary = null;

function escapeHtml(s) {
  return String(s || '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

function openPage(path) {
  chrome.tabs.create({ url: chrome.runtime.getURL(path) });
  window.close();
}

async function init() {
  [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const settings = await LLStore.getSettings();
  const wordbook = await LLStore.getWordbook();
  const host = tab && tab.url && /^https?:/.test(tab.url) ? new URL(tab.url).hostname : '';

  $('bookCount').textContent = `(${Object.keys(wordbook).length})`;
  $('noLevel').hidden = !!settings.level;
  $('highlight').checked = settings.highlight;
  $('level').value = settings.level || '';
  $('host').textContent = host || '此页面';
  $('siteOff').checked = settings.disabledSites.includes(host);
  $('siteOff').disabled = !host;

  $('highlight').onchange = () => LLStore.saveSettings({ highlight: $('highlight').checked });
  $('siteOff').onchange = async () => {
    const s = await LLStore.getSettings();
    const sites = new Set(s.disabledSites);
    $('siteOff').checked ? sites.add(host) : sites.delete(host);
    LLStore.saveSettings({ disabledSites: [...sites] });
  };
  $('level').onchange = () => {
    const v = Math.max(500, Math.min(30000, Number($('level').value) || 0));
    $('level').value = v;
    LLStore.saveSettings({ level: v });
  };
  $('goTest').onclick = $('retest').onclick = (e) => { e.preventDefault(); openPage('pages/test.html'); };
  $('openBook').onclick = (e) => { e.preventDefault(); openPage('pages/wordbook.html'); };
  $('summarize').onclick = summarize;
  $('asrToggle').onclick = toggleAsr;
  // 标为认识：以后不再出现在总结和网页高亮里
  $('summary').addEventListener('click', async (e) => {
    const btn = e.target.closest('.knownBtn');
    if (!btn) return;
    await LLStore.setKnown(btn.dataset.text, true);
    btn.closest('li').remove();
  });
  $('addSelected').onclick = addSelected;

  checkVideo();
}

async function ask(msg) {
  try {
    return await chrome.tabs.sendMessage(tab.id, msg);
  } catch (e) {
    return null;
  }
}

let asr = null;

async function checkVideo() {
  const status = tab ? await ask({ type: 'videoStatus' }) : null;
  asr = tab ? await chrome.runtime.sendMessage({ type: 'asrState', tabId: tab.id }) : null;
  const el = $('videoStatus');
  if (!status) {
    el.textContent = '这个页面用不了。如果是刚装好插件，刷新一下页面再试。';
    return;
  }
  if (!status.found && !status.lineCount && !asr) {
    el.textContent = '当前页面没有检测到视频。';
    return;
  }
  if (status.lineCount) el.textContent = `检测到视频，已收集 ${status.lineCount} 句英文字幕。`;
  else el.textContent = '检测到视频，但没拿到字幕。有字幕的话在播放器里打开字幕（CC）；没有的话可以用下面的本地听写。';
  $('asrBox').hidden = false;
  renderAsr();
  $('summarize').hidden = !(status.lineCount || (asr && asr.lines.length));
}

const ASR_STATUS = {
  loading: '正在加载识别模型（第一次稍慢）…',
  ready: '正在听写',
  error: '识别出错',
};

function renderAsr() {
  const running = asr && asr.running;
  $('asrToggle').textContent = running ? '停止听写' : '没有字幕？开始本地听写';
  $('asrToggle').classList.toggle('running', !!running);
  if (!asr) {
    $('asrStatus').textContent = '在你电脑上把视频声音转成文字，不联网。开始后正常播放视频即可。';
    return;
  }
  const count = asr.lines.length ? `，已转写 ${asr.lines.length} 段` : '';
  const state = running ? ASR_STATUS[asr.status] || '' : '听写已停止';
  $('asrStatus').textContent = state + count + (asr.error ? `：${asr.error}` : '');
}

async function toggleAsr() {
  if (asr && asr.running) {
    await chrome.runtime.sendMessage({ type: 'asrStop' });
  } else {
    try {
      const streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: tab.id });
      const res = await chrome.runtime.sendMessage({ type: 'asrStart', tabId: tab.id, url: tab.url, streamId });
      if (res && res.error) $('asrStatus').textContent = '没能开始听写：' + res.error;
    } catch (e) {
      $('asrStatus').textContent = '没能开始听写：' + e.message;
      return;
    }
  }
  asr = await chrome.runtime.sendMessage({ type: 'asrState', tabId: tab.id });
  renderAsr();
}

// 面板开着时刷新听写进度
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'session' || !changes.asr || !tab) return;
  const next = changes.asr.newValue;
  asr = next && next.tabId === tab.id ? next : null;
  renderAsr();
  if (asr && asr.lines.length && !summary) $('summarize').hidden = false;
});

async function summarize() {
  $('summarize').disabled = true;
  $('summarize').textContent = '正在统计…';
  const lines = [...((await ask({ type: 'videoLines' })) || []), ...(asr ? asr.lines : [])];
  const settings = await LLStore.getSettings();
  summary = await chrome.runtime.sendMessage({ type: 'summarize', lines, level: settings.level });
  $('summarize').hidden = true;
  renderSummary();
}

function renderSummary() {
  $('summary').hidden = false;
  // 只列出超过生词标准的词，已经掌握的常用词不占位置
  const words = summary.words.filter((w) => !w.known && w.isNew);
  $('wordList').innerHTML = words.length ? words.map((w, i) => `
    <li><label><input type="checkbox" data-kind="word" data-i="${i}" ${w.isNew && !w.saved ? 'checked' : ''} ${w.saved ? 'disabled' : ''}>
      <span class="w">${escapeHtml(w.word)}</span><span class="n">×${w.count}</span>
      <span class="m" title="${escapeHtml(w.meaning)}">${escapeHtml(w.meaning)}</span></label>
      ${w.saved ? '<span class="tag">已在单词本</span>' : `<button class="knownBtn" data-text="${escapeHtml(w.word)}">认识</button>`}</li>`).join('')
    : '<li class="empty">这段视频里没有超出你水平的生词</li>';
  $('phraseList').innerHTML = summary.phrases.length ? summary.phrases.map((p, i) => `
    <li><label><input type="checkbox" data-kind="phrase" data-i="${i}" ${p.saved ? 'disabled' : ''}>
      <span class="w">${escapeHtml(p.phrase)}</span><span class="n">×${p.count}</span>
      <span class="m" title="${escapeHtml(p.meaning)}">${escapeHtml(p.meaning)}</span></label>
      ${p.saved ? '<span class="tag">已在单词本</span>' : `<button class="knownBtn" data-text="${escapeHtml(p.phrase)}">认识</button>`}</li>`).join('')
    : '<li class="empty">没有找到常用短语</li>';
  summary.visibleWords = words;
}

async function addSelected() {
  const items = [];
  document.querySelectorAll('#summary input:checked:not(:disabled)').forEach((box) => {
    const i = Number(box.dataset.i);
    const base = { url: tab.url, title: tab.title, source: 'video' };
    if (box.dataset.kind === 'word') {
      const w = summary.visibleWords[i];
      items.push({ ...base, word: w.word, phonetic: w.phonetic, meaning: w.meaning, sentence: w.example });
    } else {
      const p = summary.phrases[i];
      items.push({ ...base, word: p.phrase, phonetic: '', meaning: p.meaning, sentence: p.example });
    }
  });
  if (!items.length) {
    $('addResult').textContent = '先勾选要加入的词';
    return;
  }
  const wordbook = await LLStore.addWords(items);
  $('bookCount').textContent = `(${Object.keys(wordbook).length})`;
  $('addResult').textContent = `已加入 ${items.length} 个`;
  document.querySelectorAll('#summary input:checked').forEach((box) => { box.checked = false; box.disabled = true; });
}

init();
