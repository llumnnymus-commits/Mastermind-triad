"""Human-readable verse report (markdown). Lyrics first, then the checks."""
from verse import Verse


def render(v: Verse, title="Verse"):
    r = v.verify()
    labels = r["end_labels"]
    ok, _ = v.exportable()
    live = [x for x in r["rule_violations"] if not x["waived"]]
    status = "READY TO EXPORT" if ok and not r["hygiene_hard"] and not live else "BLOCKED"
    pat = v.pattern[0] if len(v.pattern) == 1 else v.pattern
    out = [f"# {title}", "", f"**Status:** {status} · syllable rule: {pat}" + (" (repeating)" if len(v.pattern) > 1 else " per line"), ""]
    out += ["| # | Line | Syl | Target | End |", "|---|---|---|---|---|"]
    for s, L, lab in zip(r["syllables"], v.lines, labels):
        cnt = s["count"] if s["count"] is not None else "?"
        mark = "" if s["ok"] else f" ⚠ {s['state']}"
        lock = " 🔒" if L["line_lock"] or any(L["locked"]) else ""
        out.append(f"| {s['line']+1} | {' '.join(L['words'])}{lock} | {cnt}{mark} | {s['target']} | {lab} |")
    out += ["", "## Hard checks"]
    bad = [s for s in r["syllables"] if not s["ok"]]
    out.append("- Syllables: " + ("all lines on target" if not bad else "; ".join(
        f"line {s['line']+1} {s['state']}" + (f" by {abs(s['delta'])}" if s.get('delta') else "") +
        (" — unverified: " + ", ".join(f"'{w}' ({st}{' ' + '/'.join(map(str, c)) if c else ''})" for w, st, c in s['problems']) if s.get('problems') else "")
        for s in bad)))
    out.append("- Output hygiene: " + ("clean" if not r["hygiene_hard"] else "; ".join(f"line {h['line']+1}: {h['why']}" for h in r["hygiene_hard"])))
    out.append("- Internal ≠ end rhyme: " + ("clean" if not r["rule_violations"] else ""))
    for x in r["rule_violations"]:
        out.append(f"  - line {x['line']+1}: internal “{x['unit']}” sounds like end “{x['end']}” (line {x['end_line']+1}, {x['kind']})" + (" — waived" if x["waived"] else ""))
    out += ["", "## Sound map (report only)"]
    p = r["pillar"]
    out.append(f"- End rhymes: scheme {''.join(labels)} · {p['lyrical_end_pairs']}/{p['end_pairs']} rhyming end pairs are lyrical (the pillar)")
    for i, j, k in p["secondary_end_pairs"]:
        out.append(f"  - lines {i+1}/{j+1} rely on a {k} rhyme (secondary)")
    if r["internal_groups"]:
        out.append(f"- Internal rhyme families ({len(r['internal_groups'])}):")
        for n, g in enumerate(r["internal_groups"], 1):
            out.append(f"  - I{n} [{', '.join(g['kinds'])}]: " + " · ".join(f"“{u}” (L{l+1})" for l, w, u in g["members"]))
    else:
        out.append("- Internal rhymes: none detected")
    b = r["braid"]
    out.append(f"- Braid: {'yes' if b['braided'] else 'no'} — " + (", ".join(f"{k} on lines {v_}" for k, v_ in b["schemes"].items()) or "no schemes"))
    if r["no_phonemes"]:
        out.append("- No pronunciation (rhyme unknown, never guessed from spelling): " + ", ".join(r["no_phonemes"]))
    if r["cliche_flags"]:
        out.append("- Cliché/meta phrases flagged (allowed, your call): " + "; ".join(f"line {f['line']+1} “{f['match']}”" for f in r["cliche_flags"]))
    if v.lex.pron_overrides or v.lex.overrides:
        out.append("- Your pronunciation/syllable overrides: " + ", ".join(
            [f"{w} = {' '.join(ph)}" for w, ph in v.lex.pron_overrides.items()] + [f"{w} = {n} syl" for w, n in v.lex.overrides.items()]))
    return "\n".join(out) + "\n"
