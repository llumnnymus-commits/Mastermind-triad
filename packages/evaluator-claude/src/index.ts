import Anthropic from '@anthropic-ai/sdk';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
// zod/v4, not zod: the SDK's structured-output helper is typed against the v4
// schema internals, which zod 3.25 ships under this subpath. Importing the v3
// surface compiles everywhere except the one call that matters.
import { z } from 'zod/v4';
import type {
  BehavioralEvaluator,
  EvaluationContext,
  GraphDiff,
  Intent,
} from '@lbr/runtime-core';

/**
 * The verdict shape the judge must return.
 *
 * `unclear` is a first-class answer rather than a failure mode. The runtime
 * treats an inconclusive behavioral check as not passing, so a judge that
 * cannot tell has somewhere honest to land — and does not have to choose
 * between inventing confidence and erroring out.
 */
const VerdictSchema = z.object({
  verdict: z.enum(['met', 'not_met', 'unclear']),
  reasoning: z.string(),
  /** What the judge would have needed in order to decide, when it could not. */
  missingEvidence: z.array(z.string()),
});

export type Verdict = z.infer<typeof VerdictSchema>;

const SYSTEM_PROMPT = `You judge whether a software change accomplished what it set out to do.

You are given an intent — what someone wanted, why, and the condition they said
would mean success — and the evidence a build runtime collected: a structural
diff of the project graph, and what the runtime predicted the change would
touch before anything was written.

What the evidence can and cannot show:

- The graph diff shows structure. Nodes and edges added, removed, or altered:
  modules, screens, services, data, infrastructure, policy, tests.
- It does NOT show runtime behavior. It cannot tell you a feature works, that a
  value is correct at execution time, that data was backfilled, or that a user
  flow still completes. A success condition that asserts any of those is not
  decidable from a diff alone.

Answer with one of three verdicts:

- "met" — the evidence positively shows the success condition holds. Not "the
  change looks plausible", not "nothing appears broken". You must be able to
  point at what in the evidence establishes it.
- "not_met" — the evidence positively shows the condition does not hold, or
  shows the change did something other than what was asked.
- "unclear" — the evidence does not reach the claim. This is the correct answer
  whenever the success condition asserts runtime behavior you cannot observe
  here, whenever the diff is consistent with both success and failure, or
  whenever you would have to assume something to conclude.

The single most important rule: absence of evidence of a problem is not
evidence of success. A clean diff with no visible issues is "unclear", not
"met", unless the diff itself demonstrates the condition. A downstream gate
treats "unclear" as not passing, so answering honestly costs nothing and
guessing costs everything.

When the verdict is "unclear", list in missingEvidence what you would have
needed — a passing test that exercises the behavior, a runtime assertion, a
migration record — so the intent can be written more checkably next time.`;

export interface ClaudeEvaluatorOptions {
  /**
   * The client to use. Injectable so the evaluator's own logic — prompt
   * construction, verdict mapping, failure handling — is testable without a
   * network call or an API key.
   */
  readonly client?: Anthropic;
  readonly model?: string;
  readonly maxTokens?: number;
  /** Cap on diff entries rendered into the prompt. */
  readonly maxDiffEntries?: number;
}

/**
 * A BehavioralEvaluator backed by Claude.
 *
 * Until this existed, every success condition came back `inconclusive`, which
 * is honest but means the runtime could never actually confirm a change did
 * what was asked — only that nothing visibly broke.
 *
 * The judge is given the evidence the runtime already collected rather than
 * asked to imagine anything, and is told plainly what that evidence cannot
 * show. Most of behavioral validation is still decided by diffing the graph;
 * this covers the one question a diff cannot answer on its own.
 */
export class ClaudeEvaluator implements BehavioralEvaluator {
  readonly #client: Anthropic;
  readonly #model: string;
  readonly #maxTokens: number;
  readonly #maxDiffEntries: number;

  constructor(options: ClaudeEvaluatorOptions = {}) {
    this.#client = options.client ?? new Anthropic();
    this.#model = options.model ?? 'claude-opus-5';
    this.#maxTokens = options.maxTokens ?? 16000;
    this.#maxDiffEntries = options.maxDiffEntries ?? 60;
  }

