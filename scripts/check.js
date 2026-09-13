#!/usr/bin/env node
/**
 * @file A dependency-free static check.
 *
 * Not a linter -- there is no style enforcement here, because style is what a
 * formatter is for and this project has no dependencies to run one. What it
 * checks is the class of mistake that a test suite genuinely can miss: a file
 * that does not parse, an import that does not resolve, or a module that is
 * never reached from any entry point.
 *
 * A broken import inside a rarely-taken branch (an error path, a fallback
 * adapter) can sit undetected for a long time, because the test that would
 * load it is the test nobody writes.
 */

import { readdir, readFile, stat } from 'node:fs/promises';
import { join, dirname, resolve, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SKIP = new Set(['node_modules', '.git', 'data', 'results', '.tmp']);

/** Every .js file in the project, excluding build and data directories. */
async function sources(dir = ROOT, found = []) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (SKIP.has(entry.name) || entry.name.startsWith('.')) continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) await sources(path, found);
    else if (extname(entry.name) === '.js') found.push(path);
  }
  return found;
}

/** Subpath imports declared in package.json, e.g. "#core/*". */
async function subpathImports() {
  const pkg = JSON.parse(await readFile(join(ROOT, 'package.json'), 'utf8'));
  return Object.entries(pkg.imports ?? {});
}

/** Resolve a `#`-prefixed specifier through the package's imports map. */
function resolveSubpath(specifier, imports) {
  for (const [pattern, target] of imports) {
    if (!pattern.includes('*')) {
      if (pattern === specifier) return resolve(ROOT, target);
      continue;
    }
    const [prefix, suffix] = pattern.split('*');
    if (specifier.startsWith(prefix) && specifier.endsWith(suffix)) {
      const middle = specifier.slice(prefix.length, specifier.length - suffix.length);
      return resolve(ROOT, target.replace('*', middle));
    }
  }
  return null;
}

const IMPORT_RE = /(?:^|[\s;{(])(?:import|export)\s[^'"`]*?from\s*['"]([^'"]+)['"]/g;
const DYNAMIC_RE = /\bimport\(\s*['"]([^'"]+)['"]\s*\)/g;

async function main() {
  const files = await sources();
  const imports = await subpathImports();
  const problems = [];
  const reachable = new Set();

  /** @type {Map<string, string[]>} file -> local files it imports */
  const graph = new Map();

  for (const file of files) {
    const text = await readFile(file, 'utf8');

    // 1. Does it parse?
    //
    // Deliberately `node --check` in a subprocess rather than a dynamic
    // import: importing a module *runs* it, and several modules here start a
    // server or a benchmark on import. A checker with side effects is worse
    // than no checker.
    try {
      await run(process.execPath, ['--check', file]);
    } catch (err) {
      problems.push(`${file}: ${String(err.stderr ?? err.message).split('\n')[0]}`);
    }

    // 2. Do its imports resolve?
    const targets = [];
    for (const re of [IMPORT_RE, DYNAMIC_RE]) {
      re.lastIndex = 0;
      let match;
      while ((match = re.exec(text)) !== null) {
        const spec = match[1];
        if (spec.startsWith('node:')) continue;

        let target = null;
        if (spec.startsWith('#')) {
          target = resolveSubpath(spec, imports);
          if (!target) { problems.push(`${file}: no imports mapping for "${spec}"`); continue; }
        } else if (spec.startsWith('.') || spec.startsWith('/')) {
          target = spec.startsWith('/') ? null : resolve(dirname(file), spec);
        } else {
          problems.push(`${file}: bare import "${spec}" -- this project has no dependencies`);
          continue;
        }
        if (!target) continue;

        const candidates = extname(target) ? [target] : [target, `${target}.js`];
        const found = await Promise.all(candidates.map((c) => stat(c).then(() => c, () => null)));
        const hit = found.find(Boolean);
        if (!hit) problems.push(`${file}: cannot resolve "${spec}"`);
        else targets.push(hit);
      }
    }
    graph.set(file, targets);
  }

  // 3. Is every module reachable from an entry point?
  // Anything a human or CI invokes directly, plus every test. A module that
  // no entry point and no test can reach is either dead or unreachable by
  // mistake, and both are worth knowing about.
  const entries = files.filter((f) =>
    (f.includes(`${join('src', '')}`) && f.endsWith('index.js'))
    || f.includes(`${join('apps', '')}`)
    || f.includes(`${join('bench', '')}`)
    || f.includes(`${join('scripts', '')}`)
    || f.includes(`${join('examples', '')}`)
    || f.endsWith('.test.js')
    || f.includes(`${join('test', 'helpers')}`));

  const queue = [...entries];
  while (queue.length) {
    const file = queue.pop();
    if (reachable.has(file)) continue;
    reachable.add(file);
    for (const target of graph.get(file) ?? []) queue.push(target);
  }

  const orphans = files.filter((f) => !reachable.has(f));
  for (const orphan of orphans) {
    problems.push(`${orphan}: not reachable from any entry point or test`);
  }

  const relative = (p) => p.replace(`${ROOT}/`, '');
  if (problems.length) {
    console.error(`\n${problems.length} problem(s):\n`);
    for (const p of problems) console.error(`  ${relative(p)}`);
    process.exitCode = 1;
    return;
  }
  console.log(`checked ${files.length} files: all parse, all imports resolve, none orphaned`);
}

main().catch((err) => { console.error(err); process.exitCode = 1; });
