import { lstatSync, readFileSync, readdirSync, realpathSync } from 'node:fs';
import { join, relative, resolve, dirname, sep } from 'node:path';
import ts from 'typescript';
import type {
  DomainAdapter,
  IngestResult,
  GraphEdge,
  GraphNode,
  UnresolvedReference,
} from '@lbr/runtime-core';

export interface TypeScriptAdapterOptions {
  /** Directories skipped entirely. */
  readonly ignore?: readonly string[];
  /**
   * Path fragments that mark a file as a test. Test files become `evidence:test`
   * nodes wired by `verified_by` to what they import, rather than `code:module`
   * nodes that merely depend on it.
   *
   * The distinction is load-bearing: a test importing a module is a proof
   * obligation attached to it, not a dependent that breaks when it changes. Get
   * this wrong and every test in the repo lands in the blast radius of every
   * change, which is both true and useless.
   */
  readonly testMarkers?: readonly string[];
}

const DEFAULT_IGNORE = [
  'node_modules',
  'dist',
  '.git',
  'coverage',
  'build',
  // Mirrors are materialized inside the repository so that dependency
  // resolution still works (see @lbr/executor-local). They are copies of the
  // source, so ingesting them would duplicate every node in the graph under a
  // second set of ids — and a graph that double-counts the system is not a
  // model of it.
  '.lbr-mirrors',
];
const DEFAULT_TEST_MARKERS = ['.test.', '.spec.', `${sep}test${sep}`, `${sep}__tests__${sep}`];

/**
 * Builds the `code` and `evidence` domains of a project graph from a real
 * TypeScript source tree.
 *
 * Imports are read with the TypeScript parser rather than by regex — not
 * fastidiousness, but because the graph is a safety mechanism. A regex misses
 * `export * from`, type-only imports, and dynamic `import()`, and every missed
 * edge is a node absent from a blast radius that a change will nonetheless
 * break. An adapter that under-reports is worse than no adapter, because the
 * runtime cannot tell a small blast radius from an incompletely observed one.
 */
export class TypeScriptAdapter implements DomainAdapter {
  readonly name = 'typescript';
  readonly #ignore: readonly string[];
  readonly #testMarkers: readonly string[];

  constructor(options: TypeScriptAdapterOptions = {}) {
    this.#ignore = options.ignore ?? DEFAULT_IGNORE;
    this.#testMarkers = options.testMarkers ?? DEFAULT_TEST_MARKERS;
  }

  async ingest(source: string): Promise<IngestResult> {
    const root = resolve(source);
    const files = this.#walk(root, root);

    const nodes: GraphNode[] = [];
    const edges: GraphEdge[] = [];
    const unresolved: UnresolvedReference[] = [];
    const known = new Map<string, string>();

    for (const file of files) {
      const id = this.#nodeId(file);
      known.set(file.relativePath, id);
    }

    for (const file of files) {
      const id = known.get(file.relativePath)!;
      const contents = readFileSync(file.absolutePath, 'utf8');
      const specifiers = extractImports(file.absolutePath, contents);

      nodes.push({
        id,
        kind: file.isTest ? 'test' : 'module',
        name: file.relativePath,
        live: false,
        irreversible: false,
        attributes: {
          path: file.relativePath,
          adapter: this.name,
          lines: contents.split('\n').length,
          imports: specifiers.length,
        },
      });

      for (const specifier of specifiers) {
        // Only relative imports resolve inside the tree. A bare specifier is a
        // third-party package: recorded as unresolved rather than invented as
        // a node, because a graph that quietly fabricates what it cannot see
        // is worse than one that admits the gap.
        if (!specifier.startsWith('.')) {
          unresolved.push({
            from: file.relativePath,
            reference: specifier,
            reason: 'external package — outside the ingested source tree',
          });
          continue;
        }

        const targetPath = this.#resolveRelative(file, specifier, known);
        if (targetPath === undefined) {
          unresolved.push({
            from: file.relativePath,
            reference: specifier,
            reason: 'could not resolve to a file in the source tree',
          });
          continue;
        }

        const targetId = known.get(targetPath)!;
        if (targetId === id) continue;

        edges.push({
          from: id,
          // A test importing a module proves it; a module importing a module
          // depends on it. Same syntax, different meaning in the graph.
          type: file.isTest ? 'verified_by' : 'depends_on',
          to: targetId,
          attributes: { specifier },
        });
      }
    }

    // `verified_by` reads target-to-test, so a test's imports invert: the
    // module is verified by the test, not the other way around.
    const oriented = edges.map((edge) =>
      edge.type === 'verified_by' ? { ...edge, from: edge.to, to: edge.from } : edge,
    );

    return { nodes, edges: oriented, unresolved };
  }

