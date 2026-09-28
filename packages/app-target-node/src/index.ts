import type { FileEdit } from '@lbr/runtime-core';

/**
 * What "an application" means for one stack.
 *
 * The source documents describe building Android apps through `gradlew`. That
 * target is not implemented here, and the reason is not oversight: this
 * environment has no Android SDK, no Gradle and no emulator, so an Android
 * codegen path could be written but never run. Shipping a generator nobody can
 * execute is how a system accumulates confident claims about code that has
 * never worked. The Node target below can genuinely be scaffolded, compiled,
 * tested and executed, so it is the one that exists.
 *
 * The interface is the point: another target supplies its own scaffold and
 * commands and drops into the same loop.
 */
export interface AppTarget {
  readonly name: string;
  /** Human-readable description of what this target produces. */
  readonly produces: string;
  /**
   * Files that make an empty but working project of this kind.
   *
   * Returned as `FileEdit`s so the scaffold travels through exactly the same
   * apply path, path confinement and validation as any other change. A
   * scaffold written by a privileged side-channel would be the one change in
   * the system nothing checked.
   */
  scaffold(appName: string): FileEdit[];
  /** Where generated source belongs, so a proposer knows what to write. */
  readonly sourceDir: string;
  /** How a caller runs the finished thing. */
  readonly runHint: string;
  /** Installed once after scaffolding, so the project stands on its own. */
  readonly installCommand: readonly string[];
}

const TSCONFIG = {
  compilerOptions: {
    target: 'ES2022',
    module: 'ES2022',
    moduleResolution: 'bundler',
    lib: ['ES2022'],
    strict: true,
    noUncheckedIndexedAccess: true,
    // Declared explicitly: without it the entry point cannot reference
    // `process` or `console`, and the scaffold does not compile at all.
    types: ['node'],
    declaration: true,
    outDir: 'dist',
    rootDir: 'src',
    skipLibCheck: true,
    verbatimModuleSyntax: true,
  },
  include: ['src/**/*.ts'],
  exclude: ['dist', 'node_modules'],
};

/**
 * A Node + TypeScript application.
 *
 * Deliberately minimal. The scaffold is the smallest thing that genuinely
 * compiles, tests and runs — every line the runtime adds after this is a change
 * that went through the loop and was validated, rather than something smuggled
 * in as "setup".
 */
export const nodeAppTarget: AppTarget = {
  name: 'node-typescript',
  produces: 'a Node application in TypeScript, compiled with tsc and tested with vitest',
  sourceDir: 'src',
  runHint: 'npm run build && node dist/main.js',
  installCommand: ['npm', 'install', '--silent', '--no-audit', '--no-fund'],

  scaffold(appName: string): FileEdit[] {
    const safeName = appName.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '')
      || 'app';

    return [
      {
        path: 'package.json',
        contents: `${JSON.stringify(
          {
            name: safeName,
            version: '0.1.0',
            private: true,
            type: 'module',
            scripts: {
              build: 'tsc -p tsconfig.json',
              typecheck: 'tsc -p tsconfig.json --noEmit',
              test: 'vitest run',
              start: 'node dist/main.js',
            },
            // A generated application is a real project and owns its
            // dependencies. Relying on a parent's node_modules would produce
            // something that only builds where it was generated.
            devDependencies: {
              '@types/node': '^22.20.1',
              typescript: '^5.6.3',
              vitest: '^2.1.4',
            },
          },
          null,
          2,
        )}\n`,
      },
      { path: 'tsconfig.json', contents: `${JSON.stringify(TSCONFIG, null, 2)}\n` },
      {
        path: 'src/main.ts',
        contents: [
          '/** Entry point. Replaced as the runtime builds the app one node at a time. */',
          'export function main(): string {',
          `  return ${JSON.stringify(safeName)};`,
          '}',
          '',
          'if (import.meta.url === `file://${process.argv[1]}`) {',
          '  console.log(main());',
          '}',
          '',
        ].join('\n'),
      },
      {
        path: 'src/main.test.ts',
        contents: [
          "import { describe, it, expect } from 'vitest';",
          "import { main } from './main.js';",
          '',
          "describe('the app', () => {",
          "  it('starts', () => {",
          `    expect(main()).toBe(${JSON.stringify(safeName)});`,
          '  });',
          '});',
          '',
        ].join('\n'),
      },
    ];
  },
};

export const APP_TARGETS: Readonly<Record<string, AppTarget>> = {
  [nodeAppTarget.name]: nodeAppTarget,
};

export function selectTarget(name: string): AppTarget {
  const target = APP_TARGETS[name];
  if (target === undefined) {
    throw new Error(
      `unknown app target '${name}'. Available: ${Object.keys(APP_TARGETS).join(', ')}`,
    );
  }
  return target;
}
