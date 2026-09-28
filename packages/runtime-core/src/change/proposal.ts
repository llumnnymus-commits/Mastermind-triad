import { z } from 'zod';
import { NodeIdSchema } from '../graph/nodes.js';
import type { ProjectGraph } from '../graph/graph.js';
import type { Intent } from '../intent/intent.js';
import type { ImpactResult } from '../impact/resolve.js';

/**
 * A path inside the mirror workspace.
 *
 * Rejected at parse time rather than at write time, because a proposal is
 * model output: it arrives as data from something that may be wrong, may be
 * confused, or — on an ingested repository whose contents shaped the prompt —
 * may have been steered. An absolute path or one climbing out of the workspace
 * is refused here, before anything downstream has a chance to trust it.
 *
 * This is the first of two checks, not the only one: `applyProposal` resolves
 * every path again against the real filesystem, because a lexical test cannot
 * see a symlink.
 */
export const EditPathSchema = z
  .string()
  .min(1)
  .refine((p) => !p.startsWith('/'), 'edit path must be relative to the workspace')
  .refine((p) => !/(^|\/)\.\.(\/|$)/.test(p), 'edit path must not climb out of the workspace')
  .refine((p) => !p.includes('\0'), 'edit path must not contain a null byte');

export const FileEditSchema = z.union([
  z.object({
    path: EditPathSchema,
    /** Full contents. Create and overwrite are the same operation. */
    contents: z.string(),
  }),
  z.object({
    path: EditPathSchema,
    delete: z.literal(true),
  }),
]);

export type FileEdit = z.infer<typeof FileEditSchema>;

export const ChangeProposalSchema = z.object({
  intentId: z.string().min(1),
  /** Why the proposer believes these edits accomplish the intent. */
  rationale: z.string().min(1),
  edits: z.array(FileEditSchema),
  /**
   * The nodes the proposer *claims* it will affect.
   *
   * Recorded and compared against what re-ingesting the mirror actually finds.
   * It is never used as the after-graph: a proposer supplying both the change
   * and the description of the change would be marking its own homework, and
   * scope adherence would stop being a check and become a formality.
   */
  expectedNodes: z.array(NodeIdSchema).default([]),
});

export type ChangeProposal = z.infer<typeof ChangeProposalSchema>;

export function parseChangeProposal(input: unknown): ChangeProposal {
  return ChangeProposalSchema.parse(input);
}

/**
 * Something that turns an intent into a concrete set of edits.
 *
 * Shaped like `BehavioralEvaluator`: an interface with the real implementation
 * living outside the core, so the runtime's own logic stays testable without a
 * model, a network, or a credential.
 *
 * A proposer is given the graph and the impact walk so it can see what the
 * runtime already predicts the change will touch. It is not obliged to stay
 * inside that prediction — it cannot be — but whether it did is exactly what
 * behavioral validation measures afterwards.
 */
export interface ChangeProposer {
  readonly name: string;
  propose(intent: Intent, graph: ProjectGraph, impact: ImpactResult): Promise<ChangeProposal>;
}

/** What actually happened on disk when a proposal was applied. */
export interface AppliedChange {
  readonly proposal: ChangeProposal;
  readonly written: readonly string[];
  readonly deleted: readonly string[];
  /** Edits refused, with the reason. A non-empty list means the apply was partial. */
  readonly refused: readonly { path: string; reason: string }[];
}
