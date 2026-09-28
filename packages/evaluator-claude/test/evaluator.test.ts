import { describe, it, expect, vi } from 'vitest';
import type Anthropic from '@anthropic-ai/sdk';
import {
  ProjectGraph,
  diffGraphs,
  parseIntent,
  resolveImpact,
  runBehavioralValidation,
  type EvaluationContext,
  type Intent,
} from '@lbr/runtime-core';
import { ClaudeEvaluator, type Verdict } from '../src/index.js';

function graph(): ProjectGraph {
  return ProjectGraph.from(
    [
      { id: 'service:api:auth', kind: 'api', name: 'Auth service', live: true },
      { id: 'service:table:users', kind: 'table', name: 'users', live: true },
    ],
    [{ from: 'service:api:auth', type: 'writes', to: 'service:table:users' }],
  );
}

const intent: Intent = parseIntent({
  id: 'i_eval',
  goal: 'Add a last_login_at column to the users table',
  rationale: 'Security review requires dormant-session expiry',
  source: 'agent',
  raisedBy: 'actor:agent:repair_agent',
  targets: ['service:table:users'],
  actions: ['schema_migration'],
  successCondition: 'Column exists, is backfilled, and every authentication writes it',
});

/** A graph where something actually moved, so the diff is non-empty. */
function changedGraph(): ProjectGraph {
  const after = graph();
  after.addNode({
    id: 'service:table:users',
    kind: 'table',
    name: 'users',
    live: true,
    attributes: { columns: ['id', 'last_login_at'] },
  });
  return after;
}

function contextWith(after: ProjectGraph): EvaluationContext {
  const before = graph();
  return { diff: diffGraphs(before, after), impact: resolveImpact(before, intent) };
}

/** A stub client shaped like the one call the evaluator makes. */
function clientReturning(response: unknown): Anthropic {
  return { messages: { parse: vi.fn().mockResolvedValue(response) } } as unknown as Anthropic;
}

function verdictResponse(parsed: Verdict | null, stopReason = 'end_turn'): unknown {
  return { stop_reason: stopReason, parsed_output: parsed, content: [] };
}

describe('the judge is only consulted when there is something to judge', () => {
  it('does not call the model when nothing changed', async () => {
    // An empty diff means the change did not happen. Asking a model to rule on
    // that is paying to be told what is already on the page.
    const parse = vi.fn();
    const evaluator = new ClaudeEvaluator({
      client: { messages: { parse } } as unknown as Anthropic,
    });

    const result = await evaluator.evaluateSuccessCondition(intent, contextWith(graph()));

    expect(parse).not.toHaveBeenCalled();
    expect(result.verdict).toBe('not_met');
    expect(result.reasoning).toContain('unchanged');
  });

  it('consults the model once there is a real diff', async () => {
    const client = clientReturning(
      verdictResponse({ verdict: 'met', reasoning: 'column present', missingEvidence: [] }),
    );
    const evaluator = new ClaudeEvaluator({ client });

    const result = await evaluator.evaluateSuccessCondition(intent, contextWith(changedGraph()));

    expect(client.messages.parse).toHaveBeenCalledOnce();
    expect(result.verdict).toBe('met');
  });
});

describe('what the judge is shown', () => {
  async function capturePrompt(): Promise<string> {
    const parse = vi.fn().mockResolvedValue(
      verdictResponse({ verdict: 'unclear', reasoning: 'x', missingEvidence: [] }),
    );
    const evaluator = new ClaudeEvaluator({
      client: { messages: { parse } } as unknown as Anthropic,
    });
    await evaluator.evaluateSuccessCondition(intent, contextWith(changedGraph()));
    const call = parse.mock.calls[0]![0] as { messages: { content: string }[]; system: string };
    return `${call.system}\n${call.messages[0]!.content}`;
  }

  it('gives it the intent and its success condition', async () => {
    const prompt = await capturePrompt();
    expect(prompt).toContain('Add a last_login_at column');
    expect(prompt).toContain('Column exists, is backfilled');
  });

  it('gives it what actually changed', async () => {
    const prompt = await capturePrompt();
    expect(prompt).toContain('Nodes changed');
    expect(prompt).toContain('service:table:users');
  });

  it('tells it plainly that a diff cannot show runtime behavior', async () => {
    // Without this the judge will confidently rule on whether a backfill ran,
    // which a structural diff cannot possibly show.
    const prompt = await capturePrompt();
    expect(prompt).toContain('does NOT show runtime behavior');
  });

  it('tells it that a clean diff is not success', async () => {
    const prompt = await capturePrompt();
    expect(prompt).toContain('absence of evidence of a problem is not');
  });

  it('warns it when the impact walk was incomplete', async () => {
    const parse = vi.fn().mockResolvedValue(
      verdictResponse({ verdict: 'unclear', reasoning: 'x', missingEvidence: [] }),
    );
    const evaluator = new ClaudeEvaluator({
      client: { messages: { parse } } as unknown as Anthropic,
    });
    const before = graph();
    const truncated = resolveImpact(before, intent, { maxDepth: 0 });
    await evaluator.evaluateSuccessCondition(intent, {
      diff: diffGraphs(before, changedGraph()),
      impact: truncated,
    });
    const content = (parse.mock.calls[0]![0] as { messages: { content: string }[] }).messages[0]!
      .content;
    if (!truncated.coverage.complete) {
      expect(content).toContain('did not finish');
    }
  });
});

