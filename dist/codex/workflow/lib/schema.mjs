import fs from 'node:fs';
import path from 'node:path';
import Ajv from 'ajv/dist/2020.js';
import { CORE } from './config.mjs';

const ajv = new Ajv({ allErrors: true, strict: false });
const cache = {};
// validateAgainst('handoff', obj) -> {ok, errors:[string]}
export function validateAgainst(name, obj) {
  cache[name] ??= ajv.compile(JSON.parse(fs.readFileSync(path.join(CORE, 'schemas', `${name}.schema.json`), 'utf8')));
  const f = cache[name];
  const ok = f(obj);
  return { ok, errors: ok ? [] : f.errors.map((e) => `${e.instancePath || '(root)'} ${e.message}${e.params?.additionalProperty ? ` "${e.params.additionalProperty}"` : ''}`) };
}
