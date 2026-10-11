"""Verse-level checks (report + gates). All sound judgements come from phonetics.compare (phonemes, never spelling).

User rules (2026-10-10):
  - Lyrical rhymes are the pillar; perfect/slant/assonance/consonance allowed but secondary.
  - Internal rhymes must sound different from end rhymes (RULE, blocks export unless waived).
  - Braiding = multiple distinct schemes interleaving; reported, NO minimum enforced.
  - No minimum internal-rhyme count.
"""
import re
from functools import lru_cache
import phonetics as P

RHYME_KINDS = {"lyrical", "perfect", "slant"}          # what counts as "these rhyme"
STOP = P.STOP

# ---------------- hygiene ----------------
HARD_HYGIENE = [  # markup / assistant wrappers / structural labels: never allowed in lyric output
    (r"^\s*(here('s| is| are)|sure[,!]|certainly|of course|note:|i hope)", "assistant wrapper"),
    (r"\[[^\]]*\]", "bracketed label"),
    (r"\*\*|__|^#|`", "markdown markup"),
    (r"\(\s*\d+\s*\)", "parenthesized count"),
    (r"^\s*(verse|chorus|hook|bridge|intro|outro)\s*\d*\s*:", "section label"),
]
CLICHE_FLAGS = [  # from CORE / S1 / PIPE ban lists, tightened with word boundaries; FLAG only (may be intentional)
    r"\blyrical miracle\b", r"\bspit(ting|s)?\b(\W+\w+){0,3}\W+bars\b", r"\bcheck\b(\W+\w+){0,2}\W+mic\b",
    r"\blisten to me\b", r"\bwrit(e|ing) (a |this )?rap\b", r"\bmy verse\b", r"\byo,? yo\b",
    r"\blet('s| me)? (\w+ )?start\b", r"\bon the beat\b", r"\bpen (and|&|to) paper\b", r"\bink\b(\W+\w+)?\W+flow\b",
    r"\brhyme scheme\b", r"\bi'?m a rapper\b", r"\bsyllables?\b",
]


def hygiene(lines_text):
    hard, flags = [], []
    for i, t in enumerate(lines_text):
        for pat, why in HARD_HYGIENE:
            if re.search(pat, t, re.I):
                hard.append({"line": i, "why": why, "text": t})
        for pat in CLICHE_FLAGS:
            m = re.search(pat, t, re.I)
            if m:
                flags.append({"line": i, "match": m.group(0), "text": t})
    return hard, flags


# ---------------- helpers ----------------
def _cmp_factory(lex):
    @lru_cache(maxsize=200000)
    def cmp(a, b):
        return P.compare(lex, a, b)
    return cmp


def anchor(words):
    """Index of the last content word: the word that carries the end rhyme ('holding' in 'been holding it')."""
    for i in range(len(words) - 1, -1, -1):
        if re.sub(r"[^a-z']", "", words[i].lower()) not in STOP:
            return i
    return len(words) - 1


def end_unit(words):
    """The end-rhyme region: up to two words before the anchor, the anchor, and any trailing function words."""
    return " ".join(words[max(0, anchor(words) - 2):])


class _UF:
    def __init__(self): self.p = {}
    def find(self, x):
        self.p.setdefault(x, x)
        while self.p[x] != x:
            self.p[x] = self.p[self.p[x]]; x = self.p[x]
        return x
    def union(self, a, b): self.p[self.find(a)] = self.find(b)


# ---------------- end scheme ----------------
def end_scheme(lex, lines, cmp=None):
    """Label each line's ending A/B/C... by sound; X = rhymes with no other line's ending.
    Returns (labels, pairs) where pairs = [(i, j, result)] for every rhyming pair of endings."""
    cmp = cmp or _cmp_factory(lex)
    ends = [end_unit(w) for w in lines]
    uf, pairs = _UF(), []
    for i in range(len(ends)):
        uf.find(i)
        for j in range(i):
            r = cmp(ends[j], ends[i])
            if r["kind"] in RHYME_KINDS:
                uf.union(i, j); pairs.append((j, i, r))
    groups, labels, nxt = {}, [], 0
    sizes = {}
    for i in range(len(ends)):
        sizes[uf.find(i)] = sizes.get(uf.find(i), 0) + 1
    for i in range(len(ends)):
        root = uf.find(i)
        if sizes[root] < 2:
            labels.append("X"); continue
        if root not in groups:
            groups[root] = chr(ord("A") + nxt) if nxt < 26 else f"S{nxt}"; nxt += 1
        labels.append(groups[root])
    return labels, pairs


# ---------------- internal rhymes ----------------
def _units(words, max_k=3):
    """Windows ending on a non-final CONTENT word. -> [(start, end_idx, text)]"""
    out = []
    for j in range(max(0, anchor(words) - 2)):   # internal units end before the end-rhyme region
        if re.sub(r"[^a-z']", "", words[j].lower()) in STOP:
            continue
        for k in range(1, max_k + 1):
            s = j - k + 1
            if s < 0: break
            out.append((s, j, " ".join(words[s:j + 1])))
    return out


