"""从 ECDICT (https://github.com/skywind3000/ECDICT, MIT) 生成插件用的离线数据。

用法: python3 tools/build_data.py path/to/ecdict.csv
输出: data/dict.json  单词 -> [词频排名, 音标, 中文释义] 或 [..., 人名标记]
                    人名标记 1: 也常用作人名（大写时不当生词）；2: 只是人名（永远不当生词）
      data/lemma.json 变形 -> 原形 (went -> go)
      data/phrases.json 短语 -> [中文释义, 难度]  难度: 0 太常见, 1 动词短语/习语, 2 普通搭配
      data/testpool.json 词汇量测试题库 [单词, 排名, 词性, 释义]，按排名排序
"""
import csv, json, os, re, sys

UNRANKED = 60000
# 各类考试词表大致对应的词频排名，用来剔除难度和词频不一致的测试词
TAG_LEVEL = {'zk': 1500, 'gk': 3500, 'cet4': 4500, 'cet6': 7000, 'ky': 6500,
             'ielts': 8000, 'toefl': 8000, 'gre': 13000}
# 动词 + 这些小品词，通常是意思不能从字面推出来的动词短语 (give up, pay off)
PARTICLES = {'up', 'down', 'off', 'out', 'over', 'away', 'back', 'through', 'around', 'round',
             'along', 'apart', 'aside', 'forward', 'in', 'on', 'into', 'across', 'by'}  # 没有词频的考试词，按很生僻处理
WORD_RE = re.compile(r"[a-z][a-z'-]*")
PHRASE_RE = re.compile(r"[a-z][a-z']*( [a-z][a-z']*){1,3}")
NAME_RE = re.compile(r"人名|姓氏|地名|男子名|女子名|城市|品牌|[(（]\s*[A-Z]")
POS_RE = re.compile(r"^(n|v|vt|vi|adj|a|adv|prep|conj|pron|num|int|art|aux)\.")


def clean_translation(tr, max_lines=2, max_len=60):
    lines = [l.strip() for l in tr.replace('\\n', '\n').split('\n')]
    lines = [l for l in lines if l and not l.startswith('[网络]')]
    out = '；'.join(lines[:max_lines])
    return out[:max_len] + ('…' if len(out) > max_len else '')


def short_meaning(tr):
    """测试选项用：第一行去掉词性，取前两个义项。"""
    first = clean_translation(tr, 1, 200)
    first = re.sub(r"^[a-z]+\.\s*", "", first)
    first = re.split(r"\b[a-z]+\.", first)[0]  # 只取第一个词性下的义项
    first = re.sub(r"\[[^\]]*\]|\([^)]*\)|（[^）]*）", "", first)
    parts = [p.strip() for p in re.split(r"[；;,，]", first) if p.strip()]
    return '，'.join(dict.fromkeys(parts[:2]))


