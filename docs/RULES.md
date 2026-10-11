# RULES — extracted from the 16 uploaded rap documents + the Perplexity 39-principle walkthrough
Updated 2026-10-10. Sources: CRIT=AI_Rap_Song_Training_Criteria · INSTR=AI_Rap_Training_Instructions · MAN=AI_Rap_Training_Manual_Creation · WALK=39-principle walkthrough · BOOT=Rap_Boot_Camp_Curriculum · CORE=Core_Logic_Implementation · PIPE=AI_Rap_Generation_Pipeline · S1/S3-5/S7=Stage PDFs · PHON=Advanced_Rap_Phonetic_Rhyming_Guide · RSM=Advanced_Rhyme_Scheme_Masterclass · LAY=Layering_Complex_Rap_Rhyme_Schemes · STORY=Mastering_Rap_Storytelling · EXP=Expanding_Rap_Lyrical_Principles · CRAFT=Crafting_Rap_from_Any_Text · LIT=Rhyme_Lyrical_Literal_Miracle

Tags
- **U-HARD** user-stated, enforced by the engine now (rejects mutations).
- **D-HARD** a document calls it absolute/forbidden; engine will enforce as a check once built (flagged, user can waive).
- **SOFT** scored or flagged; never blocks.
- **HUMAN** cannot be computed; engine lists it for the user to judge.
- **OUT** training-pipeline only (SFT/LoRA/GRPO/vLLM); not applicable to a mutation engine.

## A. User rules (override everything below)
| # | Rule | Tag | Status |
|---|---|---|---|
| U1 | Every line has the same syllable count, OR a staggered pattern that repeats exactly | U-HARD | BUILT |
| U2 | Target is whatever the user says (5, 10, any); "too much of a mouthful" => user sets a smaller N and lines are cut to it | U-HARD | BUILT |
| U3 | Mutate, never regenerate; corrections change named slots only | U-HARD | BUILT |
| U4 | Rhyme judged by spoken sound (consonance, assonance, alliteration, resonance, phonetics), spelling irrelevant | U-HARD | BUILT |
| U5 | Hard constraints from the docs are followed (this file) | U-HARD | in progress |

## B. Phonetic & rhyme (WALK P1-9)
| Rule | Source | Tag | Status |
|---|---|---|---|
| Rhymes evaluated on ARPABET phonemes; orthographic matching prohibited | INSTR P1 "strictly prohibited", WALK P1 | D-HARD | BUILT (= U4) |
| Perfect rhyme = same stressed vowel + all following sounds, different onset | INSTR P2, WALK P2, EXP | D-HARD (definition) | BUILT |
| Slant rhyme = vowel-family / consonant-family closeness (plosive P/B T/D K/G, fricative F/V S/Z TH/DH, nasal M N NG) | INSTR P3/P6, WALK P3/P6 | SOFT | BUILT (basic). Numeric slant score "> 0.7" is a doc example, not implemented |
| Assonance / consonance: 1-3 core vowel or consonant sounds dominate a stanza; plosives for aggression, sibilants for smooth | INSTR P4/5, WALK P4/5/33 | SOFT | resonance() built; stanza-level palette not yet |
| Multi-syllable rhymes: vowel sequence AND stress pattern must align | INSTR P7 "absolute precision", WALK P7 | D-HARD (for a claimed multi) | partial (tail match; stress-pattern check not built) |
| Mosaic / compound rhymes (phrase vs word/phrase), differing word counts allowed | CRIT, WALK P36/37, RSM 1.2 | SOFT | BUILT (phrases) |
| Internal rhymes required; rhymes not only at line ends | INSTR P8 "forbidden to place rhymes exclusively at line ends" | D-HARD | not built |
| Internal rhyme phonemes distinct from end-rhyme phonemes (Layer_Clash_Threshold) | INSTR P8, MAN | D-HARD | not built — CONFLICT C4 |
| Word bending allowed within a "bending threshold"; else refuse | INSTR P9, MAN | SOFT | not built (needs pronunciation overrides) |
| Syllables inside a word may rhyme (internal syllabic rhyme, tmesis) | RSM 1.3, LIT | SOFT | not built |

## C. Rhythm & flow (WALK P10-16)
| Rule | Source | Tag | Status |
|---|---|---|---|
| A bar = 16 sixteenth-note slots; every syllable mapped to a slot | INSTR P10 | D-HARD (if grid mode on) | not built. Note: max 16 syllables/bar by this model |
| Pocket: square / push / pull is a delivery choice (timing offset ms) | INSTR P11, BOOT | HUMAN | not applicable to text |
| Syncopation: stressed syllables on weak slots (e, &, a) score | INSTR P12 | SOFT | not built |
| Polyrhythm / triplet flow (3-against-2) | INSTR P13 | SOFT | not built |
| Accent displacement: natural stress vs beat stress score | INSTR P14 | SOFT | not built (needs grid) |
| Syllabic weight: heavy syllables (long vowel/diphthong/cluster) **prohibited on fast subdivisions** | INSTR P15 "strictly prohibited" | D-HARD (if grid mode on) | not built |
| Off-beat / enjambed rhyme placement; shift End_Rhyme_Position occasionally | INSTR P16, CRIT 3.2 | SOFT | not built |