def internal_rhymes(lex, lines, cmp=None, reach=3):
    """Mid-line rhymes within a bar and between a bar and the next `reach` bars (default 3 = one 4-bar quadrant).
    Final words are excluded (they are end rhymes). Repeated identical words don't count.
    Returns list of groups: {"members": [(line, word_idx, unit_text)], "kinds": set}"""
    cmp = cmp or _cmp_factory(lex)
    units = [_units(w) for w in lines]
    best = {}  # ((li,j),(lj,j2)) -> (rank, unit_a, unit_b, result)
    for li in range(len(lines)):
        for lj in range(li, min(len(lines), li + reach + 1)):
            for (s1, e1, t1) in units[li]:
                for (s2, e2, t2) in units[lj]:
                    if li == lj and not (e1 < s2):     # same bar: non-overlapping, ordered
                        continue
                    w1, w2 = lex.norm(lines[li][e1]), lex.norm(lines[lj][e2])
                    if w1 == w2:
                        continue
                    r = cmp(t1, t2)
                    if r["kind"] not in RHYME_KINDS:
                        continue
                    if r["kind"] != "lyrical" and (s1 != e1 or s2 != e2):
                        continue  # multi-word windows only count when they make a lyrical chain
                    key = ((li, e1), (lj, e2))
                    score = (P.RANK[r["kind"]], r.get("strength", 0))
                    if key not in best or score > best[key][0]:
                        best[key] = (score, t1, t2, r)
    uf, unit_of, kinds = _UF(), {}, {}
    for (a, b), (score, t1, t2, r) in best.items():
        uf.union(a, b)
        unit_of.setdefault(a, t1); unit_of.setdefault(b, t2)
        kinds.setdefault(a, set()).add(r["kind"]); kinds.setdefault(b, set()).add(r["kind"])
    groups = {}
    for pos in unit_of:
        groups.setdefault(uf.find(pos), []).append(pos)
    out = []
    for members in groups.values():
        members.sort()
        ks = set().union(*(kinds[m] for m in members))
        out.append({"members": [(l, w, unit_of[(l, w)]) for l, w in members], "kinds": sorted(ks)})
    out.sort(key=lambda g: g["members"][0])
    return out


# ---------------- distinctness (internal vs end) ----------------
def distinctness(lex, lines, internal_groups, labels, cmp=None, reach=3):
    """RULE (user, 2026-10-10): internal rhymes must sound different from end rhymes.
    Every mid-line unit (paired or not — a mid-line word that rhymes with an ending IS an internal rhyme on the
    end sound) is checked against the end region of its own bar and of end-schemed bars within +-reach.
    Violation if it rhymes (lyrical/perfect/slant). One report per mid-line word (strongest unit)."""
    cmp = cmp or _cmp_factory(lex)
    def end_forms(words):
        s = max(0, anchor(words) - 2)
        return [" ".join(words[s:e]) for e in range(len(words), s, -1)
                if re.sub(r"[^a-z']", "", words[e - 1].lower()) not in STOP or e == len(words)]
    forms = [end_forms(w) for w in lines]
    schemed = {i for i, l in enumerate(labels) if l != "X"}
    v = []
    for l, words in enumerate(lines):
        targets = [l] + [t for t in range(max(0, l - reach), min(len(lines), l + reach + 1)) if t != l and t in schemed]
        best = {}
        for (s, e, unit) in _units(words):
            for t in targets:
                hit = None
                for form in forms[t]:
                    r = cmp(unit, form)
                    if r["kind"] in RHYME_KINDS:
                        hit = (t, form, r); break
                if hit:
                    sc = (P.RANK[hit[2]["kind"]], hit[2].get("strength", 0))
                    if e not in best or sc > best[e][0]:
                        best[e] = (sc, unit, hit)
                    break
        for e, (sc, unit, (t, form, r)) in sorted(best.items()):
            v.append({"code": "INTERNAL_EQUALS_END", "line": l, "word": e, "unit": unit,
                      "end_line": t, "end": form, "end_label": labels[t], "kind": r["kind"]})
    return v


# ---------------- braid / pillar report ----------------
def braid_report(labels, internal_groups):
    spans = {}
    for i, l in enumerate(labels):
        if l != "X":
            spans.setdefault("end:" + l, []).append(i)
    for gi, g in enumerate(internal_groups):
        spans["int:" + str(gi + 1)] = sorted({m[0] for m in g["members"]})
    rng = {k: (min(v), max(v)) for k, v in spans.items()}
    keys = list(rng)
    interleaved = sorted({tuple(sorted((a, b))) for a in keys for b in keys
                          if a < b and rng[a][0] <= rng[b][1] and rng[b][0] <= rng[a][1]})
    return {"schemes": {k: [x + 1 for x in v] for k, v in spans.items()},
            "interleaving_pairs": interleaved, "braided": bool(interleaved)}


def pillar_report(end_pairs, internal_groups):
    end_kinds = [r["kind"] for _, _, r in end_pairs]
    lyr = sum(k == "lyrical" for k in end_kinds)
    secondary = [(i, j, r["kind"]) for i, j, r in end_pairs if r["kind"] != "lyrical"]
    return {"end_pairs": len(end_kinds), "lyrical_end_pairs": lyr,
            "secondary_end_pairs": secondary,
            "internal_groups_lyrical": sum("lyrical" in g["kinds"] for g in internal_groups),
            "internal_groups_total": len(internal_groups)}
