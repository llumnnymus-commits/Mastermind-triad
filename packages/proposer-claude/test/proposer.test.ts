import { describe, it, expect, vi } from 'vitest';
import type Anthropic from '@anthropic-ai/sdk';
import { ProjectGraph, parseIntent, resolveImpact, type CostEvent } from '@lbr/runtime-core';
import { nodeAppTarget } from '@lbr/app-target-node';
import {
  BuildPlanSchema,
  ClaudeProposer,
  credentialConfigured,
  decompose,
} from '../src/index.js';

function graph(): ProjectGraph {
  return ProjectGraph.from(
    [
      {
        id: 'code:module:src_core',
        kind: 'module',
        name: 'src/core.ts',
        attributes: { path: 'src/core.ts' },
      },
    ],
    [],
  );
}

const intent = parseIntent({
  id: 'i_prop',
  goal: 'Add a greet function',
  rationale: 'the app needs to greet',
  source: 'human',
  raisedBy: 'actor:human:cli',
  targets: ['code:module:src_core'],
  actions: ['code_change'],
  successCondition: 'greet("x") returns "hello x", covered by a test',
});

function clientReturning(response: unknown): Anthropic {
  return { messages: { parse: vi.fn().mockResolvedValue(response) } } as unknown as Anthropic;
}

function proposalResponse(
  parsed: unknown,
  extra: Record<string, unknown> = {},
): unknown {
  return {
    stop_reason: 'end_turn',
    parsed_output: parsed,
    usage: { input_tokens: 1000, output_tokens: 500 },
    ...extra,
  };
}

describe('proposing a change', () => {
  it('returns edits the runtime can apply', async () => {
    const client = clientReturning(
      proposalResponse({
        rationale: 'adds greet',
        edits: [{ path: 'src/core.ts', contents: 'export const greet = (n: string) => `hello ${n}`;' }],
        expectedNodes: ['code:module:src_core'],
      }),
    );

    const proposal = await new ClaudeProposer({ client }).propose(
      intent,
      graph(),
      resolveImpact(graph(), intent),
    );

    expect(proposal.intentId).toBe('i_prop');
    expect(proposal.edits).toHaveLength(1);
    expect(proposal.edits[0]).toMatchObject({ path: 'src/core.ts' });
  });

  it('turns a null body into a delete', async () => {
    const client = clientReturning(
      proposalResponse({
        rationale: 'removes a dead file',
        edits: [{ path: 'src/old.ts', contents: null }],
        expectedNodes: [],
      }),
    );
    const proposal = await new ClaudeProposer({ client }).propose(
      intent,
      graph(),
      resolveImpact(graph(), intent),
    );
    expect(proposal.edits[0]).toEqual({ path: 'src/old.ts', delete: true });
  });

  it('refuses a path that escapes, at the runtime schema rather than on trust', async () => {
    // The model's output goes through exactly the gate a hand-written proposal
    // does. Nothing is accepted because of where it came from.
    const client = clientReturning(
      proposalResponse({
        rationale: 'writes outside the project',
        edits: [{ path: '../../../etc/passwd', contents: 'x' }],
        expectedNodes: [],
      }),
    );

    await expect(
      new ClaudeProposer({ client }).propose(intent, graph(), resolveImpact(graph(), intent)),
    ).rejects.toThrow(/climb out of the workspace/);
  });

  it('refuses an absolute path', async () => {
    const client = clientReturning(
      proposalResponse({
        rationale: 'absolute',
        edits: [{ path: '/tmp/evil.ts', contents: 'x' }],
        expectedNodes: [],
      }),
    );
    await expect(
      new ClaudeProposer({ client }).propose(intent, graph(), resolveImpact(graph(), intent)),
    ).rejects.toThrow(/relative to the workspace/);
  });
});

describe('the proposer does not invent a change when it cannot produce one', () => {
  it('throws rather than returning an empty proposal when declined', async () => {
    // An empty proposal would read downstream as "the change was applied and
    // touched nothing", which is a lie about what happened.
    const client = clientReturning({
      stop_reason: 'refusal',
      stop_details: { category: 'cyber' },
      parsed_output: null,
      usage: { input_tokens: 10, output_tokens: 0 },
    });

    await expect(
      new ClaudeProposer({ client }).propose(intent, graph(), resolveImpact(graph(), intent)),
    ).rejects.toThrow(/declined to write this change/);
  });

  it('throws on an unparseable response', async () => {
    const client = clientReturning(proposalResponse(null));
    await expect(
      new ClaudeProposer({ client }).propose(intent, graph(), resolveImpact(graph(), intent)),
    ).rejects.toThrow(/no parseable proposal/);
  });
});

