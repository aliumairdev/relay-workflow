import fs from 'node:fs';
import path from 'node:path';

const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };
const TORN_GRACE_S = 5;

// Create the lock atomically *with* its content: write a temp file, then link() it into place.
// link() fails with EEXIST if the lock exists, and a reader can never observe an empty lock file.
function tryCreate(file, pid) {
  const tmp = `${file}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({ pid, at: Date.now() }));
  try { fs.linkSync(tmp, file); return true; } catch (e) { if (e.code === 'EEXIST') return false; throw e; } finally { try { fs.unlinkSync(tmp); } catch { /* already gone */ } }
}

// pid + mtime lock. Stale when the owner pid is dead or the file is older than staleAfterS.
export function acquire(file, { staleAfterS = 900, pid = process.pid } = {}) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  for (let attempt = 0; attempt < 5; attempt++) {
    if (tryCreate(file, pid)) return { acquired: true };
    let info, ageS;
    try {
      info = JSON.parse(fs.readFileSync(file, 'utf8'));
      ageS = (Date.now() - fs.statSync(file).mtimeMs) / 1000;
    } catch (e) {
      if (e.code === 'ENOENT') continue; // released between our create attempt and the read: retry
      // unreadable content: give the writer a short grace period before calling it stale
      try { ageS = (Date.now() - fs.statSync(file).mtimeMs) / 1000; } catch { continue; }
      if (ageS < TORN_GRACE_S) return { acquired: false, holder: null, ageS };
      info = {};
    }
    const stale = !info.pid || !alive(info.pid) || ageS > staleAfterS;
    if (!stale) return { acquired: false, holder: info, ageS };
    try { fs.unlinkSync(file); } catch { /* another taker won; loop and retry */ }
  }
  return { acquired: false, holder: null };
}

export function release(file, { pid = process.pid } = {}) {
  try {
    const info = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (info.pid && info.pid !== pid) return false;
  } catch { /* missing or torn */ }
  try { fs.unlinkSync(file); return true; } catch { return false; }
}

// Run fn under an advisory lock, waiting up to waitMs.
export async function withLock(file, fn, { waitMs = 10000, staleAfterS = 900 } = {}) {
  const end = Date.now() + waitMs;
  for (;;) {
    if (acquire(file, { staleAfterS }).acquired) break;
    if (Date.now() > end) throw new Error(`lock busy: ${file}`);
    await new Promise((r) => setTimeout(r, 25));
  }
  try { return await fn(); } finally { release(file); }
}
