import sys, os, tempfile
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "src"))
from verse import Verse, Rejected
from lexicon import Lexicon
import phonetics as P
LEX = Lexicon()
PASS = FAIL = 0
def check(name, cond):
    global PASS, FAIL
    cond = bool(cond)
    PASS += cond; FAIL += (not cond)
    print(("PASS " if cond else "FAIL ") + name)
def rejects(code, fn):
    try: fn()
    except Rejected as e: return e.code == code
    return False

# --- fixed N ---
v = Verse(8, Lexicon())
v.add_line("I keep it moving through the night")           # 8
check("fixed8: on-target line accepted", len(v.lines) == 1)
check("fixed8: off-target add rejected", rejects("SYLLABLE_COUNT", lambda: v.add_line("I keep it moving through the night again")))
check("fixed8: state unchanged after reject", len(v.lines) == 1)
v.replace_word(0, 6, "dark")  # night(1)->dark(1)
check("replace same-count word ok", v.lines[0]["words"][6] == "dark")
check("replace changing count rejected", rejects("SYLLABLE_COUNT", lambda: v.replace_word(0, 6, "darkness")))
v.replace_span(0, 5, 7, "the dark")
# --- staggered pattern repeats exactly ---
s = Verse([10, 6], Lexicon())
s.add_line("I wake up early in the morning light")
check("stagger: line1 target 10", s.target(0) == 10)
check("stagger: 5-syl line rejected at slot 2", rejects("SYLLABLE_COUNT", lambda: s.add_line("running through the town")))
s.add_line("running through the whole town")
s.add_line("I wake up early in the morning light")
check("stagger: pattern repeats (line3 target 10)", s.target(2) == 10 and len(s.lines) == 3)
check("stagger: 10-syl line rejected into a 6 slot", rejects("SYLLABLE_COUNT", lambda: s.add_line("I wake up early in the morning light", at=1)))
check("stagger: exportable when perfect", s.exportable()[0])

# --- retarget: "too much of a mouthful" 10 -> 5 flags, never auto-rewrites ---
m = Verse(10, Lexicon())
m.add_line("I wake up early in the morning light")
m.add_line("I keep it moving through the endless night")
before = [list(l["words"]) for l in m.lines]
bad = m.set_pattern(5)
check("retarget: both lines flagged OVER by 5", [b["state"] for b in bad] == ["OVER", "OVER"] and bad[0]["delta"] == 5)
check("retarget: text untouched (no regeneration)", [l["words"] for l in m.lines] == before)
check("retarget: export blocked", rejects("EXPORT_BLOCKED", m.export))
m.replace_line(0, "wake up in the light")
check("retarget: user cut to 5 accepted", m.line_status(0)["ok"])
check("retarget: still blocked while line 2 over", rejects("EXPORT_BLOCKED", m.export))
m.replace_line(1, "keep it moving on")
check("retarget: export allowed once all lines = 5", m.export().count("\n") == 1)

# --- unknown / ambiguous words: never silently counted ---
u = Verse(5, Lexicon())
check("unknown word rejected", rejects("UNVERIFIED_WORD", lambda: u.add_line("zzxqv is here now")))
st, c = u.lex.counts("every")
check("'every' flagged ambiguous (2 or 3)", st == "ambiguous" and c == [2, 3])
check("ambiguous word rejected until user states count", rejects("UNVERIFIED_WORD", lambda: u.add_line("every day is mine")))
u.set_override("every", 2)
u.add_line("every day is mine")
check("override accepted, line now certified", u.line_status(0)["ok"])
check("override change is logged", any(e["op"] == "set_override" for e in u.log))

# --- locks ---
k = Verse(5, Lexicon())
k.add_line("keep it moving on")
k.lock(0, 1)  # lock 'it'
check("locked word cannot be replaced", rejects("LOCKED", lambda: k.replace_word(0, 1, "me")))
k.replace_word(0, 0, "hold")
check("unlocked neighbour can be replaced", k.lines[0]["words"][0] == "hold")
k.lock(0, None)
check("locked line blocks replace_line", rejects("LOCKED", lambda: k.replace_line(0, "hold it moving on")))

# --- undo & rejections logged ---
w = Verse(5, Lexicon())
w.add_line("keep it moving on")
w.replace_word(0, 0, "hold")
w.undo()
check("undo restores prior word", w.lines[0]["words"][0] == "keep")
try: w.replace_word(0, 0, "holding")
except Rejected: pass
check("rejection logged with status REJECTED", w.log[-1]["status"] == "REJECTED" and w.log[-1]["code"] == "SYLLABLE_COUNT")

