// 词汇量测试：按词频分段抽词，四选一，根据各段正确率估算词汇量。
const PER_BAND = 4;
let bands = [];
let questions = [];
let index = 0;
let correct = [];   // 每段答对数
let answered = [];  // 每段答题数

const $ = (id) => document.getElementById(id);
const shuffle = (arr) => {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
};

function buildQuestions() {
  return bands.flatMap((band, b) => shuffle(band.words).slice(0, PER_BAND).map(([word, meaning]) => {
    const others = shuffle(band.words.filter(([w, m]) => w !== word && m !== meaning)).slice(0, 3).map(([, m]) => m);
    return { band: b, word, meaning, options: shuffle([meaning, ...others]) };
  }));
}

function show(section) {
  for (const id of ['intro', 'quiz', 'result']) $(id).hidden = id !== section;
}

function start() {
  questions = buildQuestions();
  index = 0;
  correct = bands.map(() => 0);
  answered = bands.map(() => 0);
  show('quiz');
  renderQuestion();
}

function renderQuestion() {
  const q = questions[index];
  $('bar').style.width = (index / questions.length) * 100 + '%';
  $('word').textContent = q.word;
  const box = $('options');
  box.innerHTML = '';
  for (const option of [...q.options, null]) {
    const btn = document.createElement('button');
    btn.textContent = option === null ? '不认识' : option;
    if (option === null) btn.className = 'skip';
    btn.onclick = () => answer(option, btn);
    box.appendChild(btn);
  }
}

function answer(option, btn) {
  const q = questions[index];
  const ok = option === q.meaning;
  answered[q.band]++;
  if (ok) correct[q.band]++;
  const buttons = [...$('options').children];
  buttons.forEach((b) => { b.disabled = true; if (b.textContent === q.meaning) b.classList.add('right'); });
  if (!ok && option !== null) btn.classList.add('wrong');
  setTimeout(next, ok ? 350 : 900);
}

function bandDone(b) {
  return answered[b] === PER_BAND;
}

function next() {
  const q = questions[index];
  index++;
  // 连续两段都只答对一题以内，后面更难的段就不用测了
  if (bandDone(q.band) && q.band > 0 && correct[q.band] <= 1 && correct[q.band - 1] <= 1) return finish();
  if (index >= questions.length) return finish();
  renderQuestion();
}

function estimate() {
  let total = 0;
  bands.forEach((band, b) => {
    if (!answered[b]) return;
    total += (band.to - band.from + 1) * (correct[b] / answered[b]);
  });
  return Math.max(500, Math.round(total / 100) * 100);
}

function finish() {
  const vocab = estimate();
  $('vocab').textContent = vocab.toLocaleString();
  const right = correct.reduce((a, b) => a + b, 0);
  const asked = answered.reduce((a, b) => a + b, 0);
  $('detail').textContent = `共答 ${asked} 题，答对 ${right} 题。`;
  $('level').value = vocab;
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

fetch('../data/testpool.json').then((r) => r.json()).then((pool) => { bands = pool; });
