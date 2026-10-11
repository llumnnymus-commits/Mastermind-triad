# verse-engine
Rap verse mutation engine: corrections mutate a persistent verse instead of regenerating it.
Hard syllable rule (fixed N or repeating staggered pattern, user-set), rhyme judged by spoken sound (CMU phonemes),
lyrical (multi-syllable) rhyme as the pillar, internal rhymes must sound different from end rhymes.

- Start here: PROJECT_STATE.md, docs/RULES.md, DECISIONS.md, HANDOFF.md
- Tests: `python3 -I tests/test_engine.py`
- Drive a verse: `python3 -I src/cli.py verses/NAME.json new 10`, then `add`, `word`, `pattern`, `pron`, `report`, `export`
- data/cmudict.dict: CMU Pronouncing Dictionary (license in data/CMUDICT_LICENSE)
