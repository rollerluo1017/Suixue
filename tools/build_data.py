"""从 ECDICT (https://github.com/skywind3000/ECDICT, MIT) 生成插件用的离线数据。

用法: python3 tools/build_data.py path/to/ecdict.csv
输出: data/dict.json  单词 -> [词频排名, 音标, 中文释义]
      data/lemma.json 变形 -> 原形 (went -> go)
      data/phrases.json 短语 -> [中文释义, 难度]  难度: 0 太常见, 1 动词短语/习语, 2 普通搭配
      data/testpool.json 单词测试题库 (按词频分段)
"""
import csv, json, os, random, re, sys

UNRANKED = 60000
# 动词 + 这些小品词，通常是意思不能从字面推出来的动词短语 (give up, pay off)
PARTICLES = {'up', 'down', 'off', 'out', 'over', 'away', 'back', 'through', 'around', 'round',
             'along', 'apart', 'aside', 'forward', 'in', 'on', 'into', 'across', 'by'}  # 没有词频的考试词，按很生僻处理
WORD_RE = re.compile(r"[a-z][a-z'-]*")
PHRASE_RE = re.compile(r"[a-z][a-z']*( [a-z][a-z']*){1,3}")
NAME_RE = re.compile(r"人名|姓氏|地名|男子名|女子名|[(（]\s*[A-Z]")
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
    verbs = {w for w, (_, _, m) in words.items() if re.match(r'^(v|vt|vi)\.', m) or re.search(r'；(v|vt|vi)\.', m)}
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

    bands = [(1, 1000), (1001, 2000), (2001, 3000), (3001, 4000), (4001, 5000),
             (5001, 6500), (6501, 8000), (8001, 10000), (10001, 12500),
             (12501, 15000), (15001, 20000), (20001, 30000)]
    rng = random.Random(42)
    pool = []
    for lo, hi in bands:
        cands = []
        for w, (rank, _, meaning) in words.items():
            if not (lo <= rank <= hi) or len(w) < 3 or not w.isalpha():
                continue
            if not POS_RE.match(meaning) or w in lemma or w in names:
                continue
            m = short_meaning(meaning)
            if 1 < len(m) <= 14:
                cands.append([w, m])
        rng.shuffle(cands)
        pool.append({'from': lo, 'to': hi, 'words': cands[:60]})

    def dump(name, obj):
        with open(os.path.join(root, name), 'w', encoding='utf-8') as f:
            json.dump(obj, f, ensure_ascii=False, separators=(',', ':'))
    dump('dict.json', words)
    dump('lemma.json', lemma)
    dump('phrases.json', phrases)
    dump('testpool.json', pool)
    print(f'{len(words)} words, {len(lemma)} forms, {len(phrases)} phrases, '
          f'test bands: {[len(b["words"]) for b in pool]}')


if __name__ == '__main__':
    main(sys.argv[1])