## D. Structure (WALK P17-23)
| Rule | Source | Tag | Status |
|---|---|---|---|
| Three layers: primary end scheme, secondary internal multis, tertiary assonance/consonance wash | INSTR P17, WALK P17 | SOFT | not built |
| No static monorhyme for long stretches; use pivot words | INSTR P18 "forbidden" | D-HARD | not built |
| Scheme evolves at quadrant boundaries (~every 4 bars) | INSTR P19, BOOT | SOFT | not built |
| Asymmetric schemes (XAXA): X lines free of rhyme constraints, carry key narrative | INSTR P20 | SOFT | not built — conflicts with internal-rhyme minimums (C5) |
| Introductory dense bar -> 2-3 seed phrases -> parallel schemes | INSTR P21, WALK P21 | SOFT | not built |
| Vertical stacking (4-syl end rhyme + 2-syl internal + assonance + alliteration in one bar) | INSTR P22 | SOFT | not built |
| Horizontal weaving: motif intro Q1, fade Q2, callback Q4 across 16 bars | INSTR P23 | SOFT | not built |
| Braided template (CRIT 5.2): Bar1 intA→endB, Bar2 intA→endB, Bar3 intC→endA, Bar4 intC→endA; >=2 internal rhymes per bar | CRIT | D-HARD (only if braid requested) | not built |

## E. Output hygiene
| Rule | Source | Tag | Status |
|---|---|---|---|
| Zero meta-commentary / markup in lyrics output (regex ban list; -1.0 hard clamp) | CORE, INSTR, CRIT | D-HARD | export returns lyrics only; regex list not implemented |
| Reject nonsense produced only to force a rhyme ("Dr. Seuss effect") | CRIT 3.3, C2 | HUMAN | flagged for user |
| Prefer colloquial/slang over stiff grammar; enallage allowed if meaning stays clear | CRIT, INSTR/WALK P38 | HUMAN | — |
| Never sacrifice meaning for sound repetition; coherence is top priority | WALK intro/P4, STORY | HUMAN (BERTScore >= ~0.85 in INSTR is OUT) | — |

## F. Narrative & craft (WALK P24-39) — all HUMAN
Three-act structure, Griot's Gambit (consciously sacrifice one of story/technique/flow), show-don't-tell, protagonist voice consistency, subtext, power dynamics, sensory palette, character, metaphor/simile, wordplay (clarity test), hyperbole/personification, anaphora. Engine can only *list* these as a checklist beside the verse; it cannot judge them. BOOT final exam (16 bars): clear pocket + >=1 syncopated bar; evolving multi scheme; **>=4 distinct internal rhymes**; coherent theme; >=2 wordplay types.

## G. OUT (not used)
SFT/LoRA r=16, GRPO/PPO, KL beta, vLLM server, BERTScore reward, Annotated-Scansion JSONL, scratchpad prompt format, reward weights (-0.1 per syllable off, +0.2 rhyme bonus). Replaced by hard pass/fail gates.

---
# CONFLICTS — RESOLVED BY USER 2026-10-10
| # | Resolution (user's words in quotes) | Engine |
|---|---|---|
| C1 | Syllables: "go with my rule". All doc ranges void. | BUILT (hard gate) |
| C2 | "Neither perfect rhymes nor slant rhymes are the pillar. Lyrical rhymes are the pillar. All other forms are allowed, but should not be relied upon for auditory aesthetics." | BUILT: `lyrical` kind (multi-syllable spoken-sound chain), ranked first; report shows which end pairs rely on secondary kinds |
| C3 | Internal-rhyme minimums: "no minimum for constraint". | BUILT: counted/reported only |
| C4 | "Internal rhymes should sound different than end rhymes." | BUILT: RULE `INTERNAL_EQUALS_END`, blocks export; user can waive a specific line |
| C5 | Braiding = "multiple distinct rhyme schemes [that] dance around each other", no minimum. | BUILT: braid report (interleaving schemes), never required |
| C6 | Coherence over density (unchanged default). | HUMAN |
| C7 | Grid layer optional/off (unchanged default). | not built |
| C8 | Dictionary count + your overrides (unchanged default). Added: you can state exact pronunciation (ARPABET) for any word; "-in'" forms derive from CMUdict "-ing" (NG→N, same syllables). | BUILT |
| C9 | The doc's miscount was the generating AI's error; doc errors are never carried in. | BUILT (engine recounts everything) |

# DEFINITION — lyrical rhyme (as implemented; tell me if it's wrong)
Two words/phrases are a **lyrical rhyme** when, reading from the end, at least **2 syllables** line up by spoken vowel
sound, across word boundaries:
- the final aligned syllable has the same vowel (or both reduced/unstressed schwa-type) AND its closing consonants agree
  (same, both open, share a consonant, or same family: plosive/fricative/nasal/liquid);
- earlier syllables: stressed vowels must match or be close neighbours; unstressed may drift; average vowel match >= 0.8;
- repeated identical words ("the game / the same", "hold it / fold it") and function-word pairs ("but the / and the")
  are repetition, not rhyme: skipped, not counted.
Examples passing: critic / missed it (2), money / honey (2), limitless art / swimming with sharks (4),
lyrical magician / spiritual mission (6). Failing: holding it / frozen still (vowels only, codas clash).
Single-syllable perfect/slant rhymes are reported as **secondary**.

# RULE — internal ≠ end (as implemented)
Every mid-line word/phrase (paired or not) before the end-rhyme region is compared to the end of its own bar and to
end-schemed bars within ±3 bars. If it rhymes (lyrical, perfect or slant) → `INTERNAL_EQUALS_END`, export blocked
until you change a word or waive that line.
