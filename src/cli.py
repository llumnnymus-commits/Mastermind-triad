"""Operate on a saved verse: python3 -I src/cli.py <verse.json> <op> [args...]
ops: new <pattern e.g. 10 or 10,6> | add "<line>" | line <n> "<text>" | span <n> <start> <end> "<words>"
     word <n> <idx> "<word>" | delete <n> | pattern <p> | lock <n> [idx] | unlock <n> [idx]
     syl <word> <n> | pron <word> "<ARPABET>" | waive <CODE> <n> | undo | cand <n> <idx> [rhymes_with]
     report [out.md] | export
Line numbers and word indexes are 1-based for humans."""
import os, sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from verse import Verse, Rejected
import report


def pat(s):
    p = [int(x) for x in s.split(",")]
    return p[0] if len(p) == 1 else p


def main(a):
    path, op, args = a[0], a[1], a[2:]
    v = Verse(pat(args[0])) if op == "new" else Verse.load(path)
    n = lambda i: int(args[i]) - 1
    try:
        if op == "new": pass
        elif op == "add": v.add_line(args[0])
        elif op == "line": v.replace_line(n(0), args[1])
        elif op == "span": v.replace_span(n(0), n(1), int(args[2]), args[3])
        elif op == "word": v.replace_word(n(0), n(1), args[2])
        elif op == "delete": v.delete_line(n(0))
        elif op == "pattern":
            bad = v.set_pattern(pat(args[0]))
            for b in bad: print(f"line {b['line']+1}: {b['state']} ({b['count']} vs {b['target']})")
        elif op in ("lock", "unlock"): v.lock(n(0), n(1) if len(args) > 1 else None, on=(op == "lock"))
        elif op == "syl": v.set_override(args[0], int(args[1]))
        elif op == "pron": v.set_pronunciation(args[0], args[1])
        elif op == "waive": v.waive(args[0], n(1))
        elif op == "undo": v.undo()
        elif op == "cand": print(" ".join(v.candidates(n(0), n(1), rhymes_with=args[2] if len(args) > 2 else None)))
        elif op == "report":
            md = report.render(v, os.path.splitext(os.path.basename(path))[0])
            if args: open(args[0], "w").write(md)
            print(md)
        elif op == "export": print(v.export())
        else: raise SystemExit(__doc__)
    except Rejected as e:
        print("REJECTED", e.code, "-", e.detail)
    v.save(path)


if __name__ == "__main__":
    main(sys.argv[1:])
