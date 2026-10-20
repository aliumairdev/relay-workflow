// GitHub control plane over `gh api` (RELAY_GH overrides the binary; tests point it at tests/fakes/gh).
import { spawnSync } from 'node:child_process';
import { RelayError, EXIT } from '../../lib/exit.mjs';

export class GitHub {
  constructor({ repo, gh = process.env.RELAY_GH || 'gh', cwd } = {}) {
    if (!repo) throw new RelayError('control plane needs project.repo', EXIT.INVALID);
    this.repo = repo; this.gh = gh; this.cwd = cwd;
  }

  api(method, route, body) {
    const args = ['api', '-X', method, route];
    const opts = { encoding: 'utf8', cwd: this.cwd, maxBuffer: 64 * 1024 * 1024 };
    if (body !== undefined) { args.push('--input', '-'); opts.input = JSON.stringify(body); }
    const r = spawnSync(this.gh, args, opts);
    if (r.error || r.status !== 0) {
      throw new RelayError(`control plane error: ${method} ${route}: ${(r.stderr || r.error?.message || '').trim().slice(0, 300)}`, EXIT.ENV, { http: (r.stderr || '').match(/HTTP (\d+)/)?.[1] });
    }
    const t = r.stdout.trim();
    return t ? JSON.parse(t) : null;
  }

  paged(route) {
    const all = [];
    for (let page = 1; page < 200; page++) {
      const sep = route.includes('?') ? '&' : '?';
      const got = this.api('GET', `${route}${sep}per_page=100&page=${page}`);
      all.push(...got);
      if (got.length < 100) break;
    }
    return all;
  }

  r(p) { return `repos/${this.repo}/${p}`; }
  norm(i) { return i && { ...i, labels: (i.labels || []).map((l) => (typeof l === 'string' ? l : l.name)) }; }

  // issues and PRs
  getIssue(n) { return this.norm(this.api('GET', this.r(`issues/${n}`))); }
  listIssues({ state = 'open', labels } = {}) {
    const qs = `state=${state}${labels?.length ? `&labels=${encodeURIComponent(labels.join(','))}` : ''}`;
    return this.paged(this.r(`issues?${qs}`)).filter((i) => !i.pull_request).map((i) => this.norm(i));
  }
  createIssue({ title, body, labels = [], milestone }) { return this.norm(this.api('POST', this.r('issues'), { title, body, labels, ...(milestone ? { milestone } : {}) })); }
  editIssue(n, patch) { return this.api('PATCH', this.r(`issues/${n}`), patch); }
  listMilestones() { return this.paged(this.r('milestones?state=all')); }
  createMilestone(title) { return this.api('POST', this.r('milestones'), { title }); }
  closeIssue(n) { return this.api('PATCH', this.r(`issues/${n}`), { state: 'closed' }); }
  reopenIssue(n) { return this.api('PATCH', this.r(`issues/${n}`), { state: 'open' }); }
  getPR(n) { return this.norm(this.api('GET', this.r(`pulls/${n}`))); }
  listPRs(state = 'open') { return this.paged(this.r(`pulls?state=${state}`)).map((i) => this.norm(i)); }
  createPR({ title, body, head, base }) { return this.norm(this.api('POST', this.r('pulls'), { title, body, head, base })); }
  setPRBase(n, base) { return this.api('PATCH', this.r(`pulls/${n}`), { base }); }
  mergePR(n, method = 'squash') { return this.api('PUT', this.r(`pulls/${n}/merge`), { merge_method: method }); }

  // labels
  setLabels(n, labels) { return this.api('PUT', this.r(`issues/${n}/labels`), { labels }); }
  addLabels(n, labels) { return this.api('POST', this.r(`issues/${n}/labels`), { labels }); }
  removeLabel(n, label) {
    try { this.api('DELETE', this.r(`issues/${n}/labels/${encodeURIComponent(label)}`)); return true; } catch (e) { if (e.http === '404' || /404/.test(e.message)) return false; throw e; }
  }
  listRepoLabels() { return this.paged(this.r('labels')); }
  createLabel(l) { return this.api('POST', this.r('labels'), l); }

  // comments
  comment(n, body) { return this.api('POST', this.r(`issues/${n}/comments`), { body }); }
  listComments(n) { return this.paged(this.r(`issues/${n}/comments`)); }
  editComment(id, body) { return this.api('PATCH', this.r(`issues/comments/${id}`), { body }); }
  deleteComment(id) { return this.api('DELETE', this.r(`issues/comments/${id}`)); }
  listPRInline(n) { return this.paged(this.r(`pulls/${n}/comments`)); }
  listPRReviews(n) { return this.paged(this.r(`pulls/${n}/reviews`)); }
  replyInline(n, inReplyTo, body) { return this.api('POST', this.r(`pulls/${n}/comments`), { body, in_reply_to: inReplyTo }); }
}

export function controlPlane(cfg) {
  return new GitHub({ repo: cfg.project.repo, cwd: cfg.__root });
}
