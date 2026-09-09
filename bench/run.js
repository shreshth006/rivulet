#!/usr/bin/env node
/**
 * @file Benchmark runner.
 *
 *   node --experimental-sqlite bench/run.js                 # all, to the terminal
 *   node --experimental-sqlite bench/run.js bandwidth       # one scenario
 *   node --experimental-sqlite bench/run.js --out results   # also write files
 *   node --experimental-sqlite bench/run.js --seed 42       # different draw
 *
 * Every scenario is deterministic given its seed, so a result can be
 * reproduced exactly and a surprising number can be re-run and inspected
 * rather than argued about.
 */

import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const SCENARIOS = {
  bandwidth: () => import('#bench/scenarios/bandwidth'),
  latency: () => import('#bench/scenarios/latency'),
  partition: () => import('#bench/scenarios/partition'),
  batching: () => import('#bench/scenarios/batching'),
  scale: () => import('#bench/scenarios/scale'),
  overhead: () => import('#bench/scenarios/overhead'),
};

function parseArgs(argv) {
  const opts = { names: [], out: null, seed: undefined, quiet: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--out') opts.out = argv[++i];
    else if (arg === '--seed') opts.seed = Number(argv[++i]);
    else if (arg === '--quiet') opts.quiet = true;
    else if (arg === '--all') { /* default */ }
    else if (arg === '--help' || arg === '-h') opts.help = true;
    else if (arg.startsWith('-')) throw new Error(`unknown flag: ${arg}`);
    else opts.names.push(arg);
  }
  return opts;
}

const HELP = `
rivulet benchmarks

  node --experimental-sqlite bench/run.js [scenario...] [options]

Scenarios (all run when none is named):
${Object.keys(SCENARIOS).map((n) => `  ${n}`).join('\n')}

Options:
  --out <dir>   write JSON, Markdown and CSV alongside the terminal output
  --seed <n>    seed every scenario's generator (default: per-scenario)
  --quiet       suppress terminal tables
  -h, --help    this message
`;

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) { console.log(HELP); return; }

  const names = opts.names.length ? opts.names : Object.keys(SCENARIOS);
  for (const name of names) {
    if (!SCENARIOS[name]) {
      console.error(`unknown scenario: ${name}\nknown: ${Object.keys(SCENARIOS).join(', ')}`);
      process.exitCode = 1;
      return;
    }
  }

  if (opts.out) await mkdir(opts.out, { recursive: true });

  const reports = [];
  for (const name of names) {
    const started = Date.now();
    if (!opts.quiet) process.stderr.write(`\x1b[2mrunning ${name}...\x1b[0m\n`);

    const mod = await SCENARIOS[name]();
    const report = await mod.run(opts.seed === undefined ? {} : { seed: opts.seed });
    report.durationMs = Date.now() - started;
    reports.push(report);

    if (!opts.quiet) console.log(report.toConsole());

    if (opts.out) {
      await writeFile(join(opts.out, `${name}.json`), `${JSON.stringify(report, null, 2)}\n`);
      await writeFile(join(opts.out, `${name}.md`), report.toMarkdown());
      for (const { name: file, csv } of report.toCsvFiles()) {
        await writeFile(join(opts.out, file), `${csv}\n`);
      }
    }
  }

  if (opts.out) {
    // One document with everything, for pasting into the write-up.
    const combined = [
      '# Evaluation results', '',
      `Generated ${new Date().toISOString()} on Node ${process.version}.`,
      'Network figures come from the simulator in `bench/netsim`; timings are',
      'simulated, not wall-clock, and are reproducible given the seed.', '',
      ...reports.map((r) => r.toMarkdown()),
    ].join('\n');
    await writeFile(join(opts.out, 'README.md'), combined);
    process.stderr.write(`\nwrote ${reports.length} report(s) to ${opts.out}/\n`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
