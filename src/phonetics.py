"""Spoken-sound analysis from CMU phonemes. Spelling is never consulted.
Unknown words -> 'unknown' (refuse to guess), never a spelling fallback.

Rhyme hierarchy (user rule 2026-10-10): LYRICAL rhyme is the pillar.
  lyrical  = a multi-syllable spoken-sound match: the vowel sequence of the last >=2 syllables lines up
             (aligned from the end, across word boundaries), stressed vowels matching or close,
             e.g. critic / missed it, limitless art / swimming with sharks.
  perfect, slant, assonance, consonance = allowed, reported, but secondary (not relied on for aesthetics).
"""
import itertools, re

VOWELS = {"AA","AE","AH","AO","AW","AY","EH","ER","EY","IH","IY","OW","OY","UH","UW"}
PLOSIVE = {"P","B","T","D","K","G"}
FRIC = {"F","V","TH","DH","S","Z","SH","ZH","HH"}
AFFR = {"CH","JH"}
NASAL = {"M","N","NG"}
REDUCED = {"AH","IH","UH","ER"}           # vowels that collapse toward schwa when unstressed in speech
CLOSE = [{"IH","IY"},{"EH","AE","EY"},{"AA","AO","AH"},{"UH","UW","OW"},{"AY","EY"},{"AO","OW"},{"AW","OW"},{"ER","AH"}]
STOP = set("""a an the and or but so to of in on at by for with from up as is am are was were be been being it its
i me my we us our you your he him his she her they them their this that these those there here do does did
not no yes oh uh yeah ya yo just than then too very can will would could should shall may might must""".split())
RANK = {"lyrical":6,"perfect":5,"slant":4,"assonance":3,"consonance":3,"identical":1,"none":0}


def manner(p):
    return "plosive" if p in PLOSIVE else "fricative" if (p in FRIC or p in AFFR) else "nasal" if p in NASAL else "liquid"

def _strip(p): return re.sub(r"\d", "", p)
def _isv(p): return _strip(p) in VOWELS
def _close(a, b): return any(a in s and b in s for s in CLOSE)


def variants(lex, text, cap=8):
    """All pronunciations of a word/phrase as flat phoneme lists, or None if any word is unknown."""
    per = []
    for w in text.split():
        ps = lex.phones(w)
        if not ps:
            return None
        per.append(ps)
    if not per:
        return None
    return [sum(c, []) for c in itertools.islice(itertools.product(*per), cap)]


def tagged_variants(lex, text, cap=8):
    """Like variants() but each phone carries the normalized word it came from: [(phones, tags)]."""
    words = [lex.norm(w) for w in text.split() if lex.norm(w)]
    per = []
    for w in words:
        ps = lex.phones(w)
        if not ps:
            return None
        per.append([(p, [w] * len(p)) for p in ps])
    if not per:
        return None
    out = []
    for combo in itertools.islice(itertools.product(*per), cap):
        out.append((sum((c[0] for c in combo), []), sum((c[1] for c in combo), [])))
    return out


def syllables(ph):
    """[(vowel, stress, coda_tuple)] — coda = consonants after the vowel up to the next vowel."""
    out = []
    for i, p in enumerate(ph):
        if _isv(p):
            j, coda = i + 1, []
            while j < len(ph) and not _isv(ph[j]):
                coda.append(_strip(ph[j])); j += 1
            out.append((_strip(p), int(p[-1]), tuple(coda)))
    return out


def tail(ph):
    idx = [i for i, p in enumerate(ph) if p.endswith("1")] or [i for i, p in enumerate(ph) if p.endswith("2")] \
          or [i for i, p in enumerate(ph) if _isv(p)]
    return ph[idx[-1]:] if idx else ph


def onset(ph):
    out = []
    for p in ph:
        if _isv(p): break
        out.append(_strip(p))
    return out


def _vscore(a, b):
    (va, sa, _), (vb, sb, _) = a, b
    if va == vb: return 1.0
    if (sa == 0 or sb == 0) and va in REDUCED and vb in REDUCED: return 0.85
    if _close(va, vb): return 0.7
    if sa == 0 or sb == 0: return 0.4
    return 0.0


def _coda_score(a, b):
    """Consonants closing the final rhyming syllable: same=1, both open=1, share a consonant or same-manner
    last consonant=0.6, otherwise 0."""
    if a == b: return 1.0
    if a and b and (set(a) & set(b) or manner(a[-1]) == manner(b[-1])): return 0.6
    return 0.0


def _syl_words(ph, tags):
    return [tags[i] for i, p in enumerate(ph) if _isv(p)]


