import { z } from 'zod/v4';
import Anthropic from '@anthropic-ai/sdk';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import type { AppTarget } from '@lbr/app-target-node';
import type { CostEvent } from '@lbr/runtime-core';

/**
 * One step of building an application.
 *
 * The white paper describes the agent constructing a project "one graph-node at
 * a time, providing a plain-English explanation for every stage". That is taken
 * literally here rather than decoratively: each step becomes a real `Intent`
 * with its own success condition, driven through the same impact walk,
 * authority gate, mirror, and validation as any other change. A step that
 * breaks the build stops the run, and the lineage says which one.
 *
 * The alternative — one generation producing a whole app — cannot be validated
 * incrementally, so the first failure invalidates everything and nothing
 * localizes the fault.
 */
export const BuildStepSchema = z.object({
  /**
   * Short slug.
   *
   * Constrained to a filename-safe shape, not as tidiness. This id becomes part
   * of a lineage filename and is used to locate the step's proposal on disk, so
   * an unconstrained one lets a plan — which a model may have written — read and
   * write outside the directories the build was pointed at.
   */
  id: z
    .string()
    .min(1)
    .max(64)
    .regex(
      /^[a-z0-9][a-z0-9_-]*$/,
      'a step id must be lowercase letters, digits, dash or underscore, starting with a letter or digit',
    ),
  /** What this step adds, in plain language. */
  goal: z.string().min(1),
  /** Why it comes at this point in the order. */
  rationale: z.string().min(1),
  /** How to tell the step worked. */
  successCondition: z.string().min(1),
  /** Files this step is expected to create or modify, relative to the app root. */
  files: z.array(z.string().min(1)).min(1),
});

export type BuildStep = z.infer<typeof BuildStepSchema>;

export const BuildPlanSchema = z.object({
  appName: z.string().min(1),
  summary: z.string().min(1),
  steps: z.array(BuildStepSchema).min(1),
});

export type BuildPlan = z.infer<typeof BuildPlanSchema>;

const DECOMPOSE_SYSTEM = `You break an application description into an ordered
sequence of build steps, each of which will be implemented and validated on its
own before the next begins.

Rules that come from how the steps are executed:

- Each step is built in isolation and must leave the project compiling and its
  tests passing. A step that only makes sense once a later step exists is a
  broken step; order them so each one stands up by itself.
- Each step names the files it will touch. Later steps may modify files earlier
  steps created — that is normal — but a step that touches files unrelated to
  its own goal will be rejected by scope analysis, so keep each one tight.
- Every step needs a success condition that could actually be checked by reading
  the code or running the tests. "Works correctly" is not one. "The parser
  returns an empty list for empty input, covered by a test" is.
- Prefer few, substantial steps over many trivial ones. Three to seven is
  usually right for a small application.
- The project is already scaffolded with a package.json, tsconfig, an entry
  point and a passing test. Do not plan steps that recreate those.`;

export interface DecomposeOptions {
  /**
   * Injectable so the planner's own logic is testable with no network or key.
   *
   * Optional, and constructed here when absent, for the same reason
   * `ClaudeProposerOptions.client` is: a caller that only wants the real path
   * should not have to depend on the SDK to get it.
   */
  readonly client?: Anthropic;
  readonly model?: string;
  readonly maxTokens?: number;
  /**
   * Called with what planning actually cost.
   *
   * Decomposition is inference like any other, and a build that attributes the
   * spend of every step but not the spend of deciding what the steps are is
   * reporting a number it knows is short.
   */
  readonly onCost?: (event: CostEvent) => void;
}

/**
 * Turn an application description into an ordered build plan.
 *
 * Returns the plan or throws. Unlike judging — where an unreachable model must
 * degrade to `unclear` rather than take down a validation run — there is no
 * meaningful partial result here: without a plan there is nothing to build, and
 * inventing one locally would produce an app nobody asked for.
 */
export async function decompose(
  description: string,
  target: AppTarget,
  options: DecomposeOptions,
): Promise<BuildPlan> {
  const client = options.client ?? new Anthropic();
  const response = await client.messages.parse({
    model: options.model ?? 'claude-opus-5',
    max_tokens: options.maxTokens ?? 16000,
    thinking: { type: 'adaptive' },
    system: DECOMPOSE_SYSTEM,
    messages: [
      {
        role: 'user',
        content: [
          `Target: ${target.produces}`,
          `Source lives in: ${target.sourceDir}/`,
          '',
          'Application to build:',
          description,
        ].join('\n'),
      },
    ],
    output_config: { format: zodOutputFormat(BuildPlanSchema) },
  });

  // Reported before any failure path throws: a refused or unparseable response
  // still cost what it cost.
  reportPlanningCost(options, response.usage, target);

  if (response.stop_reason === 'refusal') {
    throw new Error(
      `the planner declined to produce a build plan (${response.stop_details?.category ?? 'unspecified'})`,
    );
  }

  const parsed = response.parsed_output;
  if (parsed === null || parsed === undefined) {
    throw new Error('the planner returned no parseable build plan');
  }
  return parsed;
}

/**
 * Attribute planning spend.
 *
 * There is no application node to charge it to yet — the app does not exist,
 * which is the whole point of planning it — so it is attributed to the target
 * itself. Better a node that exists than a plausible id nothing can resolve.
 */
function reportPlanningCost(
  options: DecomposeOptions,
  usage: { input_tokens?: number; output_tokens?: number } | undefined,
  target: AppTarget,
): void {
  if (options.onCost === undefined || usage === undefined) return;

  // Claude Opus 5 list pricing: $5/MTok in, $25/MTok out.
  const usd =
    ((usage.input_tokens ?? 0) / 1_000_000) * 5 + ((usage.output_tokens ?? 0) / 1_000_000) * 25;

  options.onCost({
    nodeId: `code:module:${target.name}` as CostEvent['nodeId'],
    category: 'model_inference',
    usd: Math.round(usd * 1e6) / 1e6,
    at: new Date().toISOString(),
    // `detail` carries measurements only, so the phase is not encoded here.
    // The node id says what this was spent on: the target, before the app it
    // describes exists.
    detail: {
      inputTokens: usage.input_tokens ?? 0,
      outputTokens: usage.output_tokens ?? 0,
    },
  });
}
