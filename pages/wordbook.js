const $ = (id) => document.getElementById(id);
let wordbook = {};

function escapeHtml(s) {
  return String(s || '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}
function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function markWord(sentence, word) {
  const safe = escapeHtml(sentence);
  // 短语整体匹配；单词用词干匹配，这样 studies 也能标出 study
  const pattern = word.includes(' ')
    ? escapeRe(escapeHtml(word))
    : `${escapeRe(escapeHtml(word.slice(0, Math.max(3, word.length - 2))))}[a-z]*`;
  return safe.replace(new RegExp(`\\b(${pattern})`, 'i'), '<mark>$1</mark>');
}

function render() {
  const q = $('search').value.trim().toLowerCase();
  const source = $('source').value;
  const items = Object.values(wordbook)
    .filter((it) => !source || it.source === source)
    .filter((it) => !q || it.word.includes(q) || (it.meaning || '').includes(q))
    .sort((a, b) => b.addedAt - a.addedAt);
  $('count').textContent = `(${Object.keys(wordbook).length})`;
  $('empty').hidden = Object.keys(wordbook).length > 0;
  $('list').innerHTML = items.map((it) => `
    <div class="item">
      <div class="main">
        <div class="head">
          <span class="w">${escapeHtml(it.word)}</span>
          ${it.phonetic ? `<span class="ph">/${escapeHtml(it.phonetic)}/</span>` : ''}
          <span class="badge">${it.source === 'video' ? '视频' : '阅读'}</span>
        </div>
        <div>${escapeHtml(it.meaning)}</div>
        ${it.sentence ? `<div class="sentence">${markWord(it.sentence, it.word)}</div>` : ''}
        <div class="meta">${new Date(it.addedAt).toLocaleDateString()} ·
          <a href="${escapeHtml(it.url)}" target="_blank" rel="noopener">${escapeHtml(it.title || it.url)}</a></div>
      </div>
      <button class="del" data-word="${escapeHtml(it.word)}">删除</button>
    </div>`).join('');
}

async function renderKnown() {
  const known = (await LLStore.getKnown()).sort();
  $('knownCount').textContent = `(${known.length})`;
  $('knownList').innerHTML = known.map((w) => `<button data-word="${escapeHtml(w)}" title="点击撤销">${escapeHtml(w)} ×</button>`).join('');
}

function csvCell(v) {
  return `"${String(v || '').replace(/"/g, '""')}"`;
}

$('export').onclick = () => {
  const header = ['单词', '音标', '释义', '例句', '来源', '网址', '加入时间'];
  const rows = Object.values(wordbook).sort((a, b) => a.addedAt - b.addedAt).map((it) => [
    it.word, it.phonetic, it.meaning, it.sentence, it.source === 'video' ? '视频' : '阅读', it.url,
    new Date(it.addedAt).toLocaleString(),
  ]);
  const csv = '﻿' + [header, ...rows].map((r) => r.map(csvCell).join(',')).join('\r\n');
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
  a.download = `单词本-${new Date().toISOString().slice(0, 10)}.csv`;
  a.click();
};

$('list').onclick = async (e) => {
  const btn = e.target.closest('.del');
  if (!btn) return;
  await LLStore.removeWord(btn.dataset.word);
};
$('knownList').onclick = async (e) => {
  const btn = e.target.closest('button');
  if (btn) await LLStore.setKnown(btn.dataset.word, false);
};
$('search').oninput = render;
$('source').onchange = render;

chrome.storage.onChanged.addListener(async (changes) => {
  if (changes.wordbook) { wordbook = changes.wordbook.newValue || {}; render(); }
  if (changes.known) renderKnown();
});

(async () => {
  wordbook = await LLStore.getWordbook();
  render();
  renderKnown();
})();