  async evaluateSuccessCondition(
    intent: Intent,
    context: EvaluationContext,
  ): Promise<{ verdict: 'met' | 'not_met' | 'unclear'; reasoning: string }> {
    // Decided without asking: if nothing changed, the change did not happen,
    // and no amount of judgment makes an empty diff into a fulfilled intent.
    // Calling the model here would be spending money to be told what is
    // already on the page.
    if (isEmpty(context.diff)) {
      return {
        verdict: 'not_met',
        reasoning:
          'the project graph is unchanged, so the intent was not carried out — if this was a dry run, the honest answer to "did the change work" is still no',
      };
    }

    try {
      const response = await this.#client.messages.parse({
        model: this.#model,
        max_tokens: this.#maxTokens,
        thinking: { type: 'adaptive' },
        system: SYSTEM_PROMPT,
        messages: [{ role: 'user', content: this.#renderEvidence(intent, context) }],
        output_config: { format: zodOutputFormat(VerdictSchema) },
      });

      // Opus 5 runs safety classifiers; a decline arrives as HTTP 200 with no
      // usable content, so it is checked before the content is read.
      if (response.stop_reason === 'refusal') {
        return {
          verdict: 'unclear',
          reasoning: `the judge declined to answer (${response.stop_details?.category ?? 'unspecified'}), so nothing was established either way`,
        };
      }

      const parsed = response.parsed_output;
      if (parsed === null || parsed === undefined) {
        return {
          verdict: 'unclear',
          reasoning:
            'the judge returned no parseable verdict, so nothing was established either way',
        };
      }

      return {
        verdict: parsed.verdict,
        reasoning:
          parsed.verdict === 'unclear' && parsed.missingEvidence.length > 0
            ? `${parsed.reasoning} (would need: ${parsed.missingEvidence.join('; ')})`
            : parsed.reasoning,
      };
    } catch (error) {
      // A judge that cannot be reached has established nothing. Returning
      // `unclear` rather than throwing keeps a network failure from taking
      // down a validation run, and keeps it from passing one either: the
      // caller treats inconclusive as not passing.
      return {
        verdict: 'unclear',
        reasoning: `the judge could not be reached (${(error as Error).message}), so nothing was established either way`,
      };
    }
  }

  /**
   * Render what the runtime observed.
   *
   * Deliberately factual. The judge is shown the intent and the evidence, and
   * is not told what the runtime thinks the answer is — a summary that leads
   * with a conclusion gets that conclusion agreed with.
   */
  #renderEvidence(intent: Intent, context: EvaluationContext): string {
    const { diff, impact } = context;
    const cap = this.#maxDiffEntries;

    const lines: string[] = [
      '# Intent',
      `Goal: ${intent.goal}`,
      `Why: ${intent.rationale}`,
      `Success condition: ${intent.successCondition}`,
      `Actions performed: ${intent.actions.join(', ')}`,
      `Directly targeted: ${intent.targets.join(', ')}`,
      '',
      '# What the runtime predicted this would touch, before anything was written',
      `${impact.structuralCount} structural node(s), magnitude ${impact.magnitude}`,
      `At risk of breaking: ${impact.blastRadius.map((n) => n.id).join(', ') || 'nothing'}`,
      `Tests attached to the affected nodes: ${impact.verifications.map((n) => n.id).join(', ') || 'none'}`,
    ];

    if (!impact.coverage.complete) {
      lines.push(
        `NOTE: the impact walk did not finish — ${impact.coverage.depthLimited} node(s) were left unexplored at confidence up to ${impact.coverage.highestUnexplored}. The prediction above is incomplete.`,
      );
    }

    lines.push('', '# What actually changed in the graph');
    lines.push(...section('Nodes added', diff.addedNodes.map((n) => `${n.id} (${n.kind}) ${n.name}`), cap));
    lines.push(...section('Nodes removed', diff.removedNodes.map((n) => `${n.id} (${n.kind}) ${n.name}`), cap));
    lines.push(
      ...section(
        'Nodes changed',
        diff.changedNodes.map((c) => `${c.id}: ${c.fields.join(', ')} changed`),
        cap,
      ),
    );
    lines.push(
      ...section('Edges added', diff.addedEdges.map((e) => `${e.from} --${e.type}--> ${e.to}`), cap),
    );
    lines.push(
      ...section('Edges removed', diff.removedEdges.map((e) => `${e.from} --${e.type}--> ${e.to}`), cap),
    );

    return lines.join('\n');
  }
}

function section(title: string, entries: readonly string[], cap: number): string[] {
  if (entries.length === 0) return [`${title}: none`];
  const shown = entries.slice(0, cap);
  const lines = [`${title} (${entries.length}):`, ...shown.map((e) => `  - ${e}`)];
  if (entries.length > shown.length) {
    lines.push(`  …and ${entries.length - shown.length} more, not shown`);
  }
  return lines;
}

function isEmpty(diff: GraphDiff): boolean {
  return (
    diff.addedNodes.length === 0 &&
    diff.removedNodes.length === 0 &&
    diff.changedNodes.length === 0 &&
    diff.addedEdges.length === 0 &&
    diff.removedEdges.length === 0
  );
}