# --- spoken-sound rhyme (spelling ignored) ---
check("dispelled/wayward do NOT rhyme (different vowels)", P.compare(LEX, "dispelled", "wayward")["kind"] == "none")
check("fire/higher: lyrical 2-syl with perfect tail, despite spelling", P.compare(LEX, "fire", "higher")["kind"] == "lyrical" and P.compare(LEX, "fire", "higher")["perfect_tail"])
check("flow/know perfect despite spelling", P.compare(LEX, "flow", "know")["kind"] == "perfect")
check("rap/trap perfect (different onset)", P.compare(LEX, "rap", "trap")["kind"] == "perfect")
check("rap/wrap identical sound, not a rhyme", P.compare(LEX, "rap", "wrap")["kind"] == "identical")
check("late/lake slant (same vowel, same-family coda)", P.compare(LEX, "late", "lake")["kind"] == "slant")
check("cat/cut consonance", P.compare(LEX, "cat", "cut")["kind"] == "consonance")
check("knight/nap alliterate by sound", P.alliteration(LEX, "knight", "nap") is True)
check("phone/fan alliterate by sound", P.alliteration(LEX, "phone", "fan") is True)
check("unknown word -> 'unknown', no spelling fallback", P.compare(LEX, "zzxqv", "cat")["kind"] == "unknown")
check("shared word 'it' is repetition, not extra rhyme: hold it/fold it = perfect", P.compare(LEX, "hold it", "fold it")["kind"] == "perfect")

# --- candidates: syllable-fit AND sound-fit ---
c = Verse(5, Lexicon())
c.add_line("keep it moving on")
cands = c.candidates(0, 3, rhymes_with="dawn", kinds=("perfect",))
check("candidates rhyme with 'dawn' by sound", "gone" in cands or "lawn" in cands)
check("candidates keep line on target (1-syl)", all(LEX.counts(x)[1] == [1] for x in cands))
check("slant candidates superset-able", len(c.candidates(0, 3, rhymes_with="dawn", kinds=("perfect","slant","assonance"))) >= len(cands))
c.add_line("tonight beneath dawn")  # 5
check("rhyme_between lines 1/2 final words on/dawn", c.rhyme_between(0, 1)["kind"] in ("perfect", "slant", "assonance"))

# --- persistence ---
p = os.path.join(tempfile.mkdtemp(), "v.json")
c.save(p); r = Verse.load(p)
check("save/load round-trip", r.lines == c.lines and r.pattern == c.pattern and len(r.log) == len(c.log))


# ================= LYRICAL PILLAR (user rule 2026-10-10) =================
def kind(a, b): return P.compare(LEX, a, b)
check("lyrical: critic / missed it (2 syl)", kind("critic", "missed it")["kind"] == "lyrical" and kind("critic", "missed it")["syllables"] == 2)
check("lyrical: limitless art / swimming with sharks (4 syl)", kind("limitless art", "swimming with sharks")["syllables"] == 4)
check("lyrical: lyrical magician / spiritual mission", kind("lyrical magician", "spiritual mission")["kind"] == "lyrical")
check("lyrical: money / honey", kind("money", "honey")["kind"] == "lyrical")
check("NOT lyrical: holding it / frozen still (vowels only, codas clash)", kind("holding it", "frozen still")["kind"] != "lyrical")
check("repeated word is not rhyme: the game / the same = perfect, not lyrical", kind("the game", "the same")["kind"] == "perfect")
check("function words don't pad: but the block / and the clock = perfect", kind("but the block", "and the clock")["kind"] == "perfect")
check("shared trailing word transparent: frozen still / broken still = lyrical", kind("frozen still", "broken still")["kind"] == "lyrical")
check("rap / wrap = identical sound (not a rhyme)", kind("rap", "wrap")["kind"] == "identical")

