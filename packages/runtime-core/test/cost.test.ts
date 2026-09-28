import { describe, it, expect } from 'vitest';
import { loginAppGraph } from '../src/fixtures/login-app.js';
import { attributeCosts, assessSustainability, type CostEvent } from '../src/cost/attribution.js';

const graph = loginAppGraph();
const at = '2026-09-07T12:00:00.000Z';

const events: CostEvent[] = [
  { nodeId: 'service:api:auth_service', category: 'model_inference', usd: 40, at,
    detail: { promptTokens: 900000, retries: 3 } },
  { nodeId: 'service:api:auth_service', category: 'retrieval', usd: 8, at },
  { nodeId: 'service:table:users', category: 'storage', usd: 2, at },
  { nodeId: 'surface:screen:login', category: 'compute', usd: 1, at },
];

describe('cost attribution', () => {
  const report = attributeCosts(graph, events);
  const find = (id: string) => report.perNode.find((n) => n.nodeId === id)!;

  it('totals what was actually spent', () => {
    expect(report.totalUsd).toBe(51);
  });

  it('attributes direct spend to the node that incurred it', () => {
    expect(find('service:api:auth_service').directUsd).toBe(48);
  });

  it('rolls downstream spend up to the caller that caused it', () => {
    // The login screen costs $1 to render and triggers $48 of inference behind
    // it. A ledger that only counts direct spend calls this a cheap screen.
    const login = find('surface:screen:login');
    expect(login.directUsd).toBe(1);
    expect(login.rolledUpUsd).toBeGreaterThan(48);
  });

  it('breaks spend down by category so the lever is identifiable', () => {
    expect(find('service:api:auth_service').byCategory['model_inference']).toBe(40);
    expect(report.byCategory['model_inference']).toBe(40);
  });

  it('ranks hotspots by rolled-up cost', () => {
    const rolled = report.hotspots.map((h) => h.rolledUpUsd);
    expect([...rolled].sort((a, b) => b - a)).toEqual(rolled);
  });

  it('ignores events tagged to nodes that are not in the graph', () => {
    const withGhost = attributeCosts(graph, [
      ...events,
      { nodeId: 'service:api:ghost', category: 'compute', usd: 999, at },
    ]);
    expect(withGhost.totalUsd).toBe(51);
  });

  it('does not route cost through policy or verification attachments', () => {
    // Tests and policies do not cause the spend of what they govern.
    const test = report.perNode.find((n) => n.nodeId === 'evidence:test:browser_login');
    expect(test).toBeUndefined();
  });
});

describe('sustainability', () => {
  const report = attributeCosts(graph, events);
  const auth = report.perNode.find((n) => n.nodeId === 'service:api:auth_service')!;

  it('calls a feature that clears its cost several times over sustainable', () => {
    const verdict = assessSustainability(auth, {
      nodeId: auth.nodeId,
      dailyValueUsd: 200,
    });
    expect(verdict.verdict).toBe('sustainable');
  });

  it('calls a popular feature that loses money unsustainable', () => {
    // The specification's exact case: engaged users, negative margin.
    const verdict = assessSustainability(auth, { nodeId: auth.nodeId, dailyValueUsd: 10 });
    expect(verdict.verdict).toBe('unsustainable');
    expect(verdict.ratio).toBeLessThan(1);
  });

  it('names the dominant cost driver rather than saying "reduce cost"', () => {
    const verdict = assessSustainability(auth, { nodeId: auth.nodeId, dailyValueUsd: 10 });
    expect(verdict.recommendation).toContain('inference');
    expect(verdict.recommendation).toMatch(/context|retries|oversized/);
  });

  it('does not treat an unmeasured benefit as a zero benefit', () => {
    const verdict = assessSustainability(auth, undefined);
    expect(verdict.verdict).toBe('unknown');
    expect(verdict.recommendation).toContain('not the same as the benefit being zero');
  });

  it('normalizes cost over the observation window', () => {
    const oneDay = assessSustainability(auth, { nodeId: auth.nodeId, dailyValueUsd: 100 }, 1);
    const sevenDays = assessSustainability(auth, { nodeId: auth.nodeId, dailyValueUsd: 100 }, 7);
    expect(sevenDays.dailyCostUsd).toBeLessThan(oneDay.dailyCostUsd);
  });
});

describe('hotspot ranking', () => {
  it('excludes pure conduits that spend nothing themselves', () => {
    // The LoginView module implements the login screen, which depends on the
    // auth service that does the spending. Ranking on roll-up alone would put
    // the module first — it inherits everything beneath it and spends nothing.
    const report = attributeCosts(graph, events);
    const conduit = report.perNode.find((n) => n.nodeId === 'code:module:login_view');
    expect(conduit?.directUsd).toBe(0);
    expect(conduit?.rolledUpUsd).toBeGreaterThan(0);
    expect(report.hotspots.map((h) => h.nodeId)).not.toContain('code:module:login_view');
  });

  it('still surfaces a cheap surface that triggers expensive work behind it', () => {
    const report = attributeCosts(graph, events);
    const login = report.hotspots.find((h) => h.nodeId === 'surface:screen:login');
    expect(login).toBeDefined();
    expect(login!.directUsd).toBe(1);
    expect(login!.rolledUpUsd).toBeGreaterThan(48);
  });

  it('does not divide by zero when a node has no attributed cost', () => {
    const report = attributeCosts(graph, []);
    expect(report.perNode).toEqual([]);
    expect(report.totalUsd).toBe(0);
  });
});

describe('cost recommendations name the real driver', () => {
  it('attributes the downstream category mix, not just direct spend', () => {
    const report = attributeCosts(graph, events);
    const login = report.perNode.find((n) => n.nodeId === 'surface:screen:login')!;
    expect(login.byCategory['compute']).toBe(1);
    expect(login.rolledUpByCategory['model_inference']).toBe(40);
  });

  it('sends someone to the inference bill rather than the container size', () => {
    const report = attributeCosts(graph, events);
    const login = report.perNode.find((n) => n.nodeId === 'surface:screen:login')!;
    const verdict = assessSustainability(login, { nodeId: login.nodeId, dailyValueUsd: 5 });
    expect(verdict.recommendation).toContain('inference');
    expect(verdict.recommendation).not.toContain('container');
  });
});
