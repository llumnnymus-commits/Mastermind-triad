import Anthropic from '@anthropic-ai/sdk';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import { z } from 'zod/v4';
import {
  parseChangeProposal,
  type ChangeProposal,
  type ChangeProposer,
  type CostEvent,
  type ImpactResult,
  type Intent,
  type ProjectGraph,
} from '@lbr/runtime-core';

export * from './decompose.js';

/**
 * Whether a credential for the default client is configured.
 *
 * The SDK does **not** throw when constructed without one — it builds a client
 * whose `apiKey` is null and fails at request time. Constructing one and
 * treating success as "a model is available" therefore reports a proposer that
 * cannot propose, and the failure then arrives after a mirror has been
 * materialized, as an auth error out of the SDK rather than as "nothing can
 * write a change". This is the check that actually answers the question, kept
 * here so callers do not have to know which fields the SDK reads.
 */
export function credentialConfigured(client?: Anthropic): boolean {
  const resolved = client ?? new Anthropic();
  return resolved.apiKey !== null || resolved.authToken !== null;
}

const ProposalOutputSchema = z.object({
  rationale: z.string(),
  edits: z.array(
    z.object({
      path: z.string(),
      /** Full file contents. Absent means delete. */
      contents: z.string().nullable(),
    }),
  ),
  expectedNodes: z.array(z.string()),
});

const SYSTEM_PROMPT = `You write the actual code for one step of building or
changing a software project.

You are given an intent — what is wanted and the condition that means success —
the files that already exist, and what the runtime predicts this change will
touch. You return complete file contents, not patches or diffs.

How your output is used, which should shape it:

- Every file you return is written whole. Return the ENTIRE file including the
  parts you did not change. A partial file silently truncates the real one.
- Your edits are applied in an isolated copy, then the project is compiled and
  its tests are run. Code that does not compile fails the step. This is checked,
  not assumed, so there is no benefit to optimism.
- The project is then re-read and compared against the prediction you were
  shown. Touching a file outside what the change plausibly needs is reported as
  the change exceeding its stated scope. Stay inside the work.
- Paths are relative to the project root and must not be absolute or contain
  "..". Anything else is refused before it is applied.

Write real, working code. Include tests for what you add — the runtime runs
them, so a test that asserts nothing is worse than no test. Prefer the smallest
change that genuinely satisfies the success condition.`;

export interface ClaudeProposerOptions {
  /** Injectable so the proposer's own logic is testable with no network or key. */
  readonly client?: Anthropic;
  readonly model?: string;
  readonly maxTokens?: number;
  /** Files whose contents are shown to the model, relative to the project root. */
  readonly context?: ReadonlyMap<string, string>;
  /** Called with what the request actually cost, for attribution. */
  readonly onCost?: (event: CostEvent) => void;
}

/**
 * A ChangeProposer backed by Claude.
 *
 * This is the piece that makes the runtime able to build something rather than
 * only inspect it. It follows the pattern `@lbr/evaluator-claude` established:
 * injectable client, structured output, and no invention on a failure path.
 *
 * It does not get to decide whether its output is any good. That is the rest of
 * the system's job — the edits go through the same path confinement, the same
 * isolated mirror, the same real build and tests, and the same scope analysis
 * as a change written by hand.
 */
export class ClaudeProposer implements ChangeProposer {
  readonly name = 'claude';
  readonly #client: Anthropic;
  readonly #model: string;
  readonly #maxTokens: number;
  readonly #context: ReadonlyMap<string, string>;
  readonly #onCost: ((event: CostEvent) => void) | undefined;

  constructor(options: ClaudeProposerOptions = {}) {
    this.#client = options.client ?? new Anthropic();
    this.#model = options.model ?? 'claude-opus-5';
    this.#maxTokens = options.maxTokens ?? 32000;
    this.#context = options.context ?? new Map();
    this.#onCost = options.onCost;
  }

  async propose(
    intent: Intent,
    graph: ProjectGraph,
    impact: ImpactResult,
  ): Promise<ChangeProposal> {
    const response = await this.#client.messages.parse({
      model: this.#model,
      max_tokens: this.#maxTokens,
      thinking: { type: 'adaptive' },
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: this.#renderRequest(intent, graph, impact) }],
      output_config: { format: zodOutputFormat(ProposalOutputSchema) },
    });

    // Reported before any failure path returns, so a refused or unparseable
    // response still accounts for what it cost.
    this.#reportCost(intent, response.usage);

    if (response.stop_reason === 'refusal') {
      throw new Error(
        `the proposer declined to write this change (${response.stop_details?.category ?? 'unspecified'})`,
      );
    }

    const parsed = response.parsed_output;
    if (parsed === null || parsed === undefined) {
      throw new Error('the proposer returned no parseable proposal');
    }

    // Reparsed through the runtime's own schema rather than trusted: that is
    // where absolute and climbing paths are refused, and it is the same gate a
    // hand-written proposal passes through.
    return parseChangeProposal({
      intentId: intent.id,
      rationale: parsed.rationale,
      edits: parsed.edits.map((e) =>
        e.contents === null ? { path: e.path, delete: true } : { path: e.path, contents: e.contents },
      ),
      expectedNodes: parsed.expectedNodes,
    });
  }

  #reportCost(intent: Intent, usage: { input_tokens?: number; output_tokens?: number } | undefined): void {
    if (this.#onCost === undefined || usage === undefined) return;

    // Claude Opus 5 list pricing, per the model table: $5/MTok in, $25/MTok out.
    const usd =
      ((usage.input_tokens ?? 0) / 1_000_000) * 5 +
      ((usage.output_tokens ?? 0) / 1_000_000) * 25;

    this.#onCost({
      nodeId: intent.targets[0]!,
      category: 'model_inference',
      usd: Math.round(usd * 1e6) / 1e6,
      at: new Date().toISOString(),
      detail: {
        inputTokens: usage.input_tokens ?? 0,
        outputTokens: usage.output_tokens ?? 0,
      },
    });
  }

  #renderRequest(intent: Intent, graph: ProjectGraph, impact: ImpactResult): string {
    const lines: string[] = [
      '# What is wanted',
      intent.goal,
      '',
      `Why: ${intent.rationale}`,
      `Success means: ${intent.successCondition}`,
      '',
      '# What the runtime predicts this will touch',
      `${impact.structuralCount} node(s) implicated.`,
      `At risk of breaking: ${impact.blastRadius.map((n) => n.node.name).join(', ') || 'nothing'}`,
    ];

    if (!impact.coverage.complete) {
      lines.push(
        'NOTE: the impact walk did not finish, so the prediction above is incomplete.',
      );
    }

    lines.push('', '# Files that exist');
    const names = [...graph.nodes()]
      .filter((n) => typeof n.attributes['path'] === 'string')
      .map((n) => n.name)
      .sort();
    lines.push(names.length > 0 ? names.map((n) => `  ${n}`).join('\n') : '  (none yet)');

    if (this.#context.size > 0) {
      lines.push('', '# Current contents of the files most relevant to this change');
      for (const [path, contents] of this.#context) {
        lines.push('', `## ${path}`, '```typescript', contents, '```');
      }
    }

    return lines.join('\n');
  }
}
