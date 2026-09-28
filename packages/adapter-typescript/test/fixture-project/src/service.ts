import { run } from './core/engine.js';
import type { help } from './core/helpers.js';
export * from './core/helpers.js';
export function serve(): string { return run(); }
export async function lazy() { return import('./core/engine.js'); }
export type H = typeof help;
