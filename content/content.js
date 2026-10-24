// 网页内功能：生词高亮、悬停释义、划词加入单词本、收集视频字幕。
(() => {
  if (window.__llLoaded) return;
  window.__llLoaded = true;

  const { tokenize, normalize, sentenceAround, looksLikeProperNoun, looksLikeUsername } = LLText;
  // 插件被重新加载或更新后，旧页面里的这份脚本就和插件断开了，调用 chrome.* 会报错。
  // 这时停掉自己，等用户刷新页面再用新脚本。
  const alive = () => { try { return !!chrome.runtime.id; } catch (e) { return false; } };
  let stopped = false;
  function shutdown() {
    if (stopped) return;
    stopped = true;
    observer.disconnect();
    clearInterval(captionTimer);
    host.remove();
  }
  const send = (msg) => {
    if (!alive()) { shutdown(); return Promise.resolve(null); }
    return chrome.runtime.sendMessage(msg).catch(() => null);
  };
  // 用户名、作者署名这类区域整块跳过
  const NAME_AREAS = '[class*="username" i],[class*="user-name" i],[class*="author" i],[class*="nickname" i],[class*="handle" i],[class*="screen-name" i],[class*="byline" i],[itemprop="author"],[rel="author"],a[href^="/@"],a[href*="/user/"],a[href*="/u/"],a[data-hovercard-type="user"]';
  const SKIP = 'script,style,noscript,textarea,input,select,code,pre,kbd,samp,svg,math,button,[contenteditable=""],[contenteditable="true"],ll-w,#ll-root,' + NAME_AREAS;
  const BLOCK = 'p,li,td,th,dd,dt,h1,h2,h3,h4,h5,h6,blockquote,figcaption,article,section,div';

  let settings = null;
  let known = new Set();
  let wordbook = {};
  const rankCache = new Map(); // 小写单词 -> [排名, 原形, 人名标记] | null
  const pageNames = new Set();  // 本页在句中以大写出现过的词，句首出现时也当人名

  // ---------- 生词高亮 ----------

  function highlightOn() {
    return settings && settings.highlight && settings.level && !settings.disabledSites.includes(location.hostname);
  }

  function isHard(lower) {
    const hit = rankCache.get(lower);
    if (!hit) return false;
    const [rank, base, name] = hit;
    return name !== 2 && rank > settings.level && !known.has(base) && !known.has(lower);
  }

  // 人名、用户名不算生词
  function isNameToken(text, t) {
    if (looksLikeUsername(text, t)) return true;
    if (!/^[A-Z]/.test(t.word)) return false;
    const lower = normalize(t.word);
    if (looksLikeProperNoun(text, t)) {
      pageNames.add(lower);
      return true;
    }
    const hit = rankCache.get(lower);
    return pageNames.has(lower) || !!(hit && hit[2]);
  }

  function textNodesIn(root) {
    const nodes = [];
    if (root.nodeType === Node.TEXT_NODE) {
      if (root.parentElement && !root.parentElement.closest(SKIP)) nodes.push(root);
      return nodes;
    }
    if (root.nodeType !== Node.ELEMENT_NODE || root.closest(SKIP)) return nodes;
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        if (!/[A-Za-z]{2}/.test(node.nodeValue)) return NodeFilter.FILTER_REJECT;
        const parent = node.parentElement;
        return parent && !parent.closest(SKIP) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT;
      },
    });
    while (walker.nextNode()) nodes.push(walker.currentNode);
    return nodes;
  }

  async function lookupWords(words) {
    const missing = [...new Set(words)].filter((w) => !rankCache.has(w));
    if (!missing.length) return;
    for (let i = 0; i < missing.length; i += 2000) {
      const batch = missing.slice(i, i + 2000);
      const res = (await send({ type: 'lookupMany', words: batch })) || {};
      for (const w of batch) rankCache.set(w, res[w] || null);
    }
  }

  function wrapNode(node) {
    if (!node.isConnected) return;
    const text = node.nodeValue;
    const hard = tokenize(text).filter((t) => isHard(normalize(t.word)) && !isNameToken(text, t));
    if (!hard.length) return;
    const frag = document.createDocumentFragment();
    let pos = 0;
    for (const t of hard) {
      frag.append(text.slice(pos, t.start));
      const el = document.createElement('ll-w');
      const lower = normalize(t.word);
      el.dataset.w = lower;
      if (wordbook[rankCache.get(lower)[1]] || wordbook[lower]) el.className = 'll-saved';
      el.textContent = t.word;
      frag.append(el);
      pos = t.end;
    }
    frag.append(text.slice(pos));
    node.replaceWith(frag);
  }

  const idle = () => new Promise((r) => (window.requestIdleCallback || setTimeout)(r));

  async function highlightIn(roots) {
    if (!highlightOn()) return;
    const nodes = roots.flatMap(textNodesIn);
    if (!nodes.length) return;
    await lookupWords(nodes.flatMap((n) => tokenize(n.nodeValue).map((t) => normalize(t.word))));
    for (const n of nodes) {
      for (const t of tokenize(n.nodeValue)) if (looksLikeProperNoun(n.nodeValue, t)) pageNames.add(normalize(t.word));
    }
    for (let i = 0; i < nodes.length; i += 200) {
      queueMutations();
      nodes.slice(i, i + 200).forEach(wrapNode);
      observer.takeRecords(); // 丢掉自己改动产生的变化
      await idle();
    }
  }

  function unhighlight(filter) {
    const parents = new Set();
    document.querySelectorAll('ll-w').forEach((el) => {
      if (filter && !filter(el)) return;
      parents.add(el.parentNode);
      el.replaceWith(el.textContent);
    });
    parents.forEach((p) => p && p.normalize());
    observer.takeRecords();
  }

  // 网页动态加载的新内容
  let pending = [];
  let timer = null;
  function onMutations(records) {
    for (const r of records) {
      r.addedNodes.forEach((n) => {
        if (n.nodeName !== 'LL-W' && !(n.id === 'll-root')) pending.push(n);
      });
    }
    if (pending.length && !timer) {
      timer = setTimeout(() => {
        timer = null;
        const roots = pending.filter((n) => n.isConnected);
        pending = [];
        highlightIn(roots);
      }, 600);
    }
  }
  function queueMutations() {
    onMutations(observer.takeRecords());
  }
  const observer = new MutationObserver(onMutations);

  // ---------- 释义卡片 ----------

  const host = document.createElement('div');
  host.id = 'll-root';
  const shadow = host.attachShadow({ mode: 'open' });
  shadow.innerHTML = `<link rel="stylesheet" href="${chrome.runtime.getURL('content/card.css')}">
    <div class="card" hidden></div><button class="bubble" hidden>查词</button>`;
  const card = shadow.querySelector('.card');
  const bubble = shadow.querySelector('.bubble');
  let hideTimer = null;
  let current = null; // {info, sentence}

  function ensureHost() {
    if (!host.isConnected) document.documentElement.appendChild(host);
  }

  function place(el, rect) {
    const top = rect.bottom + 8 + window.scrollY;
    const left = Math.max(8, Math.min(rect.left + window.scrollX, window.scrollX + document.documentElement.clientWidth - 320));
    el.style.top = top + 'px';
    el.style.left = left + 'px';
  }

  function escapeHtml(s) {
    return String(s || '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  }

  function renderCard(info, sentence, rect) {
    ensureHost();
    current = { info, sentence };
    const word = info.phrase ? info.word : info.base;
    const saved = !!wordbook[word.toLowerCase()];
    const parts = (info.parts || []).map((p) => `<div class="part"><b>${escapeHtml(p.base)}</b> ${escapeHtml(p.meaning)}</div>`).join('');
    card.innerHTML = `
      <div class="head"><span class="word">${escapeHtml(word)}</span>
        ${info.phonetic ? `<span class="ph">/${escapeHtml(info.phonetic)}/</span>` : ''}</div>
      ${info.word !== info.base && !info.phrase ? `<div class="form">${escapeHtml(info.word)} 是 ${escapeHtml(info.base)} 的变形</div>` : ''}
      ${info.meaning ? `<div class="meaning">${escapeHtml(info.meaning)}</div>` : ''}
      ${info.baseMeaning ? `<div class="meaning sub">${escapeHtml(info.base)}：${escapeHtml(info.baseMeaning)}</div>` : ''}
      ${parts}
      ${!info.meaning && !parts ? '<div class="meaning sub">词典里没有找到这个词</div>' : ''}
      <div class="actions">
        <button class="add" ${saved ? 'disabled' : ''}>${saved ? '已在单词本' : '加入单词本'}</button>
        ${!info.phrase ? '<button class="known">我认识</button>' : ''}
      </div>`;
    card.hidden = false;
    place(card, rect);
  }

  function hideCard() {
    card.hidden = true;
    current = null;
  }

  // 找到元素所在段落，取出包含 offset 位置的句子
  function sentenceFor(range) {
    const node = range.startContainer;
    const el = node.nodeType === Node.ELEMENT_NODE ? node : node.parentElement;
    const block = (el && el.closest(BLOCK)) || document.body;
    const pre = document.createRange();
    pre.setStart(block, 0);
    pre.setEnd(range.startContainer, range.startOffset);
    return sentenceAround(block.textContent, pre.toString().length);
  }

  card.addEventListener('click', async (e) => {
    if (!current) return;
    if (!alive()) return shutdown();
    const btn = e.target.closest('button');
    if (!btn) return;
    const { info, sentence } = current;
    if (btn.classList.contains('add')) {
      const word = info.phrase ? info.word : info.base;
      wordbook = await LLStore.addWords([{
        word: word.toLowerCase(),
        phonetic: info.phonetic || '',
        meaning: info.meaning || (info.parts || []).map((p) => `${p.base} ${p.meaning}`).join('；'),
        sentence, url: location.href, title: document.title, source: 'reading',
      }]);
      btn.textContent = '已加入';
      btn.disabled = true;
    } else if (btn.classList.contains('known')) {
      await LLStore.setKnown(info.base, true);
      hideCard();
    }
  });
  card.addEventListener('mouseenter', () => clearTimeout(hideTimer));
  card.addEventListener('mouseleave', () => { hideTimer = setTimeout(hideCard, 300); });

  let hoverTimer = null;
  document.addEventListener('mouseover', (e) => {
    const el = e.target.closest && e.target.closest('ll-w');
    if (!el) return;
    clearTimeout(hideTimer);
    clearTimeout(hoverTimer);
    hoverTimer = setTimeout(async () => {
      const info = await send({ type: 'define', text: el.textContent });
      if (!info || info.error) return;
      const range = document.createRange();
      range.selectNodeContents(el);
      renderCard(info, sentenceFor(range), el.getBoundingClientRect());
    }, 250);
  });
  document.addEventListener('mouseout', (e) => {
    if (e.target.closest && e.target.closest('ll-w')) {
      clearTimeout(hoverTimer);
      hideTimer = setTimeout(hideCard, 300);
    }
  });

  // ---------- 划词 ----------

  let selection = null; // {text, sentence, rect}
  document.addEventListener('mouseup', (e) => {
    if (e.composedPath().includes(host)) return;
    setTimeout(() => {
      const sel = window.getSelection();
      const text = sel && sel.toString().trim();
      if (!text || text.length > 80 || !/[A-Za-z]/.test(text) || text.split(/\s+/).length > 6) {
        bubble.hidden = true;
        return;
      }
      const range = sel.getRangeAt(0);
      const rect = range.getBoundingClientRect();
      selection = { text, sentence: sentenceFor(range), rect };
      ensureHost();
      bubble.hidden = false;
      bubble.style.top = rect.top + window.scrollY - 34 + 'px';
      bubble.style.left = rect.left + window.scrollX + rect.width / 2 - 24 + 'px';
    }, 10);
  });
  document.addEventListener('mousedown', (e) => {
    if (e.composedPath().includes(host)) return;
    bubble.hidden = true;
    if (!card.hidden) hideCard();
  });
  bubble.addEventListener('mousedown', (e) => e.preventDefault()); // 保持选区
  bubble.addEventListener('click', async () => {
    bubble.hidden = true;
    if (!selection) return;
    const info = await send({ type: 'define', text: selection.text });
    renderCard(info || { word: selection.text, base: selection.text, phrase: true, meaning: '' }, selection.sentence, selection.rect);
  });

  // ---------- 视频字幕 ----------

  const video = { el: null, href: location.href, lines: new Map() };

  function resetIfNavigated() {
    if (video.href !== location.href) {
      video.href = location.href;
      video.lines.clear();
      video.el = null;
    }
  }

  function addLine(raw) {
    const t = String(raw).replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();
    if (t && /[A-Za-z]{2}/.test(t) && !video.lines.has(t)) video.lines.set(t, video.lines.size);
  }

  function readTracks(v) {
    const tracks = [...v.textTracks].filter((t) => t.kind === 'subtitles' || t.kind === 'captions');
    const english = tracks.filter((t) => /^en/i.test(t.language));
    for (const track of english.length ? english : tracks) {
      if (track.__ll) continue;
      track.__ll = true;
      if (track.mode === 'disabled') track.mode = 'hidden';
      const grab = () => { if (track.cues) for (const c of track.cues) addLine(c.text); };
      grab();
      track.addEventListener('cuechange', grab);
      v.querySelectorAll('track').forEach((el) => { if (el.track === track) el.addEventListener('load', grab); });
    }
  }

  document.addEventListener('play', (e) => {
    if (!(e.target instanceof HTMLVideoElement)) return;
    resetIfNavigated();
    video.el = e.target;
    readTracks(e.target);
    e.target.textTracks.addEventListener('addtrack', () => readTracks(e.target));
  }, true);

  // 播放器下载的字幕文件（YouTube、B 站等）
  window.addEventListener('message', (e) => {
    if (e.source !== window || !e.data || e.data.source !== 'll-capture') return;
    resetIfNavigated();
    parseSubtitle(e.data.body || '');
  });

  function parseSubtitle(body) {
    try {
      const json = JSON.parse(body);
      if (Array.isArray(json.events)) {
        for (const ev of json.events) if (ev.segs) addLine(ev.segs.map((s) => s.utf8 || '').join(''));
      } else if (Array.isArray(json.body)) {
        for (const item of json.body) addLine(item.content || '');
      }
      return;
    } catch (e) {}
    if (body.includes('-->')) {
      for (const block of body.split(/\r?\n\r?\n/)) {
        const lines = block.split(/\r?\n/).filter((l) => l && !l.includes('-->') && !/^(\d+|WEBVTT.*|NOTE.*)$/.test(l.trim()));
        if (lines.length) addLine(lines.join(' '));
      }
    } else if (body.includes('<text') || body.includes('<p ')) {
      const doc = new DOMParser().parseFromString(body, 'text/xml');
      doc.querySelectorAll('text, p').forEach((n) => addLine(n.textContent));
    }
  }

  // 兜底：直接读屏幕上显示的字幕
  const CAPTION_SELECTORS = '.ytp-caption-segment, .bpx-player-subtitle-panel-text, .bili-subtitle-x-subtitle-panel-text, .vjs-text-track-cue, .plyr__caption';
  const captionTimer = setInterval(() => {
    if (!alive()) return shutdown();
    if (!video.el || video.el.paused) return;
    resetIfNavigated();
    const segs = [...document.querySelectorAll(CAPTION_SELECTORS)].map((n) => n.textContent).join(' ');
    if (segs.trim()) addLine(segs);
  }, 1000);

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    resetIfNavigated();
    document.querySelectorAll('video').forEach(readTracks); // 还没播放的视频也读一下字幕轨
    if (msg.type === 'videoStatus') {
      const v = video.el || document.querySelector('video');
      sendResponse({
        found: !!v,
        playing: !!(v && !v.paused),
        title: document.title,
        url: location.href,
        lineCount: video.lines.size,
      });
    } else if (msg.type === 'videoLines') {
      sendResponse([...video.lines.keys()]);
    }
  });

  // ---------- 启动 ----------

  async function refreshAll() {
    unhighlight();
    if (highlightOn()) await highlightIn([document.body]);
  }

  chrome.storage.onChanged.addListener((changes) => {
    if (changes.wordbook) {
      wordbook = changes.wordbook.newValue || {};
      document.querySelectorAll('ll-w').forEach((el) => {
        const base = (rankCache.get(el.dataset.w) || [])[1];
        el.classList.toggle('ll-saved', !!(wordbook[base] || wordbook[el.dataset.w]));
      });
    }
    if (changes.known) {
      known = new Set(changes.known.newValue || []);
      unhighlight((el) => known.has(el.dataset.w) || known.has((rankCache.get(el.dataset.w) || [])[1]));
    }
    if (changes.settings) {
      settings = { ...settings, ...changes.settings.newValue };
      refreshAll();
    }
  });

  (async () => {
    [settings, wordbook] = await Promise.all([LLStore.getSettings(), LLStore.getWordbook()]);
    known = new Set(await LLStore.getKnown());
    if (!document.body) return;
    observer.observe(document.body, { childList: true, subtree: true });
    if (highlightOn()) highlightIn([document.body]);
  })();
})();