describe('what it costs is measured, not estimated', () => {
  it('reports real token usage attributed to the target node', async () => {
    const costs: CostEvent[] = [];
    const client = clientReturning(
      proposalResponse({
        rationale: 'x',
        edits: [{ path: 'src/core.ts', contents: 'export const a = 1;' }],
        expectedNodes: [],
      }),
    );

    await new ClaudeProposer({ client, onCost: (e) => costs.push(e) }).propose(
      intent,
      graph(),
      resolveImpact(graph(), intent),
    );

    expect(costs).toHaveLength(1);
    expect(costs[0]!.nodeId).toBe('code:module:src_core');
    expect(costs[0]!.category).toBe('model_inference');
    // 1000 in @ $5/MTok + 500 out @ $25/MTok = $0.005 + $0.0125
    expect(costs[0]!.usd).toBeCloseTo(0.0175, 6);
    expect(costs[0]!.detail).toEqual({ inputTokens: 1000, outputTokens: 500 });
  });

  it('still accounts for a request that was declined', async () => {
    const costs: CostEvent[] = [];
    const client = clientReturning({
      stop_reason: 'refusal',
      stop_details: { category: 'cyber' },
      parsed_output: null,
      usage: { input_tokens: 800, output_tokens: 0 },
    });

    await new ClaudeProposer({ client, onCost: (e) => costs.push(e) })
      .propose(intent, graph(), resolveImpact(graph(), intent))
      .catch(() => undefined);

    expect(costs).toHaveLength(1);
    expect(costs[0]!.usd).toBeCloseTo(0.004, 6);
  });
});

describe('what the proposer is shown', () => {
  async function capture(context?: ReadonlyMap<string, string>): Promise<string> {
    const parse = vi.fn().mockResolvedValue(
      proposalResponse({ rationale: 'x', edits: [], expectedNodes: [] }),
    );
    const options = context === undefined ? {} : { context };
    await new ClaudeProposer({
      client: { messages: { parse } } as unknown as Anthropic,
      ...options,
    }).propose(intent, graph(), resolveImpact(graph(), intent));
    const call = parse.mock.calls[0]![0] as { system: string; messages: { content: string }[] };
    return `${call.system}\n${call.messages[0]!.content}`;
  }

  it('states the success condition it has to satisfy', async () => {
    expect(await capture()).toContain('greet("x") returns "hello x"');
  });

  it('tells it that whole files are written, not patches', async () => {
    // The failure this prevents is a partial file silently truncating the real
    // one when it is written whole.
    expect(await capture()).toContain('Return the ENTIRE file');
  });

  it('tells it the work is compiled and tested, so optimism buys nothing', async () => {
    expect(await capture()).toContain('no benefit to optimism');
  });

  it('shows what the runtime predicts, so it can stay inside it', async () => {
    expect(await capture()).toContain('What the runtime predicts this will touch');
  });

  it('includes the contents of files it was given as context', async () => {
    const prompt = await capture(new Map([['src/core.ts', 'export const core = 1;']]));
    expect(prompt).toContain('## src/core.ts');
    expect(prompt).toContain('export const core = 1;');
  });
});

