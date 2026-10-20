// *.md: union of both sides via `git merge-file --union` (stages 1/2/3). Temp files live in a mkdtemp dir.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { sh } from '../lib/exec.mjs';

export function resolve({ base, ours, theirs }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-mdu-'));
  try {
    const [o, b, t] = ['ours', 'base', 'theirs'].map((n) => path.join(dir, n));
    fs.writeFileSync(o, ours); fs.writeFileSync(b, base); fs.writeFileSync(t, theirs);
    const r = sh('git', ['merge-file', '-p', '--union', o, b, t]);
    return r.code >= 0 && r.code < 128 ? r.stdout : null; // exit code = number of conflicts for plain merge; --union resolves them all
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}
