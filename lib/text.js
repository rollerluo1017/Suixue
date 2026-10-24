// 文本处理工具：分词、取句子、视频字幕统计。content script、后台和页面共用。
(function (root) {
  const WORD_RE = /[A-Za-z]+(?:['’][A-Za-z]+)?/g;

  // 统计视频高频词时忽略的功能词
  const STOPWORDS = new Set((
    "a an the and or but if so of to in on at by for with from up down out over under into onto about as " +
    "is am are was were be been being do does did done have has had having will would shall should can could " +
    "may might must i me my mine you your yours he him his she her hers it its we us our ours they them their " +
    "theirs this that these those there here what which who whom whose when where why how not no yes all any " +
    "some just than then too very also only own same such both each few more most other again further once " +
    "s t d ll m re ve don didn doesn isn aren wasn weren won wouldn couldn shouldn can't don't i'm it's " +
    "that's you're i've i'll he's she's we're they're let's oh uh um yeah okay ok gonna wanna got get go"
  ).split(/\s+/));

  function normalize(word) {
    return word.toLowerCase().replace(/’/g, "'");
  }

  // 返回 [{word, start, end}]，word 保持原样
  function tokenize(text) {
    const out = [];
    WORD_RE.lastIndex = 0;
    let m;
    while ((m = WORD_RE.exec(text))) out.push({ word: m[0], start: m.index, end: m.index + m[0].length });
    return out;
  }

  // 取 offset 所在的句子
  function sentenceAround(text, offset) {
    let start = offset, end = offset;
    while (start > 0 && !/[.!?。！？\n]/.test(text[start - 1])) start--;
    while (end < text.length && !/[.!?。！？\n]/.test(text[end])) end++;
    if (end < text.length) end++;
    return text.slice(start, end).replace(/\s+/g, ' ').trim().slice(0, 300);
  }

  // 大写开头且不在句首，多半是人名地名（句首的由调用方结合词典人名标记判断）
  function looksLikeProperNoun(text, token) {
    if (!/^[A-Z]/.test(token.word)) return false;
    const before = text.slice(0, token.start).trimEnd();
    if (!before) return false;
    return !/[.!?:;"“'‘(\[—-]$/.test(before);
  }

  // 用户名、网址、邮箱里的词：@silverfox、john_doe、user123、darkWolf、github.com/someone
  function looksLikeUsername(text, token) {
    let start = token.start;
    let end = token.end;
    while (start > 0 && !/\s/.test(text[start - 1])) start--;
    while (end < text.length && !/\s/.test(text[end])) end++;
    const chunk = text.slice(start, end).replace(/^[("'“‘\[]+|[)"'”’\],.!?:;]+$/g, '');
    if (/[@_#]/.test(chunk)) return true;
    if (/[A-Za-z][0-9]|[0-9][A-Za-z]/.test(chunk)) return true;
    if (/[a-z][A-Z]/.test(chunk)) return true;               // 驼峰写法
    if (/[A-Za-z][./][A-Za-z]/.test(chunk)) return true;     // 域名、路径
    return false;
  }

  root.LLText = { WORD_RE, STOPWORDS, normalize, tokenize, sentenceAround, looksLikeProperNoun, looksLikeUsername };
})(typeof self !== 'undefined' ? self : this);