def lyrical_chain(x, y, tx=None, ty=None):
    """Align syllables from the end and walk backwards.
    - Syllables where both sides come from the SAME word ('the game'/'the same') or where both sides are
      function words ('but the'/'and the') are transparent: not counted, chain not broken.
    - The first counted pair (the rhyme tail) must score >= 0.85 (same vowel, or reduced/reduced unstressed).
    - Chain stops at a both-stressed pair scoring < 0.7, or any pair < 0.4. Weak front links are trimmed.
    Returns (length, vowel_mean, tail_coda_score)."""
    sx, sy = syllables(x), syllables(y)
    wx = _syl_words(x, tx) if tx else [None] * len(sx)
    wy = _syl_words(y, ty) if ty else [None] * len(sy)
    scores, coda = [], 0.0
    for a, b, ua, ub in zip(reversed(sx), reversed(sy), reversed(wx), reversed(wy)):
        if ua is not None and (ua == ub or (ua in STOP and ub in STOP)):
            continue
        s = _vscore(a, b)
        if not scores:
            if s < 0.85:
                return 0, 0.0, 0.0
            coda = _coda_score(a[2], b[2])
        stressed = a[1] > 0 and b[1] > 0
        if (stressed and s < 0.7) or s < 0.4:
            break
        scores.append(s)
    while scores and scores[-1] < 0.85:
        scores.pop()
    if not scores:
        return 0, 0.0, 0.0
    return len(scores), sum(scores) / len(scores), coda


def compare(lex, a, b):
    """Best-variant sound relationship between two words/phrases.
    kind: lyrical | perfect | slant | assonance | consonance | identical | none | unknown"""
    A, B = tagged_variants(lex, a), tagged_variants(lex, b)
    if A is None or B is None:
        return {"kind": "unknown", "why": "word not in pronunciation dictionary; spelling is not used as a fallback"}
    best = None
    for (x, gx), (y, gy) in itertools.product(A, B):
        r = _cmp(x, y, gx, gy)
        if best is None or (RANK[r["kind"]], r.get("strength", 0)) > (RANK[best["kind"]], best.get("strength", 0)):
            best = r
    return best


def _cmp(x, y, gx=None, gy=None):
    if [_strip(p) for p in x] == [_strip(p) for p in y]:
        return {"kind": "identical", "strength": 0}
    tx, ty = [_strip(p) for p in tail(x)], [_strip(p) for p in tail(y)]
    n, vmean, coda = lyrical_chain(x, y, gx, gy)
    perfect = identical = False
    if tx == ty:
        def pre(ph, t):
            out, i = [], len(ph) - len(t) - 1
            while i >= 0 and not _isv(ph[i]): out.append(_strip(ph[i])); i -= 1
            return tuple(out)
        perfect = pre(x, tx) != pre(y, ty)
        identical = not perfect
    if n >= 2 and vmean >= 0.8 and coda >= 0.6:   # chain already skips repeated words
        return {"kind": "lyrical", "syllables": n, "vowel_match": round(vmean, 2), "coda_match": coda,
                "perfect_tail": perfect, "strength": round(n * (0.8 * vmean + 0.2 * coda), 2)}
    if perfect:   return {"kind": "perfect", "tail": tx, "strength": 1.0}
    if identical: return {"kind": "identical", "strength": 0}
    vx, vy = [p for p in tx if p in VOWELS], [p for p in ty if p in VOWELS]
    cx, cy = [p for p in tx if p not in VOWELS], [p for p in ty if p not in VOWELS]
    cons_manner = len(cx) == len(cy) and cx and all(manner(a) == manner(b) for a, b in zip(cx, cy))
    close = vx == vy or (len(vx) == len(vy) and all(a == b or _close(a, b) for a, b in zip(vx, vy)))
    if vx == vy and cons_manner: return {"kind": "slant", "note": "same vowels, same-family consonants", "strength": 0.8}
    if close and cx == cy:       return {"kind": "slant", "note": "close vowels, same consonants", "strength": 0.7}
    if vx == vy and vx:          return {"kind": "assonance", "vowels": vx, "strength": 0.5}
    if cx == cy and cx:          return {"kind": "consonance", "cons": cx, "strength": 0.4}
    return {"kind": "none", "strength": 0}


def alliteration(lex, a, b):
    """Same spoken onset? ('knight'~'nap', 'phone'~'fan'). None if unknown."""
    A, B = variants(lex, a), variants(lex, b)
    if A is None or B is None: return None
    for x, y in itertools.product(A, B):
        ox, oy = onset(x), onset(y)
        if ox and oy and ox[0] == oy[0]: return True
        if not ox and not oy: return True
    return False


def resonance(lex, words):
    """Recurring vowel / consonant phonemes in a line (the assonance/consonance 'ring'). None if any word unknown."""
    from collections import Counter
    v, c = Counter(), Counter()
    for w in words:
        pv = lex.phones(w)
        if not pv: return None
        for p in pv[0]:
            s = _strip(p); (v if s in VOWELS else c)[s] += 1
    return {"vowels": {k: n for k, n in v.most_common() if n > 1}, "consonants": {k: n for k, n in c.most_common() if n > 1}}