describe('decomposing an application into steps', () => {
  it('returns an ordered plan', async () => {
    const client = clientReturning({
      stop_reason: 'end_turn',
      parsed_output: {
        appName: 'notes',
        summary: 'a note taker',
        steps: [
          {
            id: 'store',
            goal: 'add an in-memory note store',
            rationale: 'everything else needs somewhere to put notes',
            successCondition: 'add and list round-trip, covered by a test',
            files: ['src/store.ts', 'src/store.test.ts'],
          },
        ],
      },
      usage: { input_tokens: 1, output_tokens: 1 },
    });

    const plan = await decompose('a note taking app', nodeAppTarget, { client });
    expect(plan.appName).toBe('notes');
    expect(plan.steps[0]!.files).toContain('src/store.ts');
  });

  it('throws rather than inventing a plan when the planner declines', async () => {
    // Without a plan there is nothing to build, and a locally invented one
    // would produce an application nobody asked for.
    const client = clientReturning({
      stop_reason: 'refusal',
      stop_details: { category: 'cyber' },
      parsed_output: null,
    });
    await expect(decompose('x', nodeAppTarget, { client })).rejects.toThrow(/declined/);
  });

  it('tells the planner each step must stand up on its own', async () => {
    const parse = vi.fn().mockResolvedValue({
      stop_reason: 'end_turn',
      parsed_output: { appName: 'a', summary: 's', steps: [{ id: 'x', goal: 'g', rationale: 'r', successCondition: 'c', files: ['f'] }] },
    });
    await decompose('an app', nodeAppTarget, {
      client: { messages: { parse } } as unknown as Anthropic,
    });
    const system = (parse.mock.calls[0]![0] as { system: string }).system;
    expect(system).toContain('must leave the project compiling');
    expect(system).toContain('already scaffolded');
  });
});

describe('a build plan is input, not a description of what happened', () => {
  it('refuses a step id that could climb out of a directory', async () => {
    // A step id becomes two filenames: where the step's proposal is read from,
    // and where its lineage is written. An unconstrained id in a plan a model
    // wrote is a read and a write wherever it points.
    for (const id of ['../../etc/passwd', 'a/b', './x', '..', 'has space', 'UPPER']) {
      expect(() =>
        BuildPlanSchema.parse({
          appName: 'notes',
          summary: 's',
          steps: [{ id, goal: 'g', rationale: 'r', successCondition: 'c', files: ['f'] }],
        }),
      ).toThrow();
    }
  });

  it('accepts the shape a real step id has', () => {
    for (const id of ['store', 'search-index', 'step_2', 'a1']) {
      const plan = BuildPlanSchema.parse({
        appName: 'notes',
        summary: 's',
        steps: [{ id, goal: 'g', rationale: 'r', successCondition: 'c', files: ['f'] }],
      });
      expect(plan.steps[0]!.id).toBe(id);
    }
  });

  it('attributes what planning itself cost', async () => {
    // A build that attributes the spend of every step but not the spend of
    // deciding what the steps are reports a number it knows is short.
    const costs: CostEvent[] = [];
    const client = clientReturning({
      stop_reason: 'end_turn',
      parsed_output: {
        appName: 'notes',
        summary: 's',
        steps: [{ id: 'store', goal: 'g', rationale: 'r', successCondition: 'c', files: ['f'] }],
      },
      usage: { input_tokens: 2_000_000, output_tokens: 1_000_000 },
    });

    await decompose('an app', nodeAppTarget, { client, onCost: (e) => costs.push(e) });
    expect(costs).toHaveLength(1);
    expect(costs[0]!.category).toBe('model_inference');
    // $5/MTok in, $25/MTok out.
    expect(costs[0]!.usd).toBeCloseTo(2 * 5 + 1 * 25, 6);
  });

  it('still accounts for planning that was declined', async () => {
    const costs: CostEvent[] = [];
    const client = clientReturning({
      stop_reason: 'refusal',
      stop_details: { category: 'cyber' },
      parsed_output: null,
      usage: { input_tokens: 1000, output_tokens: 10 },
    });

    await expect(
      decompose('x', nodeAppTarget, { client, onCost: (e) => costs.push(e) }),
    ).rejects.toThrow(/declined/);
    expect(costs).toHaveLength(1);
  });
});

describe('detecting whether a model is reachable at all', () => {
  it('does not mistake a constructed client for a configured one', () => {
    // The SDK builds a keyless client without complaint and fails at request
    // time. Treating construction as availability reports a proposer that
    // cannot propose, after a mirror has already been materialized.
    expect(credentialConfigured({ apiKey: null, authToken: null } as unknown as Anthropic)).toBe(
      false,
    );
  });

  it('accepts either an api key or an auth token', () => {
    expect(
      credentialConfigured({ apiKey: 'sk-x', authToken: null } as unknown as Anthropic),
    ).toBe(true);
    expect(
      credentialConfigured({ apiKey: null, authToken: 'tok' } as unknown as Anthropic),
    ).toBe(true);
  });
});