def main(src):
    root = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'data')
    os.makedirs(root, exist_ok=True)
    words, lemma, phrases, rows, names = {}, {}, {}, [], set()  # names: 不适合出测试题的词
    tags = {}
    here = os.path.dirname(os.path.abspath(__file__))
    common_names = {l.strip() for l in open(os.path.join(here, 'names.txt'), encoding='utf-8')
                    if l.strip() and not l.startswith('#')}
    for row in csv.DictReader(open(src, encoding='utf-8')):
        rows.append(row)
        w, tr = row['word'], row['translation']
        if not tr or not WORD_RE.fullmatch(w):
            continue
        rank = int(row['frq'] or 0) or int(row['bnc'] or 0)
        if not rank and not row['tag']:
            continue
        meaning = clean_translation(tr)
        if not meaning:
            continue
        words[w] = [rank or UNRANKED, row['phonetic'], meaning]
        senses = [x for x in re.split(r'[；\n]', tr.replace('\\n', '\n')) if x.strip() and not x.strip().startswith('[网络]')]
        if senses and all(NAME_RE.search(x) for x in senses):
            words[w].append(2)
        elif w in common_names or NAME_RE.search(tr):
            words[w].append(1)
        if row['tag']:
            tags[w] = row['tag'].split()
        if NAME_RE.search(tr) or not (row['tag'] or row['collins'] or row['oxford']):
            names.add(w)
        for item in (row['exchange'] or '').split('/'):
            if ':' not in item:
                continue
            kind, form = item.split(':', 1)
            if kind in 'pdi3rst' and form != w and WORD_RE.fullmatch(form):
                lemma.setdefault(form, w)

    easy = {l.strip() for l in open(os.path.join(os.path.dirname(os.path.abspath(__file__)), 'easy_phrases.txt'), encoding='utf-8')
            if l.strip() and not l.startswith('#')}
    verbs = {w for w, (_, _, m, *_) in words.items() if re.match(r'^(v|vt|vi)\.', m) or re.search(r'；(v|vt|vi)\.', m)}
    for row in rows:
        w, tr = row['word'], row['translation']
        if not tr or not PHRASE_RE.fullmatch(w) or tr.lstrip().startswith('['):
            continue
        if all(words.get(t, [UNRANKED])[0] <= 5000 for t in w.split()):
            meaning = clean_translation(tr, 1, 40)
            if not meaning:
                continue
            tokens = w.split()
            if w in easy or row['oxford'] == '1':
                kind = 0
            elif row['tag'] or (lemma.get(tokens[0], tokens[0]) in verbs and tokens[1] in PARTICLES) or len(tokens) >= 3:
                kind = 1
            else:
                kind = 2
            phrases[w] = [meaning, kind]
    # 变形本身也可能是词条 (rose)，查词时取两者中更常用的排名
    lemma = {k: v for k, v in lemma.items() if v in words}

    # 词汇量测试题库：词频排名 1～35000 连续取词，记下词性，方便出同词性的干扰项
    def root_rank(w):
        """派生词 (determinedly, kindness) 的词根排名；词根简单的话这个词不适合测水平。"""
        best = UNRANKED
        for suf in ('ly', 'ness', 'ment', 'ity', 'ful', 'less', 'able', 'er', 'ist', 'ism', 'ize', 'ise'):
            if w.endswith(suf) and len(w) - len(suf) >= 3:
                stem = w[:-len(suf)]
                for root in (stem, stem + 'e', stem[:-1] + 'y' if stem.endswith('i') else stem, stem[:-1] if stem[-1:] == stem[-2:-1] else stem):
                    if root in words:
                        best = min(best, words[root][0])
        return best

    pool = []
    for w, (rank, _, meaning, *_) in words.items():
        if rank > 35000 or len(w) < 3 or not w.isalpha():
            continue
        if not POS_RE.match(meaning) or w in lemma or w in names:
            continue
        if root_rank(w) < rank * 0.5:
            continue
        # 中国学生的难度和词频对不上的词（cabbage 词频排 7000 但中考就学过）测不准水平，不出题
        if w in tags:
            level = min(TAG_LEVEL.get(t, UNRANKED) for t in tags[w])
            # 词频比考试级别冷僻得多（实际更简单），或常用却只出现在高级词表里（实际更难）
            if level < UNRANKED and (rank > level * 2.5 or (level >= 4500 and rank < level / 2.5)):
                continue
        pos = POS_RE.match(meaning).group(1)
        pos = {'vt': 'v', 'vi': 'v', 'a': 'adj'}.get(pos, pos)
        m = short_meaning(meaning)
        if 1 < len(m) <= 14:
            pool.append([w, rank, pos, m])
    pool.sort(key=lambda x: x[1])

    def dump(name, obj):
        with open(os.path.join(root, name), 'w', encoding='utf-8') as f:
            json.dump(obj, f, ensure_ascii=False, separators=(',', ':'))
    dump('dict.json', words)
    dump('lemma.json', lemma)
    dump('phrases.json', phrases)
    dump('testpool.json', pool)
    print(f'{len(words)} words, {len(lemma)} forms, {len(phrases)} phrases, '
          f'{len(pool)} test words')


if __name__ == '__main__':
    main(sys.argv[1])