  #nodeId(file: SourceFile): string {
    const slug = file.relativePath
      .replace(/\.[cm]?tsx?$/, '')
      .replace(/[^a-zA-Z0-9]+/g, '_')
      .toLowerCase()
      .replace(/^_+|_+$/g, '');
    return file.isTest ? `evidence:test:${slug}` : `code:module:${slug}`;
  }

  #resolveRelative(
    file: SourceFile,
    specifier: string,
    known: Map<string, string>,
  ): string | undefined {
    const base = join(dirname(file.relativePath), specifier);
    // TypeScript ESM source imports its own emitted `.js`; the file on disk is
    // `.ts`. Every candidate extension is tried rather than assuming one.
    const candidates = [
      base.replace(/\.js$/, '.ts'),
      base.replace(/\.js$/, '.tsx'),
      `${base}.ts`,
      `${base}.tsx`,
      join(base, 'index.ts'),
      join(base, 'index.tsx'),
      base,
    ];
    return candidates.find((candidate) => known.has(normalize(candidate)));
  }

  /**
   * Walk the source tree, never leaving it.
   *
   * `lstat` rather than `stat`, and symlinks are skipped outright. `stat`
   * follows links, and nothing here constrains where the walk goes, so a
   * repository containing `escape -> /home/someone` would have every `.ts`
   * file under that target read, indexed, and written into the graph with its
   * import strings — and `ingest` runs no commands at all, so this needs no
   * sandbox escape and no build step. The serialized graph is then a file
   * someone stores or shares.
   *
   * Skipping rather than resolving-and-containing is the deliberate choice: a
   * source tree that genuinely needs a symlink to build is better served by
   * saying so than by a containment rule with edge cases.
   */
  #walk(dir: string, root: string): SourceFile[] {
    const found: SourceFile[] = [];
    for (const entry of readdirSync(dir)) {
      if (this.#ignore.includes(entry)) continue;
      const absolutePath = join(dir, entry);
      const stats = lstatSync(absolutePath);
      if (stats.isSymbolicLink()) continue;
      if (stats.isDirectory()) {
        found.push(...this.#walk(absolutePath, root));
        continue;
      }
      if (!/\.[cm]?tsx?$/.test(entry) || entry.endsWith('.d.ts')) continue;
      const relativePath = normalize(relative(root, absolutePath));
      found.push({
        absolutePath,
        relativePath,
        isTest: this.#testMarkers.some((marker) => `${sep}${relativePath}`.includes(marker)),
      });
    }
    return found;
  }
}

interface SourceFile {
  readonly absolutePath: string;
  readonly relativePath: string;
  readonly isTest: boolean;
}

function normalize(path: string): string {
  return path.split(sep).join('/');
}

/**
 * Every module specifier the file references.
 *
 * Covers static imports, `export ... from`, `import type`, and dynamic
 * `import()`. Each of these creates a real dependency the graph needs; a
 * type-only import breaks the build when its target moves just as surely as a
 * value import does.
 */
export function extractImports(fileName: string, contents: string): string[] {
  const source = ts.createSourceFile(fileName, contents, ts.ScriptTarget.ES2022, true);
  const specifiers: string[] = [];

  const visit = (node: ts.Node): void => {
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier !== undefined &&
      ts.isStringLiteral(node.moduleSpecifier)
    ) {
      specifiers.push(node.moduleSpecifier.text);
    }
    if (
      ts.isCallExpression(node) &&
      node.expression.kind === ts.SyntaxKind.ImportKeyword &&
      node.arguments.length > 0
    ) {
      const first = node.arguments[0]!;
      if (ts.isStringLiteral(first)) specifiers.push(first.text);
    }
    ts.forEachChild(node, visit);
  };

  visit(source);
  return [...new Set(specifiers)];
}
