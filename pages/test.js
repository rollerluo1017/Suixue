// 词汇量测试：自适应出题（见 vocab-model.js），每题五选一，干扰项与正确答案同词性、难度相近。
let pool = [];   // [单词, 排名, 词性, 释义]，按排名排序
let ranks = [];
let model = null;
let used = new Set();
let current = null;

const $ = (id) => document.getElementById(id);
const shuffle = (arr) => {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
};

function indexOfRank(rank) {
  let lo = 0;
  let hi = ranks.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (ranks[mid] < rank) lo = mid + 1; else hi = mid;
  }
  return lo;
}

// 在目标排名附近挑一个没考过的词
function pickWord(rank) {
  const center = indexOfRank(rank);
  const near = [];
  for (let d = 0; near.length < 8 && d < 300; d++) {
    for (const j of [center + d, center - d - 1]) {
      if (j >= 0 && j < pool.length && !used.has(j)) near.push(j);
    }
  }
  const j = near[Math.floor(Math.random() * near.length)];
  used.add(j);
  return pool[j];
}

// 干扰项：同词性、排名在一半到两倍之间、释义不重复
function distractors([word, rank, pos, meaning]) {
  const lo = indexOfRank(rank / 2);
  const hi = indexOfRank(rank * 2);
  const seen = new Set([meaning]);
  const out = [];
  for (const j of shuffle(Array.from({ length: hi - lo }, (_, k) => lo + k))) {
    const [w, , p, m] = pool[j];
    if (w === word || p !== pos || seen.has(m)) continue;
    seen.add(m);
    out.push(m);
    if (out.length === 4) break;
  }
  return out;
}

function show(section) {
  for (const id of ['intro', 'quiz', 'result']) $(id).hidden = id !== section;
}

function start() {
  model = VocabModel.create();
  used = new Set();
  show('quiz');
  nextQuestion();
}

function nextQuestion() {
  if (VocabModel.isDone(model)) return finish();
  const [word, rank, pos, meaning] = pickWord(VocabModel.nextRank(model));
  current = { word, rank, meaning };
  const n = model.answers.length;
  $('bar').style.width = Math.min(100, (n / VocabModel.MAX_QUESTIONS) * 100) + '%';
  $('count').textContent = `第 ${n + 1} 题`;
  $('word').textContent = word;
  const box = $('options');
  box.innerHTML = '';
  for (const option of [...shuffle([meaning, ...distractors([word, rank, pos, meaning])]), null]) {
    const btn = document.createElement('button');
    btn.textContent = option === null ? '不认识' : option;
    if (option === null) btn.className = 'skip';
    btn.onclick = () => answer(option, btn);
    box.appendChild(btn);
  }
}

function answer(option, btn) {
  const ok = option === current.meaning;
  VocabModel.update(model, current.rank, ok);
  const buttons = [...$('options').children];
  buttons.forEach((b) => { b.disabled = true; if (b.textContent === current.meaning) b.classList.add('right'); });
  if (!ok && option !== null) btn.classList.add('wrong');
  setTimeout(nextQuestion, ok ? 300 : 800);
}

const round = (v) => Math.max(100, Math.round(v / 100) * 100);

function finish() {
  const s = VocabModel.summary(model);
  $('vocab').textContent = round(s.vocab).toLocaleString();
  $('range').textContent = `${round(s.vocabLow).toLocaleString()} ～ ${round(s.vocabHigh).toLocaleString()}`;
  const right = model.answers.filter((a) => a.correct).length;
  $('detail').textContent = `共答 ${model.answers.length} 题，答对 ${right} 题。`;
  const level = Math.min(30000, Math.max(500, Math.round(s.level / 100) * 100));
  $('level').value = level;
  updateLevelText();
  $('saved').hidden = true;
  show('result');
}

function updateLevelText() {
  $('levelText').textContent = Number($('level').value).toLocaleString();
}

$('start').onclick = start;
$('retry').onclick = start;
$('level').oninput = updateLevelText;
$('save').onclick = async () => {
  await LLStore.saveSettings({ level: Number($('level').value), testedAt: Date.now() });
  $('saved').hidden = false;
};

fetch('../data/testpool.json').then((r) => r.json()).then((data) => {
  pool = data;
  ranks = data.map((x) => x[1]);
});
