"""Syllable/phoneme lexicon backed by CMUdict. No guessing: unknown or ambiguous -> status, never a silent count.

Sources of truth, in priority order:
  1. user pronunciation override  (word -> ARPABET phones)       -> known, exact phonemes
  2. user syllable override       (word -> int)                   -> known count, no phonemes
  3. CMUdict                                                      -> known / ambiguous
  4. g-drop rule: "<x>in'" when CMUdict has "<x>ing" ending NG    -> known, phonemes derived (NG->N), same count
  else unknown.
"""
import os, re

HERE = os.path.dirname(os.path.abspath(__file__))
DICT_PATH = os.path.join(HERE, "..", "data", "cmudict.dict")

KNOWN, AMBIGUOUS, UNKNOWN = "known", "ambiguous", "unknown"
PHONES = {"AA","AE","AH","AO","AW","AY","B","CH","D","DH","EH","ER","EY","F","G","HH","IH","IY","JH","K","L",
          "M","N","NG","OW","OY","P","R","S","SH","T","TH","UH","UW","V","W","Y","Z","ZH"}
VOWELS = {"AA","AE","AH","AO","AW","AY","EH","ER","EY","IH","IY","OW","OY","UH","UW"}


def _syl(phones):
    return sum(1 for p in phones if p[-1].isdigit())


def validate_phones(phones):
    """Raise ValueError unless every token is a CMU phone; vowels must carry stress 0/1/2."""
    if isinstance(phones, str):
        phones = phones.split()
    out = []
    for p in phones:
        p = p.upper()
        base, stress = re.match(r"^([A-Z]+)(\d?)$", p).groups() if re.match(r"^([A-Z]+)(\d?)$", p) else (None, None)
        if base not in PHONES:
            raise ValueError(f"'{p}' is not a CMU phone")
        if base in VOWELS and stress not in ("0", "1", "2"):
            raise ValueError(f"vowel '{p}' needs a stress digit 0/1/2")
        if base not in VOWELS and stress:
            raise ValueError(f"consonant '{p}' cannot carry stress")
        out.append(p)
    if not out or not any(p[-1].isdigit() for p in out):
        raise ValueError("pronunciation needs at least one vowel")
    return out


class Lexicon:
    def __init__(self, dict_path=DICT_PATH, overrides=None, pron_overrides=None):
        self.pron = {}
        with open(dict_path, encoding="utf-8") as f:
            for line in f:
                line = line.split("#")[0].strip()
                if not line:
                    continue
                w, *ph = line.split()
                w = re.sub(r"\(\d+\)$", "", w)
                self.pron.setdefault(w, []).append(ph)
        self.overrides = dict(overrides or {})            # word -> int
        self.pron_overrides = dict(pron_overrides or {})  # word -> [phones]

    @staticmethod
    def norm(word):
        w = word.lower().replace("’", "'").replace("‘", "'")
        w = re.sub(r"[^a-z']", "", w)
        return w.strip("'") if not w.endswith("in'") else w.lstrip("'")

    def _gdrop(self, w):
        if w.endswith("in'") and w not in self.pron:
            base = w[:-1] + "g"
            vs = [p[:-1] + ["N"] for p in self.pron.get(base, []) if p and p[-1] == "NG"]
            return vs
        return []

    def source(self, word):
        w = self.norm(word)
        if w in self.pron_overrides: return "user-pronunciation"
        if w in self.overrides: return "user-syllables"
        if w in self.pron: return "cmudict"
        if self._gdrop(w): return "g-drop rule (from '%s')" % (w[:-1] + "g")
        return "none"

    def counts(self, word):
        """Return (status, sorted list of possible counts)."""
        w = self.norm(word)
        if not w:
            return UNKNOWN, []
        if w in self.pron_overrides:
            return KNOWN, [_syl(self.pron_overrides[w])]
        if w in self.overrides:
            return KNOWN, [self.overrides[w]]
        vs = self.pron.get(w) or self._gdrop(w)
        if vs:
            c = sorted({_syl(p) for p in vs})
            return (KNOWN if len(c) == 1 else AMBIGUOUS), c
        return UNKNOWN, []

    def phones(self, word):
        """All pronunciation variants. A syllable override with no phonemes yields [] (rhyme = unknown)."""
        w = self.norm(word)
        if w in self.pron_overrides:
            return [self.pron_overrides[w]]
        vs = self.pron.get(w) or self._gdrop(w)
        if w in self.overrides:  # keep only variants agreeing with the user's stated count
            vs = [p for p in vs if _syl(p) == self.overrides[w]]
        return vs

    def by_syllables(self, n):
        return [w for w, ps in self.pron.items() if {_syl(p) for p in ps} == {n} and w.isalpha()]