# ================= pronunciation sources =================
lx = Lexicon()
check("g-drop rule: flexin' derived from flexing, 2 syl", lx.counts("flexin'") == ("known", [2]) and lx.source("flexin'").startswith("g-drop"))
check("reppin' unknown until stated (no guess)", lx.counts("reppin'")[0] == "unknown")
pv = Verse(5, Lexicon())
check("bad ARPABET rejected", rejects("BAD_PRONUNCIATION", lambda: pv.set_pronunciation("reppin'", "R EH P IH0 N")))
pv.set_pronunciation("reppin'", "R EH1 P IH0 N")
pv.add_line("I keep reppin' it")
check("stated pronunciation counts (I keep reppin' it = 5)", pv.line_status(0)["ok"])
check("stated pronunciation rhymes by sound: reppin' / steppin' lyrical", P.compare(pv.lex, "reppin'", "steppin'")["kind"] == "lyrical")
check("pronunciation that breaks a line is rejected", rejects("SYLLABLE_COUNT", lambda: pv.set_pronunciation("reppin'", "R EH1 P")))
pv.undo(); pv.undo()   # rejected ops leave no undo step: 1st undo = add_line, 2nd = set_pronunciation
check("undo walks back applied ops only; 2nd undo removes the pronunciation", "reppin'" not in pv.lex.pron_overrides and not pv.lines)

# ================= scheme / internal / braid =================
d = Verse(11, Lexicon())
for l in ["cold steel in my palm and I been holding it", "the night is young but the block is frozen still",
          "I keep my mind on the cash and folding it", "the light is gone and the clock is broken still"]:
    d.add_line(l)
r = d.verify()
check("end scheme ABAB by sound", r["end_labels"] == ["A", "B", "A", "B"])
check("end pairs are lyrical (pillar)", r["pillar"]["lyrical_end_pairs"] == 2 and not r["pillar"]["secondary_end_pairs"])
fams = [sorted(u for _, _, u in g["members"]) for g in r["internal_groups"]]
check("internal families found: night/light and block/clock", ["light", "night"] in fams and ["block", "clock"] in fams)
check("braid detected (interleaving schemes), no minimum enforced", r["braid"]["braided"])
check("steel vs end 'still' flagged (internal sounds like end)", any(x["unit"] == "steel" for x in r["rule_violations"]))
check("export blocked by internal=end rule", rejects("EXPORT_BLOCKED", d.export))
check("fix attempt 'iron' (2 syl) rejected by count", rejects("SYLLABLE_COUNT", lambda: d.replace_word(0, 1, "iron")))
d.replace_word(0, 1, "chrome")
check("mutation 'steel'->'chrome' clears the violation; rest of verse untouched",
      not d.verify()["rule_violations"] and d.lines[1]["words"][1] == "night")
check("export now allowed", d.export().startswith("cold chrome"))

w2 = Verse(11, Lexicon())
for l in ["cold steel in my palm and I been holding it", "the night is young but the block is frozen still"]:
    w2.add_line(l)
check("syllable rule cannot be waived", rejects("NOT_WAIVABLE", lambda: w2.waive("SYLLABLE_COUNT", 0)))
w2.waive("INTERNAL_EQUALS_END", 0)
check("user waiver on a specific line lifts that RULE block (logged)", w2.export().count("\n") == 1 and w2.log[-1]["op"] == "waive")

# ================= hygiene =================
h = Verse(11, Lexicon())
h.add_line("**cold** chrome in my palm and I been holding it")
check("markup counts syllables of words only, but export blocked by hygiene", h.line_status(0)["ok"] and rejects("EXPORT_BLOCKED", h.export))
h2 = Verse(5, Lexicon())
h2.add_line("I stay on the beat")
r2 = h2.verify()
check("doc cliche 'on the beat' flagged, NOT blocking", r2["cliche_flags"] and not r2["hygiene_hard"] and h2.export())
check("tightened regex: 'you know your' is not flagged as 'yo yo'", not __import__("analysis").hygiene(["you know your name"])[1])

# ================= candidates lead with lyrical =================
cv = Verse(4, Lexicon())
cv.add_line("I want money")
cs = cv.candidates(0, 2, rhymes_with="honey")
check("candidates for a 2-syl slot rhyming 'honey' start with lyrical matches", cs and P.compare(LEX, cs[0], "honey")["kind"] == "lyrical")

# ================= speed =================
import time
sp = Verse(11, Lexicon())
for _ in range(4):
    for l in ["cold chrome in my palm and I been holding it", "the night is young but the block is frozen still",
              "I keep my mind on the cash and folding it", "the light is gone and the clock is broken still"]:
        sp.add_line(l)
t0 = time.time(); sp.verify()
check("16-bar full verify under 3 s", time.time() - t0 < 3)
print(f"\n{PASS} passed, {FAIL} failed")
sys.exit(1 if FAIL else 0)
