# HANDOFF
Start: read PROJECT_STATE.md, docs/RULES.md, DECISIONS.md. Run `python3 -I tests/test_engine.py` (expect 74 pass).
Drive a verse: `python3 -I src/cli.py verses/NAME.json new 10` · `add "line"` · `word 2 3 "new"` (1-based) · `pattern 5` · `pron "reppin'" "R EH1 P IH0 N"` · `waive INTERNAL_EQUALS_END 3` · `undo` · `report out.md` · `export`.
Don't repeat: pip/PyPI and raw.githubusercontent are blocked (CMUdict came via `git clone` through proxy); never zip; no video-pipeline talk; no doc syllable defaults; don't make perfect/slant the pillar.
Open elsewhere: OGM concept doc (artifact 2639c27e-dd26-4e56-b2dd-54f1deb9a4e8) still has a video example to neutralize.
Deliver files individually; never zip.
Backups: Drive folder id 1Y3hpoqmQ9mvxGl3jtziRCr0miqbL8dvz (z.n.parrish1993). GitHub target: llumnnymus-commits/verse-archive (empty, public; supersedes works-archive). Push needs Claude GitHub App access on that repo (403 on 2026-10-11). Then: add_repo(llumnnymus-commits, verse-archive, access="push"); in the project dir `git remote add origin https://github.com/llumnnymus-commits/verse-archive; git push -u origin main`.
