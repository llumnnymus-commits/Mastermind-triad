# @lbr/adapter-policy

Populates the `policy` domain of the project graph from a declared file.

This is what makes the authority gate real on a real project. Until a project declares policy, the gate has only the action class and the shape of the graph to work with — enough to notice a change is large, not enough to know that the data it touches is governed by a retention rule somebody agreed to.

## Why policy is declared rather than discovered

Every other domain is observable. Code, tests, dependencies and deployment targets can be read off a repository, and the adapters that do so are just careful readers.

A retention period, an approval requirement, a spending limit are not facts about a repository — they are decisions someone made, and a system that infers them is guessing about precisely the things it is least entitled to guess about. So they are declared, in a file that lives with the project and changes under review like anything else.

## The file

`.lbr/policy.json`, looked for in the ingested directory and then upward, the way essentially every tool locates its configuration. The search stops at the repository root, so ingesting a directory can never pick up an unrelated ancestor's policy.

```json
{
  "version": 1,
  "rules": [
    {
      "id": "invoice_retention",
      "kind": "retention_rule",
      "name": "Invoice retention",
      "rationale": "Finance requires seven years of invoice history",
      "requiresApproval": true,
      "appliesToActions": ["schema_migration", "data_delete"],
      "governs": ["service:table:", "src/billing/"],
      "attributes": { "retentionYears": 7 }
    }
  ]
}
```

- **`requiresApproval`** is stated, not inferred. A rule can bind a change — appear in its constraint set, be recorded in lineage — without demanding approval. Requiring one is a stronger claim and says so.
- **`appliesToActions`** scopes the rule to what it actually has an opinion about. A retention rule governs migrations and deletions; it has no view on whether a worker may be restarted, and a gate that fires on everything is one people learn to click past. Omitted means all actions, which is the conservative reading — a rule that forgot to say what it covers should bind more, not less.
- **`governs`** takes node-id prefixes (`service:table:` covers every table) or source paths (`src/billing/`).

## Two decisions worth explaining

**A rule that matches nothing is reported, not accepted.** An inert rule looks exactly like a rule being obeyed. Someone who wrote a policy and got no enforcement should be told the policy is inert rather than left to infer it from a clean report, so it surfaces as a warning on every ingest.

**Selectors may be source paths, because node ids move.** An id is derived from the path relative to whatever directory was ingested, so `code:module:src_auth` becomes `code:module:packages_api_src_auth` when the ingest starts one level up. A rule written against ids therefore binds or silently stops binding depending on how the tool was invoked — the opposite of what a policy is for. A selector containing `/` is matched against the node's own recorded path, on a segment boundary, and survives the move.

**A malformed file fails loudly.** Continuing with an empty policy set would leave the runtime running unguarded while looking governed, which is the worst of the available outcomes.

## It changes the verdict

This repository declares its own policy in [`.lbr/policy.json`](../../.lbr/policy.json). With it:

```
$ lbr impact packages/runtime-core src/impact/resolve.ts
VERDICT   HIGH · approval required
  · action 'code_change' is classified elevated risk
  · governing policy 'Impact engine changes need review' requires explicit approval
  · impact magnitude 0.884 at or above 0.8

$ lbr impact packages/runtime-core src/impact/resolve.ts --action restart
VERDICT   LOW · an agent may do this unattended
```

Same file, same blast radius. The rule governs code changes to the impact engine and has no opinion about restarting anything.
