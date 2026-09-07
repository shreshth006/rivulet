/**
 * @file How many bytes does a change actually cost on the wire?
 *
 * This is the central measurement. Everything else in the evaluation follows
 * from it: on a capped, contended link, bytes are time, and bytes are money.
 *
 * Three things are reported, separately and on purpose:
 *
 * 1. **The baseline.** Plain JSON operations -- what a straightforward
 *    implementation sends. Also plain JSON *compressed*, because "we added
 *    gzip" is the obvious cheap alternative and the comparison is only honest
 *    if the codec has to beat it rather than beat nothing.
 * 2. **The codec**, alone and compressed.
 * 3. **An ablation**, disabling one transformation at a time, so each one's
 *    contribution is measured rather than asserted.
 *
 * Results are given per workload, including the one the design handles worst.
 */

import { encodeOps } from '#protocol/codec';
import { deflate, toBytes } from '#protocol/compress';
import { allWorkloads } from '#bench/lib/workloads';
import { Report, fmt } from '#bench/lib/report';

const size = (value) => toBytes(JSON.stringify(value)).length;
const compressed = async (value) => (await deflate(toBytes(JSON.stringify(value)), { level: 9 })).length;

export async function run({ seed = 1 } = {}) {
  const report = new Report('bandwidth',
    'Bytes on the wire per operation, against a plain-JSON baseline.');

  const workloads = allWorkloads({ seed, documents: 60 });

  /* ---------------------------------------------------------- main table */

  const rows = [];
  for (const w of workloads) {
    const plain = size(w.ops);
    const plainGz = await compressed(w.ops);
    const packed = encodeOps(w.ops);
    const packedSize = size(packed);
    const packedGz = await compressed(packed);

    rows.push({
      workload: w.name,
      ops: w.ops.length,
      plain,
      plainPerOp: plain / w.ops.length,
      plainGz,
      packed: packedSize,
      packedPerOp: packedSize / w.ops.length,
      packedGz,
      packedGzPerOp: packedGz / w.ops.length,
      // The honest comparison: our full pipeline against the obvious
      // alternative of compressing the naive encoding.
      vsBaseline: 1 - packedGz / plain,
      vsCompressedBaseline: 1 - packedGz / plainGz,
    });
  }

  report.add('Wire cost per workload', {
    columns: [
      { key: 'workload', label: 'Workload', align: 'left' },
      { key: 'ops', label: 'Ops', format: fmt.int },
      { key: 'plain', label: 'JSON', format: fmt.bytes },
      { key: 'plainPerOp', label: 'JSON/op', format: (n) => `${n.toFixed(0)} B` },
      { key: 'plainGz', label: 'JSON+gz', format: fmt.bytes },
      { key: 'packed', label: 'Codec', format: fmt.bytes },
      { key: 'packedGz', label: 'Codec+gz', format: fmt.bytes },
      { key: 'packedGzPerOp', label: 'Codec+gz/op', format: (n) => `${n.toFixed(1)} B` },
      { key: 'vsBaseline', label: 'vs JSON', format: fmt.pct },
      { key: 'vsCompressedBaseline', label: 'vs JSON+gz', format: fmt.pct },
    ],
    rows,
  }, 'Reduction is against the naive encoding; the last column is against the '
   + 'same data simply compressed, which is the alternative worth beating.');

  /* ----------------------------------------------------------- ablation */

  const ablations = [
    ['all four', {}],
    ['no interning', { intern: false }],
    ['no deltas', { deltas: false }],
    ['no back-references', { backrefs: false }],
    ['no run-length', { rle: false }],
    ['none (columnar only)', { intern: false, deltas: false, backrefs: false, rle: false }],
  ];

  const ablationRows = [];
  for (const [label, options] of ablations) {
    const row = { variant: label };
    for (const w of workloads) {
      const packed = encodeOps(w.ops, options);
      row[w.name] = size(packed) / w.ops.length;
    }
    ablationRows.push(row);
  }

  // Cost relative to the full codec, so the contribution of each technique is
  // readable directly rather than by subtracting columns.
  const baseline = ablationRows[0];
  for (const row of ablationRows.slice(1)) {
    let worst = 0;
    for (const w of workloads) worst = Math.max(worst, row[w.name] / baseline[w.name] - 1);
    row.worstCost = worst;
  }

  report.add('Ablation: bytes per operation with one transformation disabled', {
    columns: [
      { key: 'variant', label: 'Variant', align: 'left' },
      ...workloads.map((w) => ({
        key: w.name, label: w.name, format: (n) => `${n.toFixed(1)} B`,
      })),
      { key: 'worstCost', label: 'Worst case', format: (n) => (n === undefined ? '-' : `+${(n * 100).toFixed(0)}%`) },
    ],
    rows: ablationRows,
  }, 'Uncompressed, so each transformation is measured rather than partly '
   + 'absorbed by DEFLATE. Back-references dominate wherever text is typed; '
   + 'interning dominates wherever many documents are touched.');

  /* -------------------------------------------------- practical framing */

  const practical = workloads.map((w) => {
    const packed = encodeOps(w.ops);
    return {
      workload: w.name,
      perOp: size(packed) / w.ops.length,
      // What a day of this workload costs against a small data budget.
      opsPerMB: Math.round(1e6 / (size(packed) / w.ops.length)),
      plainOpsPerMB: Math.round(1e6 / (size(w.ops) / w.ops.length)),
    };
  });

  report.add('Operations per megabyte of data allowance', {
    columns: [
      { key: 'workload', label: 'Workload', align: 'left' },
      { key: 'plainOpsPerMB', label: 'JSON', format: fmt.int },
      { key: 'opsPerMB', label: 'Codec', format: fmt.int },
      { key: 'perOp', label: 'Bytes/op', format: (n) => `${n.toFixed(1)} B` },
    ],
    rows: practical,
  }, 'Uncompressed codec output, framed as a data budget: the figure that '
   + 'matters to someone on a metered connection.');

  return report;
}

export const meta = {
  name: 'bandwidth',
  description: 'Wire cost per operation, with an ablation of each technique',
};
