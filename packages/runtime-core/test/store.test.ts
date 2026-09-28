import { describe, it, expect, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loginAppGraph } from '../src/fixtures/login-app.js';
import { parseIntent } from '../src/intent/intent.js';
import { resolveImpact } from '../src/impact/resolve.js';
import { classifyRisk } from '../src/policy/risk.js';
import { planMirror } from '../src/mirror/plan.js';
import { openLineage, auditPrediction } from '../src/deployment/lineage.js';
import { saveLineage, loadLineage, listLineage } from '../src/store/lineage-store.js';

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

async function scratch(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'lbr-store-'));
  dirs.push(dir);
  return dir;
}

function record(id = 'dep_001') {
  const graph = loginAppGraph();
  const intent = parseIntent({
    id: 'i_store',
    goal: 'Shorten session lifetime',
    rationale: 'security review',
    source: 'agent',
    raisedBy: 'actor:agent:repair_agent',
    targets: ['service:api:auth_service'],
    actions: ['code_change'],
    successCondition: 'sessions expire at 24h',
  });
  const impact = resolveImpact(graph, intent);
  return {
    graph,
    lineage: openLineage({
      deploymentId: id,
      baseRevision: 'rev_abc',
      intent,
      impact,
      risk: classifyRisk(intent, impact),
      mirror: planMirror(graph, intent, impact),
      validation: [],
      rollback: { toDeploymentId: 'none', unrecoverableNodes: [], steps: ['discard'] },
    }),
  };
}

describe('lineage survives the process', () => {
  it('round-trips a record and the graph it was built against', async () => {
    // Until this existed the runtime captured a prediction and dropped it,
    // which means it could never be compared against what actually happened.
    const root = await scratch();
    const { graph, lineage } = record();

    const saved = await saveLineage(root, lineage, graph);
    expect(saved.deploymentId).toBe('dep_001');

    const loaded = await loadLineage(root, 'dep_001');
    expect(loaded.record.intent.goal).toBe('Shorten session lifetime');
    expect(loaded.record.predictedImpact.blastRadius).toEqual(
      lineage.predictedImpact.blastRadius,
    );
  });

  it('rehydrates the graph, not just the ids', async () => {
    // `auditPrediction` compares node ids, which only mean something relative
    // to the graph they came from. A record without its graph is a list of
    // strings nobody can resolve.
    const root = await scratch();
    const { graph, lineage } = record();
    await saveLineage(root, lineage, graph);

    const loaded = await loadLineage(root, 'dep_001');
    expect(loaded.baseGraph.size).toEqual(graph.size);
    expect(loaded.baseGraph.node('service:api:auth_service')?.name).toBe('Authentication service');
  });

  it('supports the audit the persistence exists for', async () => {
    const root = await scratch();
    const { graph, lineage } = record();
    await saveLineage(root, lineage, graph);

    const loaded = await loadLineage(root, 'dep_001');
    const audit = auditPrediction(loaded.record, ['surface:screen:login']);
    expect(audit.recall).toBe(1);
    expect(audit.falseAlarms.length).toBeGreaterThan(0);
  });

  it('lists what has been recorded, newest first', async () => {
    const root = await scratch();
    for (const id of ['dep_001', 'dep_003', 'dep_002']) {
      const { graph, lineage } = record(id);
      await saveLineage(root, lineage, graph);
    }
    expect(await listLineage(root)).toEqual(['dep_003', 'dep_002', 'dep_001']);
  });

  it('treats a project with no lineage as empty rather than an error', async () => {
    expect(await listLineage(await scratch())).toEqual([]);
  });
});

describe('stored lineage is revalidated on the way in', () => {
  it('refuses an unsupported version rather than guessing', async () => {
    const root = await scratch();
    await mkdir(join(root, '.lbr/lineage'), { recursive: true });
    await writeFile(
      join(root, '.lbr/lineage/dep_bad.json'),
      JSON.stringify({ version: 99, record: {}, baseGraph: {} }),
    );
    await expect(loadLineage(root, 'dep_bad')).rejects.toThrow(/unsupported stored lineage version/);
  });

  it('refuses a record missing its graph', async () => {
    const root = await scratch();
    await mkdir(join(root, '.lbr/lineage'), { recursive: true });
    await writeFile(
      join(root, '.lbr/lineage/dep_partial.json'),
      JSON.stringify({ version: 1, record: { deploymentId: 'x' } }),
    );
    await expect(loadLineage(root, 'dep_partial')).rejects.toThrow(/missing its record or base graph/);
  });

  it('refuses a graph that is not valid, rather than loading a broken one', async () => {
    const root = await scratch();
    await mkdir(join(root, '.lbr/lineage'), { recursive: true });
    await writeFile(
      join(root, '.lbr/lineage/dep_corrupt.json'),
      JSON.stringify({
        version: 1,
        record: { deploymentId: 'x' },
        baseGraph: { version: 1, nodes: [{ id: 'not a valid id' }], edges: [], capturedAt: 'x' },
      }),
    );
    await expect(loadLineage(root, 'dep_corrupt')).rejects.toThrow();
  });
});
