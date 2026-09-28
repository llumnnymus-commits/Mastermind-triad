import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { ProjectGraph } from '../graph/graph.js';
import { deserializeGraph, serializeGraph, type SerializedGraph } from '../graph/serialize.js';
import type { LineageRecord } from '../deployment/lineage.js';

export const DEFAULT_LINEAGE_DIR = '.lbr/lineage';

/**
 * A lineage record plus the graph it was built against.
 *
 * The graph is stored with the record rather than separately because the point
 * of lineage is being able to ask, later, whether the prediction was right —
 * and `auditPrediction` compares against node ids that only mean something
 * relative to the graph they came from. A record without its graph is a set of
 * identifiers nobody can resolve.
 */
export interface StoredLineage {
  readonly version: 1;
  readonly record: LineageRecord;
  readonly baseGraph: SerializedGraph;
}

export interface SaveLineageResult {
  readonly path: string;
  readonly deploymentId: string;
}

/**
 * Persist a lineage record so it outlives the process.
 *
 * Until this existed the runtime created a record at the moment a change became
 * a deployment candidate and then dropped it, which meant the prediction it
 * captured could never be compared against what actually happened. Recording a
 * prediction you throw away is not recording a prediction.
 */
export async function saveLineage(
  root: string,
  record: LineageRecord,
  baseGraph: ProjectGraph,
  dir = DEFAULT_LINEAGE_DIR,
): Promise<SaveLineageResult> {
  const target = join(root, dir);
  await mkdir(target, { recursive: true });

  const stored: StoredLineage = {
    version: 1,
    record,
    baseGraph: serializeGraph(baseGraph),
  };

  const path = join(target, `${record.deploymentId}.json`);
  await writeFile(path, `${JSON.stringify(stored, null, 2)}\n`, 'utf8');
  return { path, deploymentId: record.deploymentId };
}

/**
 * Read a lineage record and the graph it was built against.
 *
 * The graph is revalidated on the way in by `deserializeGraph`, because stored
 * data is input like any other — it may predate a schema change or have been
 * edited by hand.
 */
export async function loadLineage(
  root: string,
  deploymentId: string,
  dir = DEFAULT_LINEAGE_DIR,
): Promise<{ record: LineageRecord; baseGraph: ProjectGraph }> {
  const path = join(root, dir, `${deploymentId}.json`);
  const parsed = JSON.parse(await readFile(path, 'utf8')) as Partial<StoredLineage>;

  if (parsed.version !== 1) {
    throw new Error(`unsupported stored lineage version in ${path}: ${String(parsed.version)}`);
  }
  if (parsed.record === undefined || parsed.baseGraph === undefined) {
    throw new Error(`stored lineage at ${path} is missing its record or base graph`);
  }

  return { record: parsed.record, baseGraph: deserializeGraph(parsed.baseGraph) };
}

/** Deployment ids with stored lineage, newest first by id. */
export async function listLineage(root: string, dir = DEFAULT_LINEAGE_DIR): Promise<string[]> {
  try {
    const entries = await readdir(join(root, dir));
    return entries
      .filter((e) => e.endsWith('.json'))
      .map((e) => e.slice(0, -'.json'.length))
      .sort((a, b) => b.localeCompare(a));
  } catch {
    // No lineage directory means nothing has been recorded here yet, which is
    // an ordinary state rather than an error.
    return [];
  }
}