describe('the judge cannot launder uncertainty into a pass', () => {
  it('reports an unreachable judge as unclear rather than throwing', async () => {
    // A network failure must not take down a validation run, and must not pass
    // one either.
    const client = {
      messages: { parse: vi.fn().mockRejectedValue(new Error('ECONNREFUSED')) },
    } as unknown as Anthropic;

    const result = await new ClaudeEvaluator({ client }).evaluateSuccessCondition(
      intent,
      contextWith(changedGraph()),
    );

    expect(result.verdict).toBe('unclear');
    expect(result.reasoning).toContain('could not be reached');
  });

  it('reports a declined request as unclear', async () => {
    const client = clientReturning({
      stop_reason: 'refusal',
      stop_details: { category: 'cyber' },
      parsed_output: null,
    });
    const result = await new ClaudeEvaluator({ client }).evaluateSuccessCondition(
      intent,
      contextWith(changedGraph()),
    );
    expect(result.verdict).toBe('unclear');
    expect(result.reasoning).toContain('declined');
  });

  it('reports an unparseable verdict as unclear', async () => {
    const client = clientReturning(verdictResponse(null));
    const result = await new ClaudeEvaluator({ client }).evaluateSuccessCondition(
      intent,
      contextWith(changedGraph()),
    );
    expect(result.verdict).toBe('unclear');
  });

  it('carries what the judge said it was missing into the reasoning', async () => {
    const client = clientReturning(
      verdictResponse({
        verdict: 'unclear',
        reasoning: 'the diff shows the column but not the backfill',
        missingEvidence: ['a test asserting last_login_at is written on login'],
      }),
    );
    const result = await new ClaudeEvaluator({ client }).evaluateSuccessCondition(
      intent,
      contextWith(changedGraph()),
    );
    expect(result.reasoning).toContain('would need');
    expect(result.reasoning).toContain('last_login_at is written on login');
  });
});

describe('wired into behavioral validation', () => {
  it('turns a success condition from inconclusive into an actual pass', async () => {
    // Before this evaluator existed, every behavioral report carried
    // `inconclusive` here and could therefore never pass.
    const before = graph();
    const after = changedGraph();
    const client = clientReturning(
      verdictResponse({
        verdict: 'met',
        reasoning: 'the column is present and the auth service writes the table',
        missingEvidence: [],
      }),
    );

    const report = await runBehavioralValidation({
      before,
      after,
      intent,
      impact: resolveImpact(before, intent),
      evaluator: new ClaudeEvaluator({ client }),
    });

    const check = report.checks.find((c) => c.name === 'success condition')!;
    expect(check.status).toBe('pass');
    expect(report.passed).toBe(true);
  });

  it('fails the report when the judge says the intent was not met', async () => {
    const before = graph();
    const client = clientReturning(
      verdictResponse({
        verdict: 'not_met',
        reasoning: 'the change renamed a column instead of adding one',
        missingEvidence: [],
      }),
    );

    const report = await runBehavioralValidation({
      before,
      after: changedGraph(),
      intent,
      impact: resolveImpact(before, intent),
      evaluator: new ClaudeEvaluator({ client }),
    });

    expect(report.checks.find((c) => c.name === 'success condition')!.status).toBe('fail');
    expect(report.passed).toBe(false);
  });
});
