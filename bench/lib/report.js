/**
 * @file Formatting for benchmark results: console tables, Markdown and CSV.
 *
 * Results go three places and must agree: the terminal while iterating, a
 * Markdown table that is pasted into the write-up, and a CSV for plotting.
 * Formatting them from one structure keeps a number from being transcribed
 * wrongly into the one that gets published.
 */

/** @typedef {{ columns: Array<{key: string, label: string, align?: 'left'|'right', format?: (v:any)=>string}>, rows: object[] }} Table */

export const fmt = {
  bytes: (n) => (n >= 1e6 ? `${(n / 1e6).toFixed(2)} MB`
    : n >= 1e3 ? `${(n / 1e3).toFixed(1)} kB` : `${Math.round(n)} B`),
  ms: (n) => (n >= 60_000 ? `${(n / 60_000).toFixed(1)} min`
    : n >= 1000 ? `${(n / 1000).toFixed(2)} s` : `${Math.round(n)} ms`),
  pct: (n) => `${(n * 100).toFixed(1)}%`,
  ratio: (n) => `${n.toFixed(2)}x`,
  num: (n) => (Number.isInteger(n) ? String(n) : n.toFixed(2)),
  int: (n) => String(Math.round(n)),
};

function cell(row, col) {
  const raw = row[col.key];
  if (raw === undefined || raw === null) return '-';
  return col.format ? col.format(raw) : String(raw);
}

/** Fixed-width table for a terminal. */
export function renderTable({ columns, rows }, { title } = {}) {
  const widths = columns.map((col) =>
    Math.max(col.label.length, ...rows.map((r) => cell(r, col).length)));

  const line = (chars, joint) =>
    chars[0] + widths.map((w) => chars[1].repeat(w + 2)).join(joint) + chars[2];

  const format = (values) => '│ ' + values
    .map((v, i) => (columns[i].align === 'left' ? v.padEnd(widths[i]) : v.padStart(widths[i])))
    .join(' │ ') + ' │';

  const out = [];
  if (title) out.push('', `\x1b[1m${title}\x1b[0m`);
  out.push(line(['┌', '─', '┐'], '┬'));
  out.push(format(columns.map((c) => c.label)));
  out.push(line(['├', '─', '┤'], '┼'));
  for (const row of rows) out.push(format(columns.map((c) => cell(row, c))));
  out.push(line(['└', '─', '┘'], '┴'));
  return out.join('\n');
}

/** GitHub-flavoured Markdown table. */
export function renderMarkdown({ columns, rows }, { title } = {}) {
  const out = [];
  if (title) out.push(`### ${title}`, '');
  out.push(`| ${columns.map((c) => c.label).join(' | ')} |`);
  out.push(`| ${columns.map((c) => (c.align === 'left' ? ':--' : '--:')).join(' | ')} |`);
  for (const row of rows) out.push(`| ${columns.map((c) => cell(row, c)).join(' | ')} |`);
  out.push('');
  return out.join('\n');
}

/** CSV with raw, unformatted values -- what a plotting script wants. */
export function renderCsv({ columns, rows }) {
  const escape = (v) => {
    const s = v === undefined || v === null ? '' : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const out = [columns.map((c) => escape(c.key)).join(',')];
  for (const row of rows) out.push(columns.map((c) => escape(row[c.key])).join(','));
  return out.join('\n');
}

/** A complete scenario result: metadata plus one or more tables. */
export class Report {
  /** @param {string} name @param {string} description */
  constructor(name, description) {
    this.name = name;
    this.description = description;
    /** @type {Array<{title: string, note?: string, table: Table}>} */
    this.sections = [];
    this.startedAt = new Date().toISOString();
  }

  /** @param {string} title @param {Table} table @param {string} [note] */
  add(title, table, note) {
    this.sections.push({ title, table, note });
    return this;
  }

  toConsole() {
    const out = [`\n\x1b[1m\x1b[36m${this.name}\x1b[0m — ${this.description}`];
    for (const s of this.sections) {
      out.push(renderTable(s.table, { title: s.title }));
      if (s.note) out.push(`  ${s.note}`);
    }
    return out.join('\n');
  }

  toMarkdown() {
    const out = [`## ${this.name}`, '', this.description, ''];
    for (const s of this.sections) {
      out.push(renderMarkdown(s.table, { title: s.title }));
      if (s.note) out.push(`*${s.note}*`, '');
    }
    return out.join('\n');
  }

  toJSON() {
    return {
      name: this.name,
      description: this.description,
      startedAt: this.startedAt,
      sections: this.sections.map((s) => ({
        title: s.title, note: s.note,
        columns: s.table.columns.map((c) => c.key),
        rows: s.table.rows,
      })),
    };
  }

  /** @returns {Array<{name: string, csv: string}>} one file per section */
  toCsvFiles() {
    return this.sections.map((s, i) => ({
      name: `${this.name}-${i + 1}-${s.title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')}.csv`,
      csv: renderCsv(s.table),
    }));
  }
}
