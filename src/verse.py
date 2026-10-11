"""Verse = persistent object. Corrections are mutations on named slots, never regeneration.
Hard rule: every line's syllable count must equal its target (int N, or a pattern list repeating exactly).
A mutation that would break the rule, or involves a word whose count is not verified, is REJECTED and state is unchanged."""
import copy, json, os, re, time
from lexicon import Lexicon, KNOWN, AMBIGUOUS, UNKNOWN
import phonetics as P
import analysis as A
from lexicon import validate_phones


class Rejected(Exception):
    def __init__(self, code, detail):
        super().__init__(f"{code}: {detail}")
        self.code, self.detail = code, detail


class Verse:
    def __init__(self, pattern, lex=None):
        self.lex = lex or Lexicon()
        self.pattern = self._pat(pattern)
        self.lines = []      # each: {"words":[str], "locked":[bool], "line_lock":bool}
        self.log = []        # append-only audit trail
        self._snaps = []     # undo stack (state snapshots)
        self.stale_targets = False  # True after set_pattern left violators; blocks export until resolved
        self.waivers = []           # [{'code','line'}] user-approved exceptions to RULE checks (never syllables)

    # ---------- rule ----------
    @staticmethod
    def _pat(p):
        if isinstance(p, int):
            p = [p]
        p = list(p)
        if not p or any((not isinstance(n, int)) or n < 1 for n in p):
            raise Rejected("BAD_PATTERN", "pattern must be a positive int or non-empty list of positive ints")
        return p

    def target(self, i):
        return self.pattern[i % len(self.pattern)]

    def count_words(self, words):
        """-> (total, problems). problems lists words that are unknown/ambiguous."""
        total, problems = 0, []
        for w in words:
            st, c = self.lex.counts(w)
            if st == KNOWN:
                total += c[0]
            else:
                problems.append((w, st, c))
        return total, problems

    def line_status(self, i):
        words = self.lines[i]["words"]
        total, problems = self.count_words(words)
        t = self.target(i)
        if problems:
            return {"line": i, "target": t, "count": None, "ok": False, "state": "UNVERIFIED", "problems": problems}
        return {"line": i, "target": t, "count": total, "ok": total == t,
                "state": "OK" if total == t else ("OVER" if total > t else "UNDER"), "delta": total - t}

    def report(self):
        return [self.line_status(i) for i in range(len(self.lines))]

    def exportable(self):
        r = self.report()
        bad = [s for s in r if not s["ok"]]
        return (not bad and bool(r)), bad

    # ---------- infra ----------
    def _snap(self):
        self._snaps.append(copy.deepcopy((self.pattern, self.lines, self.lex.overrides, self.lex.pron_overrides, self.stale_targets, self.waivers)))

    def _record(self, op, **kw):
        self.log.append({"n": len(self.log) + 1, "t": time.strftime("%Y-%m-%dT%H:%M:%S"), "op": op, **kw})

    def _tok(self, text):
        ws = text.split() if isinstance(text, str) else list(text)
        ws = [w for w in ws if self.lex.norm(w)]
        if not ws:
            raise Rejected("EMPTY", "no words")
        return ws

    def _gate(self, i, words, why):
        total, problems = self.count_words(words)
        t = self.target(i)
        if problems:
            names = ", ".join(f"'{w}' ({st}{'; could be ' + '/'.join(map(str, c)) if c else ''})" for w, st, c in problems)
            raise Rejected("UNVERIFIED_WORD", f"{why}: cannot certify syllables for {names}. Use set_override(word, n) to state the count.")
        if total != t:
            raise Rejected("SYLLABLE_COUNT", f"{why}: line {i+1} would have {total} syllables, target is {t} ({'+' if total>t else ''}{total-t}).")

    def _run(self, op, fn, **kw):
        """Apply fn atomically: on any rejection state is restored and the rejection is logged."""
        self._snap()
        try:
            res = fn()
        except Rejected as e:
            self._snaps.pop()
            self._record(op, status="REJECTED", code=e.code, detail=e.detail, **kw)
            raise
        self._record(op, status="APPLIED", **kw)
        return res

    # ---------- mutations ----------
    def add_line(self, text, at=None):
        words = self._tok(text)
        i = len(self.lines) if at is None else at
        def f():
            self._gate(i, words, "add_line")
            self.lines.insert(i, {"words": words, "locked": [False]*len(words), "line_lock": False})
        self._run("add_line", f, line=i, text=" ".join(words))

    def replace_span(self, line, start, end, new_text):
        """Replace words [start,end) in a line. Total must still equal target. Locked words cannot be touched."""
        new = self._tok(new_text)
        def f():
            L = self.lines[line]
            if L["line_lock"]:
                raise Rejected("LOCKED", f"line {line+1} is locked")
            if any(L["locked"][start:end]):
                raise Rejected("LOCKED", "span contains locked word(s): " + " ".join(w for w, k in zip(L["words"][start:end], L["locked"][start:end]) if k))
            words = L["words"][:start] + new + L["words"][end:]
            self._gate(line, words, "replace_span")
            L["locked"] = L["locked"][:start] + [False]*len(new) + L["locked"][end:]
            L["words"] = words
        before = " ".join(self.lines[line]["words"])
        self._run("replace_span", f, line=line, span=[start, end], before=before, new=new_text)

    def replace_word(self, line, idx, new_word):
        self.replace_span(line, idx, idx+1, new_word)

    def replace_line(self, line, text):
        words = self._tok(text)
        def f():
            L = self.lines[line]
            if L["line_lock"] or any(L["locked"]):
                raise Rejected("LOCKED", f"line {line+1} has locked content; use replace_span around it")
            self._gate(line, words, "replace_line")
            L["words"] = words; L["locked"] = [False]*len(words)
        before = " ".join(self.lines[line]["words"])
        self._run("replace_line", f, line=line, before=before, new=text)

    def delete_line(self, line):
        def f():
            if self.lines[line]["line_lock"]:
                raise Rejected("LOCKED", f"line {line+1} is locked")
            self.lines.pop(line)
            # Deleting shifts later lines onto different targets in a staggered pattern; flag if any now violate.
            self.stale_targets = any(not s["ok"] for s in self.report())
        self._run("delete_line", f, line=line)

    def set_pattern(self, pattern):
        """User retarget ('too much of a mouthful -> 5'). Allowed to leave violators: they are listed and export is blocked
        until each is cut with replace_span/replace_line. Nothing is auto-rewritten."""
        p = self._pat(pattern)
        def f():
            self.pattern = p
            bad = [s for s in self.report() if not s["ok"]]
            self.stale_targets = bool(bad)
            return bad
        res = self._run("set_pattern", f, pattern=p)
        return res

    def lock(self, line, idx=None, on=True):
        def f():
            if idx is None: self.lines[line]["line_lock"] = on
            else: self.lines[line]["locked"][idx] = on
        self._run("lock" if on else "unlock", f, line=line, idx=idx)

    def set_override(self, word, n):
        w = self.lex.norm(word)
        if not w or not isinstance(n, int) or n < 1:
            raise Rejected("BAD_OVERRIDE", "need a word and positive int")
        def f():
            self.lex.overrides[w] = n
        self._run("set_override", f, word=w, syllables=n)

    def set_pronunciation(self, word, phones):
        """User states exactly how a word is SAID (ARPABET, e.g. "R EH1 P IH0 N"). Fixes syllables AND rhyme sound.
        Rejected if any existing line would leave its syllable target because of it."""
        w = self.lex.norm(word)
        try:
            ph = validate_phones(phones)
        except ValueError as e:
            raise Rejected("BAD_PRONUNCIATION", str(e))
        def f():
            before = {i: s["ok"] for i, s in enumerate(self.report())}
            self.lex.pron_overrides[w] = ph
            broken = [i for i, s in enumerate(self.report()) if before[i] and not s["ok"]]
            if broken:
                raise Rejected("SYLLABLE_COUNT", f"pronouncing '{w}' as {' '.join(ph)} would break line(s) {[b+1 for b in broken]}")
        self._run("set_pronunciation", f, word=w, phones=" ".join(ph))

    def waive(self, code, line):
        """User accepts a specific RULE violation (e.g. INTERNAL_EQUALS_END on line 3). Syllable rule cannot be waived."""
        if code in ("SYLLABLE_COUNT", "UNVERIFIED_WORD"):
            raise Rejected("NOT_WAIVABLE", "the syllable rule is never waivable")
        def f():
            self.waivers.append({"code": code, "line": line})
        self._run("waive", f, code=code, line=line)

    def undo(self):
        if not self._snaps:
            raise Rejected("NOTHING_TO_UNDO", "stack empty")
        self.pattern, self.lines, self.lex.overrides, self.lex.pron_overrides, self.stale_targets, self.waivers = self._snaps.pop()
        self._record("undo", status="APPLIED")

    # ---------- candidates (suggest only; never applied) ----------
    def candidates(self, line, idx, rhymes_with=None, kinds=("lyrical", "perfect"), alliterates_with=None, limit=30):
        """Words that keep the line on its syllable target AND match by SOUND (CMU phonemes, never spelling).
        Default kinds put LYRICAL first (pillar), then perfect. Sorted strongest sound match first. Suggest-only."""
        L = self.lines[line]
        others, probs = self.count_words(L["words"][:idx] + L["words"][idx+1:])
        if probs:
            raise Rejected("UNVERIFIED_WORD", "other words in the line are unverified; fix those first")
        need = self.target(line) - others
        if need < 1:
            return []
        pool = self.lex.by_syllables(need)
        scored = []
        rw = self.lex.norm(rhymes_with) if rhymes_with else None
        for w in pool:
            if rw:
                if w == rw: continue
                r = P.compare(self.lex, w, rw)
                if r["kind"] not in kinds: continue
                key = (P.RANK[r["kind"]], r.get("strength", 0))
            else:
                key = (0, 0)
            if alliterates_with and not P.alliteration(self.lex, w, alliterates_with):
                continue
            scored.append((key, w))
        scored.sort(key=lambda t: (-t[0][0], -t[0][1], len(t[1]), t[1]))
        return [w for _, w in scored[:limit]]

    def rhyme_between(self, line_a, line_b):
        """Sound relationship of the final words of two lines."""
        a, b = self.lines[line_a]["words"][-1], self.lines[line_b]["words"][-1]
        return P.compare(self.lex, a, b)

    # ---------- export & persistence ----------
    def verify(self):
        """Full check. Hard: syllables (U1/U2), output hygiene. RULE: internal != end. Report-only: scheme, braid, pillar, flags."""
        words = [L["words"] for L in self.lines]
        texts = [" ".join(w) for w in words]
        syl = self.report()
        hard_h, flags = A.hygiene(texts)
        verified = all(s["state"] != "UNVERIFIED" for s in syl)
        out = {"syllables": syl, "hygiene_hard": hard_h, "cliche_flags": flags, "sound_verified": verified}
        cmp = A._cmp_factory(self.lex)
        labels, pairs = A.end_scheme(self.lex, words, cmp)
        internal = A.internal_rhymes(self.lex, words, cmp)
        viol = A.distinctness(self.lex, words, internal, labels, cmp)
        waived = {(w["code"], w["line"]) for w in self.waivers}
        for v in viol:
            v["waived"] = (v["code"], v["line"]) in waived
        unknown_sound = sorted({w for ws in words for w in ws if not self.lex.phones(w)})
        out.update({"end_labels": labels, "end_pairs": [(i, j, r["kind"]) for i, j, r in pairs],
                    "internal_groups": internal, "rule_violations": viol,
                    "braid": A.braid_report(labels, internal), "pillar": A.pillar_report(pairs, internal),
                    "no_phonemes": unknown_sound})
        return out

    def export(self):
        ok, bad = self.exportable()
        if not ok:
            raise Rejected("EXPORT_BLOCKED", "; ".join(f"line {s['line']+1}: {s['state']}" + (f" ({s['count']} vs {s['target']})" if s['count'] is not None else "") for s in bad) or "empty verse")
        v = self.verify()
        if v["hygiene_hard"]:
            raise Rejected("EXPORT_BLOCKED", "; ".join(f"line {h['line']+1}: {h['why']}" for h in v["hygiene_hard"]))
        live = [x for x in v["rule_violations"] if not x["waived"]]
        if live:
            raise Rejected("EXPORT_BLOCKED", "; ".join(f"line {x['line']+1}: internal '{x['unit']}' sounds like end rhyme '{x['end']}' (line {x['end_line']+1}, {x['kind']})" for x in live))
        return "\n".join(" ".join(L["words"]) for L in self.lines)

    def save(self, path):
        json.dump({"pattern": self.pattern, "lines": self.lines, "overrides": self.lex.overrides,
                   "pron_overrides": self.lex.pron_overrides, "waivers": self.waivers,
                   "stale_targets": self.stale_targets, "log": self.log}, open(path, "w"), indent=1)

    @classmethod
    def load(cls, path, lex=None):
        d = json.load(open(path))
        lex = lex or Lexicon(overrides=d["overrides"], pron_overrides=d.get("pron_overrides", {}))
        v = cls(d["pattern"], lex); v.lines = d["lines"]; v.log = d["log"]; v.stale_targets = d.get("stale_targets", False); v.waivers = d.get("waivers", [])
        return v
