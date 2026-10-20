import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
import { CORE } from './config.mjs';
import { RelayError, EXIT } from './exit.mjs';

// Tier -> default model per runtime, used when workflow.yaml does not map a tier.
export const DEFAULT_TIERS = {
  T0: { name: 'docs', claude: 'claude-haiku-5-5', effort: 'medium' },
  T1: { name: 'implement', claude: 'claude-sonnet-5-5', effort: 'medium' },
  T2: { name: 'high-risk', claude: 'claude-opus-5-5', effort: 'medium' },
  T3: { name: 'exceptional', claude: 'claude-fable-5-1', effort: 'medium' },
};

export function parseTemplate(text, file = 'template') {
  const m = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/.exec(text);
  if (!m) throw new RelayError(`${file}: missing frontmatter`, EXIT.INVALID);
  return { front: YAML.parse(m[1]), body: m[2].replace(/\s+$/, '') + '\n' };
}

export const templatesDir = () => path.join(CORE, fs.existsSync(path.join(CORE, 'agent-templates')) ? 'agent-templates' : 'agents');

export function modelFor(cfg, runtime, tier) {
  return cfg?.runtimes?.[runtime]?.models?.[tier] ?? cfg?.tiers?.[tier]?.[runtime] ?? DEFAULT_TIERS[tier]?.[runtime] ?? null;
}

// Render final agent files for a runtime from the neutral templates. Returns [{file, content}] sorted by file name.
export function renderAgents(cfg, { runtime = 'claude', dir = templatesDir() } = {}) {
  const out = [];
  const effortOf = (tier) => cfg?.tiers?.[tier]?.effort ?? cfg?.routing?.default_effort ?? DEFAULT_TIERS[tier]?.effort ?? 'medium';
  const tierOverride = (name, tier) => cfg?.routing?.overrides?.agents?.[name]?.tier ?? tier;

  const emit = (front, body) => {
    const tier = tierOverride(front.name, front.tier);
    const model = modelFor(cfg, runtime, tier);
    if (!model) throw new RelayError(`agent ${front.name}: no ${runtime} model for tier ${tier} (set runtimes.${runtime}.models.${tier})`, EXIT.INVALID);
    const fm = { name: front.name, description: front.description, model, effort: effortOf(tier), tools: front.tools, color: front.color };
    out.push({ file: `${front.name}.md`, content: `---\n${YAML.stringify(fm, { lineWidth: 0 }).trimEnd()}\n---\n${body}` });
  };

  for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.md')).sort()) {
    const { front, body } = parseTemplate(fs.readFileSync(path.join(dir, f), 'utf8'), f);
    if (front.name !== 'implementer') { emit(front, body); continue; }
    const roles = Object.entries(cfg?.roles || {});
    const fill = (text, name, paths) => text.replaceAll('{{role_name}}', name).replaceAll('{{role_paths}}', paths);
    if (!roles.length) {
      const g = 'the owned paths declared in the issue';
      emit({ ...front, description: fill(front.description, 'general', g) }, fill(body, 'general', g));
      continue;
    }
    for (const [id, role] of roles) {
      const paths = (role.paths || []).join(', ') || 'the owned paths declared in the issue';
      emit({ ...front, name: `${role.name}-implementer`, tier: role.tier || front.tier, description: `${fill(front.description, role.name, paths)} Role ${id}: ${role.name}.` }, fill(body, role.name, paths));
    }
  }
  return out.sort((a, b) => (a.file < b.file ? -1 : 1));
}
