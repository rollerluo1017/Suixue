// 词汇量估算模型（自适应测试）。
// 假设「认识某个词的概率」随词频排名下降：p = 1 / (1 + (排名 / T)^a)，
// T 是认识一半的排名（生词标准），a 是下降的陡峭程度。另外估计答题人「不认识时蒙对」的概率 g。
// 每答一题更新 (T, a, g) 的后验分布，下一题选在最能缩小词汇量不确定性的排名上。
(function (root) {
  const SLOPES = [1.5, 2, 3, 4, 6];
  const GUESSES = [0.04, 0.12, 0.25];
  const STEPS = 120;
  const THETA_MIN = Math.log(200);
  const THETA_MAX = Math.log(40000);
  const THETAS = Array.from({ length: STEPS }, (_, i) => THETA_MIN + ((THETA_MAX - THETA_MIN) * i) / (STEPS - 1));
  const PRIOR_MEAN = Math.log(4000);
  const PRIOR_SD = 1.3;
  const SLIP = 0.04; // 认识却答错的概率（手滑、释义不熟）
  const MAX_RANK = 50000;
  // 备选出题排名：对数均匀分布
  const CANDIDATE_RANKS = Array.from({ length: 24 }, (_, i) => Math.round(Math.exp(Math.log(60) + (Math.log(35000) - Math.log(60)) * i / 23)));

  // 所有参数组合摊平成一维，方便计算
  const STATES = [];
  SLOPES.forEach((a) => GUESSES.forEach((g) => THETAS.forEach((t) => STATES.push({ a, g, t }))));

  function pKnow(rank, theta, a) {
    return 1 / (1 + Math.exp(a * (Math.log(rank) - theta)));
  }
  function pRight(rank, s) {
    const p = pKnow(rank, s.t, s.a);
    return p * (1 - SLIP) + (1 - p) * s.g;
  }

  // 认识的词数 = 对所有排名求「认识概率」之和（按对数排名积分）
  function vocabFor(theta, a) {
    let sum = 0;
    const n = 200;
    const du = Math.log(MAX_RANK) / n;
    for (let k = 0; k < n; k++) {
      const u = (k + 0.5) * du;
      sum += pKnow(Math.exp(u), theta, a) * Math.exp(u) * du;
    }
    return sum;
  }
  const LOG_VOCAB = STATES.map((s) => Math.log(vocabFor(s.t, s.a)));
  const PRIOR = STATES.map((s) => -0.5 * ((s.t - PRIOR_MEAN) / PRIOR_SD) ** 2 + (s.g === 0.12 ? Math.log(1.5) : 0));

  function create() {
    return { logPost: PRIOR.slice(), answers: [] };
  }

  function update(state, rank, correct) {
    state.answers.push({ rank, correct });
    STATES.forEach((s, i) => {
      const p = pRight(rank, s);
      state.logPost[i] += Math.log(correct ? p : 1 - p);
    });
  }

  function weights(logPost) {
    let max = -Infinity;
    for (const v of logPost) if (v > max) max = v;
    let total = 0;
    const w = logPost.map((v) => { const e = Math.exp(v - max); total += e; return e; });
    return w.map((v) => v / total);
  }

  function variance(w, values) {
    let m = 0;
    let sq = 0;
    w.forEach((p, i) => { m += p * values[i]; sq += p * values[i] * values[i]; });
    return Math.max(0, sq - m * m);
  }

  function quantile(w, values, q) {
    const idx = values.map((_, i) => i).sort((x, y) => values[x] - values[y]);
    let acc = 0;
    for (const i of idx) { acc += w[i]; if (acc >= q) return values[i]; }
    return values[idx[idx.length - 1]];
  }

  function summary(state) {
    const w = weights(state.logPost);
    const thetas = STATES.map((s) => s.t);
    return {
      vocabSd: Math.sqrt(variance(w, LOG_VOCAB)),
      level: Math.exp(quantile(w, thetas, 0.5)),            // 认识一半的排名，用作生词标准
      vocab: Math.exp(quantile(w, LOG_VOCAB, 0.5)),          // 估计词汇量
      vocabLow: Math.exp(quantile(w, LOG_VOCAB, 0.1)),
      vocabHigh: Math.exp(quantile(w, LOG_VOCAB, 0.9)),
    };
  }

  // 选下一题的排名：哪个排名答完后，词汇量估计的方差预期最小
  function nextRank(state, random = Math.random) {
    const w = weights(state.logPost);
    let best = null;
    for (const rank of CANDIDATE_RANKS) {
      let pr = 0;
      const right = new Array(STATES.length);
      STATES.forEach((s, i) => { right[i] = pRight(rank, s); pr += w[i] * right[i]; });
      const wR = w.map((p, i) => (p * right[i]) / pr);
      const wW = w.map((p, i) => (p * (1 - right[i])) / (1 - pr));
      const expected = pr * variance(wR, LOG_VOCAB) + (1 - pr) * variance(wW, LOG_VOCAB);
      if (!best || expected < best.expected) best = { rank, expected };
    }
    // 在最佳排名附近随机取，避免每次考同样的词
    return best.rank * Math.exp((random() * 2 - 1) * 0.15);
  }

  const MIN_QUESTIONS = 25;
  const MAX_QUESTIONS = 45;
  function isDone(state) {
    const n = state.answers.length;
    if (n >= MAX_QUESTIONS) return true;
    return n >= MIN_QUESTIONS && summary(state).vocabSd < 0.12;
  }

  root.VocabModel = { create, update, summary, nextRank, isDone, MIN_QUESTIONS, MAX_QUESTIONS };
})(typeof self !== 'undefined' ? self : this);
