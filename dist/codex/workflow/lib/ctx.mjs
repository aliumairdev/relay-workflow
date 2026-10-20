import { loadConfig } from './config.mjs';
import { controlPlane } from '../adapters/control-plane/github.mjs';
import { ACTORS } from './labels.mjs';
import { RelayError, EXIT } from './exit.mjs';

// Standard script context: validated config + control plane.
export function ctx(opts = {}) {
  const cfg = loadConfig(opts);
  return { cfg, cp: controlPlane(cfg) };
}

export function actorClass(flag) {
  const a = flag || process.env.RELAY_ACTOR || 'human';
  if (!ACTORS.includes(a)) throw new RelayError(`unknown actor class "${a}" (one of ${ACTORS.join(', ')})`, EXIT.INVALID);
  return a;
}
