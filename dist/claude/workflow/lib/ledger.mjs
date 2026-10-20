// Append-only usage ledger (PLUGIN_SPEC 8.3). Never stores prompts, code or secrets.
import fs from 'node:fs';
import path from 'node:path';
import { relayDir } from './config.mjs';
import { withLock } from './lockfile.mjs';
import { validateAgainst } from './schema.mjs';
import { now, iso } from './clock.mjs';
import { RelayError, EXIT } from './exit.mjs';

export const ledgerDir = (cfg) => path.join(relayDir(cfg), 'ledger');
export const activeFile = (cfg) => path.join(ledgerDir(cfg), 'usage.jsonl');
const DEFAULT_SECRETS = ['(?i)password\\s*[:=]\\s*\\S+', 'ghp_[A-Za-z0-9]+', 'sk-[A-Za-z0-9]{20,}', 'shpat_[A-Za-z0-9]+'];

function toRegExp(p) {
  const m = /^\(\?i\)/.exec(p);
  return new RegExp(m ? p.slice(4) : p, m ? 'i' : '');
}

// Price a row from workflow.yaml tiers: price_usd_per_mtok {in,out}; undefined when unpriced.
export function priceRow(cfg, row) {
  const p = cfg?.tiers?.[row.tier]?.price_usd_per_mtok;
  if (!p || row.tokens_in == null) return undefined;
  return Math.round(((row.tokens_in * (p.in ?? 0) + (row.tokens_out ?? 0) * (p.out ?? p.in ?? 0)) / 1e6) * 1e4) / 1e4;
}

export function checkRow(cfg, row) {
  const v = validateAgainst('ledger', row);
  if (!v.ok) throw new RelayError(`invalid ledger row: ${v.errors.join('; ')}`, EXIT.INVALID);
  const text = JSON.stringify(row);
  if (text.length > 2000) throw new RelayError('ledger row too large (prompts/code do not belong in the ledger)', EXIT.INVALID);
  for (const pat of [...DEFAULT_SECRETS, ...(cfg?.security?.secret_patterns || [])]) {
    let re; try { re = toRegExp(pat); } catch { continue; }
    if (re.test(text)) throw new RelayError('ledger row looks like it contains a secret; refused', EXIT.INVALID);
  }
}

export async function append(cfg, input) {
  const row = { ts: iso(now()), ...input };
  if (row.cost_usd == null) { const c = priceRow(cfg, row); if (c !== undefined) row.cost_usd = c; }
  for (const k of Object.keys(row)) if (row[k] === undefined) delete row[k];
  checkRow(cfg, row);
  const f = activeFile(cfg);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  await withLock(path.join(ledgerDir(cfg), 'ledger.lock'), () => {
    // monthly rotation: usage.jsonl holds one month; a row from a new month archives it as usage-YYYY-MM.jsonl
    if (fs.existsSync(f) && fs.statSync(f).size > 0) {
      const first = JSON.parse(fs.readFileSync(f, 'utf8').split('\n', 1)[0]);
      const month = first.ts.slice(0, 7);
      if (month !== row.ts.slice(0, 7)) {
        const arch = path.join(path.dirname(f), `usage-${month}.jsonl`);
        if (fs.existsSync(arch)) fs.appendFileSync(arch, fs.readFileSync(f)); else fs.renameSync(f, arch);
        fs.rmSync(f, { force: true });
      }
    }
    fs.appendFileSync(f, JSON.stringify(row) + '\n');
  });
  return row;
}

export function readAll(cfg, { sinceMs } = {}) {
  const dir = ledgerDir(cfg);
  if (!fs.existsSync(dir)) return [];
  const rows = [];
  for (const f of fs.readdirSync(dir).filter((x) => /^usage(-\d{4}-\d{2})?\.jsonl$/.test(x)).sort()) {
    for (const line of fs.readFileSync(path.join(dir, f), 'utf8').split('\n')) {
      if (!line.trim()) continue;
      try { const r = JSON.parse(line); if (!sinceMs || Date.parse(r.ts) >= sinceMs) rows.push(r); } catch { /* skip torn line */ }
    }
  }
  return rows.sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0));
}

// Tier share by tokens (falls back to run counts when no tokens were recorded).
export function tierShare(rows, minRuns = 0) {
  const counted = rows.filter((r) => !['admitted', 'rate_limited', 'fallback'].includes(r.outcome));
  const share = { T0: 0, T1: 0, T2: 0, T3: 0 };
  if (counted.length < minRuns) return { share, sample: counted.length, enough: false };
  const tok = (r) => (r.tokens_in || 0) + (r.tokens_out || 0);
  const total = counted.reduce((n, r) => n + tok(r), 0);
  for (const r of counted) share[r.tier] += total > 0 ? tok(r) / total : 1 / counted.length;
  for (const t of Object.keys(share)) share[t] = Math.round(share[t] * 1e4) / 1e4;
  return { share, sample: counted.length, enough: counted.length > 0 };
}

export const parseSince = (s) => {
  if (!s) return undefined;
  const m = /^(\d+)([dhm])$/.exec(s);
  if (!m) throw new RelayError(`bad --since ${s} (e.g. 7d)`, EXIT.INVALID);
  return now().getTime() - Number(m[1]) * { d: 864e5, h: 36e5, m: 6e4 }[m[2]];
};
