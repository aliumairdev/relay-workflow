import fs from 'node:fs';
import path from 'node:path';
import { CORE, stateFile, relayDir } from './config.mjs';
import { withLock } from './lockfile.mjs';
import { iso } from './clock.mjs';
import { validateAgainst } from './schema.mjs';
import { RelayError, EXIT } from './exit.mjs';

const template = () => JSON.parse(fs.readFileSync(path.join(CORE, 'templates/STATE.json'), 'utf8'));

export function readState(cfg) {
  const f = stateFile(cfg);
  if (!fs.existsSync(f)) { const s = template(); s.policy.mode = cfg.policy.mode; return s; }
  return JSON.parse(fs.readFileSync(f, 'utf8'));
}

// Read-modify-write under a file lock; atomic replace; validates before writing.
export async function updateState(cfg, fn) {
  const f = stateFile(cfg);
  return withLock(path.join(relayDir(cfg), 'state.lock'), () => {
    const s = readState(cfg);
    const next = fn(s) ?? s;
    const v = validateAgainst('state', next);
    if (!v.ok) throw new RelayError(`STATE.json would be invalid: ${v.errors.join('; ')}`, EXIT.INVALID);
    fs.mkdirSync(path.dirname(f), { recursive: true });
    const tmp = `${f}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(next, null, 2) + '\n');
    fs.renameSync(tmp, f);
    return next;
  });
}

export const activeClaimsOf = (s) => s.claims || [];
export { iso };
