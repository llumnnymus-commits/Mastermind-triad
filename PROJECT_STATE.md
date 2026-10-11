# PROJECT_STATE — Verse Mutation Engine
Updated: 2026-10-10 (late)

## Purpose
Rap-verse system that MUTATES a persistent verse on correction (never regenerates), with a hard syllable rule and spoken-sound rhyme where LYRICAL rhyme is the pillar.

## User rules (all enforced)
1. Syllables: every line = target; target = fixed N or repeating staggered list; user retargets ("mouthful" -> 5). Never waivable.
2. Mutate, never regenerate.
3. Rhyme by spoken sound only (CMU phonemes), spelling irrelevant.
4. Lyrical rhyme = pillar; perfect/slant/assonance/consonance allowed but secondary.
5. Internal rhymes must sound different from end rhymes (blocks export; per-line waiver).
6. Braiding reported, no minimum. No internal-rhyme minimum.
7. Never zip files.

## Built & verified — 74/74 tests (`python3 -I tests/test_engine.py`)
- src/lexicon.py — CMUdict 135k; sources: user pronunciation > user syllables > CMUdict > g-drop rule; ambiguous/unknown refused.
- src/phonetics.py — kinds: lyrical / perfect / slant / assonance / consonance / identical / none / unknown; alliteration; resonance.
- src/analysis.py — end scheme (A/B/X by sound), internal-rhyme families (±3 bars), internal≠end RULE, braid + pillar reports, hygiene (hard) + cliché flags.
- src/verse.py — mutation ops (add/replace span|word|line/delete/set_pattern/lock/set_override/set_pronunciation/waive/undo), atomic, logged; verify(); export gates (syllables, hygiene, internal≠end).
- src/report.py — markdown verse report. src/cli.py — operate on verses/<name>.json.
- docs/RULES.md — every doc rule tagged + conflicts resolved by user + definitions.
- verses/demo.json — demo verse.

## Known limits
- Lyrical-rhyme thresholds are my computational reading of the user's term; tune if the user hears differently.
- Word bending (e.g. lyrical / sphere I kill) is NOT detected: dictionary pronunciations only; user can state a bent pronunciation.
- Not built: 16-slot grid / stress / pocket (optional layer), rhyme-chain pivots, scheme-evolution tracking, coherence (human).
- CMUdict citation forms; delivered elision needs overrides.

## Backups (2026-10-11)
- Google Drive (z.n.parrish1993@gmail.com): folder "verse-engine" id 1Y3hpoqmQ9mvxGl3jtziRCr0miqbL8dvz (subfolders src/ tests/ docs/). All text files uploaded and byte-size verified. data/cmudict.dict (3.6 MB, public CMU dictionary) NOT on Drive — re-obtainable via `git clone https://github.com/cmusphinx/cmudict`.
- GitHub: local git repo committed (branch main). NOT pushed — no repo exists for it and this session cannot create repos. Blocker: user must create an empty repo (suggested llumnnymus-commits/verse-engine, private); then add_repo(push) + `git push`.
