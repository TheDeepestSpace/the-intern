// Loader, validator, trigger matcher and `explain` for agentic.yaml — the
// declarative source of truth for who triggers which agent, what it can touch,
// and what it runs. Pure functions only (no I/O, no network, no dependencies)
// so the worker (which bundles this file verbatim, see
// scripts/bundle-agentic.js), CI and tests can all share it. YAML parsing lives
// in ./agentic-yaml.js so this file stays dependency-free.

const TRIGGER_KINDS = ['comment', 'commit', 'pull_request', 'issue', 'schedule', 'manual', 'telegram',
  'ci_failure', 'merge_conflict', 'review', 'dispatch'];
// System-synthesized triggers: the worker (or the nightly crawl) turns a
// GitHub event into one of these; the agent's `request` template is the text
// the agent receives. Fields are the structural facts of the event only —
// never third-party free text (review bodies, titles).
const SYSTEM_FIELDS = {
  ci_failure: ['pr_author', 'conclusion', 'head_sha', 'html_url'],
  merge_conflict: ['pr_author', 'base_ref', 'mergeable_state'],
  review: ['pr_author', 'reviewer', 'html_url'],
};
// Non-LLM scheduled jobs a `schedule` agent may run (`job:`). The code behind
// each name lives in scripts/; yaml only decides when, how long, under which
// concurrency group and with which tunables.
const JOBS = ['nightly-crawl', 'cleanup-data-branches', 'update-model-list', 'poll-pending-retries'];
const SCOPES = ['read', 'read/write'];
// Access name meaning every repo the GitHub App is installed in.
const ALL_REPOS = '*';
const ACTION_KINDS = ['dispatch_agent', 'dispatch_workflow', 'comment', 'label', 'open_issue'];
const PARAM_TYPES = ['string', 'integer', 'boolean'];
const COMMENT_ON = ['issue', 'pr', 'review_thread'];
const PERMISSIONS = ['contents', 'issues', 'pull_requests', 'workflows', 'actions', 'checks', 'statuses'];
const AGENT_KEYS = ['trigger', 'access', 'prompt', 'prompt_file', 'prompt_append', 'backend', 'model',
  'effort', 'timeout', 'limits', 'actions', 'permissions', 'secrets', 'network', 'tools',
  'request', 'job', 'concurrency', 'settings'];
const DEFAULT_KEYS = ['backend', 'model', 'effort', 'timeout', 'limits'];
const TOP_KEYS = ['version', 'bot', 'defaults', 'repos', 'allowed_owners', 'prompt_repos', 'snippets', 'dispatch', 'agents'];
const REPO_RE = /^[\w.-]+\/[\w.-]+$/;
const VAR_RE = /\$([a-z_][a-z0-9_]*(?:\.[a-z_][a-z0-9_]*)*)/gi;
const ONLY_VAR_RE = /^\$([a-z_][a-z0-9_]*(?:\.[a-z_][a-z0-9_]*)*)$/i;
// Backend keyword accepted right after a catch-all mention (`@bot codex ...`).
const BACKEND_KEYWORDS = ['claude', 'codex', 'agy'];

const isObj = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const isVar = v => typeof v === 'string' && ONLY_VAR_RE.test(v);
const esc = x => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function unknownKeys(obj, allowed, where, errors) {
  for (const k of Object.keys(obj)) {
    if (!allowed.includes(k)) errors.push(`${where}: unknown key '${k}'`);
  }
}

// `specages/@project/spec` -> regex with named captures (`@name` = one path segment).
function branchPattern(pattern) {
  const names = [];
  let src = '';
  for (const part of pattern.split(/(@[a-z_][a-z0-9_]*)/i)) {
    if (/^@[a-z_]/i.test(part)) {
      names.push(part.slice(1));
      src += `(?<${part.slice(1)}>[^/]+)`;
    } else {
      src += part.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*');
    }
  }
  return { re: new RegExp(`^${src}$`), names };
}

function globToRegExp(glob) {
  const src = glob
    .replace(/[.+?^${}()|[\]\\]/g, '\\$&')
    .replace(/\*\*\/?/g, m => (m.endsWith('/') ? '\u0000' : '\u0001'))
    .replace(/\*/g, '[^/]*')
    .replace(/\u0000/g, '(?:.*/)?')
    .replace(/\u0001/g, '.*');
  return new RegExp(`^${src}$`);
}

function parseDuration(v) {
  const m = /^(\d+)(s|m|h|d)$/.exec(String(v));
  if (!m) return null;
  return Number(m[1]) * { s: 1, m: 60, h: 3600, d: 86400 }[m[2]];
}

// Declared params of a trigger definition (comment/telegram `params`, manual
// `parameters`), or {} for kinds without any.
function declaredParams(kind, def) {
  if (kind === 'manual') return def.parameters || {};
  if (kind === 'comment' || kind === 'telegram') return def.params || {};
  return {};
}

// The variables a trigger makes available. `values` is null at load time
// (placeholders, to check that a reference *exists*) or the real event.
function triggerContext(kind, def, values) {
  const v = values;
  const ph = key => (v ? v[key] : true);
  const base = { repo: ph('repo'), author: ph('author') };
  let t;
  switch (kind) {
    case 'comment': {
      const param = {};
      for (const p of Object.keys(def.params || {})) param[p] = v ? (v.params || {})[p] : true;
      t = { ...base, issue_number: ph('issue_number'), param };
      break;
    }
    case 'commit': {
      const matcher = {};
      for (const n of def.branch ? branchPattern(def.branch).names : []) {
        matcher[n] = v ? (v.matcher || {})[n] : true;
      }
      t = { ...base, sha: ph('sha'), branch: ph('branch'), matcher };
      break;
    }
    case 'pull_request':
    case 'issue':
      t = { ...base, number: ph('number') };
      break;
    case 'ci_failure':
    case 'merge_conflict':
    case 'review': {
      t = { ...base, number: ph('number') };
      for (const f of SYSTEM_FIELDS[kind]) t[f] = ph(f);
      break;
    }
    case 'telegram': {
      const param = {};
      for (const p of Object.keys(def.params || {})) param[p] = v ? (v.params || {})[p] : true;
      t = { chat_id: ph('chat_id'), message_id: ph('message_id'), param };
      break;
    }
    case 'dispatch':
      // Generic dispatch_agent entrypoint: no declared params; the request is
      // validated against the top-level `dispatch` allowlist (matchAgent).
      t = { ...base, issue_number: ph('issue_number') };
      break;
    case 'manual': {
      const parameters = {};
      for (const p of Object.keys(def.parameters || {})) parameters[p] = v ? (v.parameters || {})[p] : true;
      t = { parameters };
      break;
    }
    default:
      t = {};
  }
  const ctx = { trigger: { [kind]: t } };
  if (t.repo !== undefined) ctx.repo = t.repo;
  if (t.issue_number !== undefined) ctx.issue_number = t.issue_number;
  else if (t.number !== undefined) ctx.issue_number = t.number;
  if (t.param) ctx.param = t.param;
  if (t.parameters) {
    ctx.param = t.parameters;
    if (t.parameters.repo !== undefined) ctx.repo = t.parameters.repo;
    if (t.parameters.issue_number !== undefined) ctx.issue_number = t.parameters.issue_number;
  }
  return ctx;
}

function lookup(ctx, dotted) {
  let cur = ctx;
  for (const seg of dotted.split('.')) {
    if (cur === null || typeof cur !== 'object' || !(seg in cur)) return { found: false };
    cur = cur[seg];
  }
  return { found: true, value: cur };
}

// Vars allowed inside `access`: only trusted trigger fields (repo, branch
// captures, typed manual parameters) — never free-form comment params or text.
function trustedForAccess(dotted) {
  return /^(repo|trigger\.(comment|commit|pull_request|issue|ci_failure|merge_conflict|review)\.repo|trigger\.commit\.matcher\.[a-z_]\w*|trigger\.manual\.parameters\.[a-z_]\w*)$/i.test(dotted);
}

// Vars allowed as a prompt_file `ref`: the pushed commit/branch of a commit
// trigger, so the prompt is pinned to exactly what the trusted author pushed.
function trustedForRef(dotted) {
  return /^trigger\.commit\.(sha|branch)$/i.test(dotted);
}

// `$trigger.<kind>.param.<x>` / `$trigger.manual.parameters.<x>` -> declared
// type of that param, or null when the reference is not a declared param.
function paramRefType(dotted, kind, def) {
  const m = /^trigger\.(comment|telegram)\.param\.([a-z_]\w*)$|^trigger\.(manual)\.parameters\.([a-z_]\w*)$/i.exec(dotted);
  if (!m) return null;
  const k = m[1] || m[3];
  const name = m[2] || m[4];
  if (k !== kind) return null;
  return declaredParams(kind, def)[name] || null;
}

function checkVars(str, ctx, extra, where, errors) {
  for (const m of str.matchAll(VAR_RE)) {
    const name = m[1];
    if (extra.includes(name)) continue;
    if (!lookup(ctx, name).found) errors.push(`${where}: unknown variable '$${name}' (not provided by the trigger)`);
  }
}

function checkRepoRef(ref, spec, ctx, where, errors) {
  if (typeof ref !== 'string' || !ref) {
    errors.push(`${where}: repo must be a non-empty string`);
    return;
  }
  if (ref === ALL_REPOS) return;
  if (isVar(ref)) {
    const name = ref.slice(1);
    if (!trustedForAccess(name)) errors.push(`${where}: '${ref}' is not a trusted source for a repo`);
    else if (!lookup(ctx, name).found) errors.push(`${where}: unknown variable '${ref}' (not provided by the trigger)`);
  } else if (!(ref in spec.repos) && !REPO_RE.test(ref)) {
    errors.push(`${where}: undefined repo alias '${ref}'`);
  }
}

function validateParams(params, where, errors) {
  if (!isObj(params)) return errors.push(`${where}: must be a map of name -> type`);
  for (const [k, t] of Object.entries(params)) {
    if (!PARAM_TYPES.includes(t)) errors.push(`${where}.${k}: type must be one of ${PARAM_TYPES.join('|')}`);
  }
}

function validateTrigger(name, trigger, spec, errors) {
  const where = `agents.${name}.trigger`;
  if (!isObj(trigger)) return errors.push(`${where}: required`);
  const kinds = Object.keys(trigger);
  if (kinds.length !== 1 || !TRIGGER_KINDS.includes(kinds[0])) {
    return errors.push(`${where}: exactly one of ${TRIGGER_KINDS.join('|')} required`);
  }
  const kind = kinds[0];
  const def = trigger[kind] === null ? {} : trigger[kind];
  if (!isObj(def)) return errors.push(`${where}.${kind}: must be a map`);
  const w = `${where}.${kind}`;
  const strList = (key) => {
    if (def[key] !== undefined && (!Array.isArray(def[key]) || !def[key].every(s => typeof s === 'string'))) {
      errors.push(`${w}.${key}: must be a list of strings`);
    }
  };
  const repoRef = (key) => {
    if (def[key] !== undefined && !(def[key] in spec.repos) && !REPO_RE.test(def[key])) {
      errors.push(`${w}.${key}: undefined repo alias '${def[key]}'`);
    }
  };
  switch (kind) {
    case 'comment':
      unknownKeys(def, ['verb', 'allowed_authors', 'on', 'params', 'repo'], w, errors);
      strList('allowed_authors');
      repoRef('repo');
      if (def.verb !== undefined && def.verb !== '*' && !/^[a-z][\w-]*$/i.test(def.verb)) errors.push(`${w}.verb: invalid`);
      if (def.on !== undefined && !(Array.isArray(def.on) && def.on.every(o => COMMENT_ON.includes(o)))) {
        errors.push(`${w}.on: must be a list of ${COMMENT_ON.join('|')}`);
      }
      if (def.params !== undefined) validateParams(def.params, `${w}.params`, errors);
      break;
    case 'commit':
      unknownKeys(def, ['repo', 'branch', 'author', 'paths'], w, errors);
      if (!def.repo) errors.push(`${w}.repo: required`);
      repoRef('repo');
      if (!def.branch) errors.push(`${w}.branch: required`);
      else if (typeof def.branch !== 'string') errors.push(`${w}.branch: must be a string`);
      if (!def.author) errors.push(`${w}.author: required (also the loop-avoidance guard)`);
      else if (typeof def.author !== 'string' && !(Array.isArray(def.author) && def.author.length)) {
        errors.push(`${w}.author: must be a string or non-empty list`);
      }
      strList('paths');
      break;
    case 'pull_request':
    case 'issue':
      unknownKeys(def, ['repo', 'events', 'labels', 'authors'], w, errors);
      repoRef('repo');
      if (!Array.isArray(def.events) || !def.events.length) errors.push(`${w}.events: non-empty list required`);
      strList('events');
      strList('labels');
      strList('authors');
      break;
    case 'ci_failure':
    case 'merge_conflict':
    case 'review': {
      unknownKeys(def, ['repo', 'pr_authors', ...(kind === 'ci_failure' ? ['skip_preexisting', 'dedup'] : []),
        ...(kind === 'review' ? ['reviewers', 'actions'] : [])], w, errors);
      repoRef('repo');
      // The PR-author allowlist is the gate (the bot fixing only its own PRs),
      // so it is mandatory: an omitted list must never mean "any PR".
      if (!Array.isArray(def.pr_authors) || !def.pr_authors.length) errors.push(`${w}.pr_authors: non-empty list required`);
      strList('pr_authors');
      if (kind === 'review') {
        if (!Array.isArray(def.reviewers) || !def.reviewers.length) errors.push(`${w}.reviewers: non-empty list required`);
        strList('reviewers');
        strList('actions');
      }
      if (def.skip_preexisting !== undefined && typeof def.skip_preexisting !== 'boolean') errors.push(`${w}.skip_preexisting: must be a boolean`);
      if (def.dedup !== undefined) {
        const dedupSeconds = parseDuration(def.dedup);
        // Cloudflare KV rejects an expirationTtl below 60s; 0 means no dedup.
        if (dedupSeconds === null || (dedupSeconds !== 0 && dedupSeconds < 60)) errors.push(`${w}.dedup: like 30m|2h|14d (at least 60s)`);
      }
      break;
    }
    case 'schedule':
      unknownKeys(def, ['cron'], w, errors);
      if (typeof def.cron !== 'string' || def.cron.trim().split(/\s+/).length !== 5) {
        errors.push(`${w}.cron: 5-field cron expression required`);
      }
      break;
    case 'telegram':
      unknownKeys(def, ['params'], w, errors);
      if (def.params !== undefined) validateParams(def.params, `${w}.params`, errors);
      break;
    case 'dispatch':
      unknownKeys(def, [], w, errors);
      break;
    case 'manual':
      unknownKeys(def, ['parameters'], w, errors);
      if (def.parameters !== undefined) validateParams(def.parameters, `${w}.parameters`, errors);
      break;
  }
}

function validateAgent(name, agent, spec, errors) {
  const where = `agents.${name}`;
  if (!isObj(agent)) return errors.push(`${where}: must be a map`);
  unknownKeys(agent, AGENT_KEYS, where, errors);
  const before = errors.length;
  validateTrigger(name, agent.trigger, spec, errors);
  if (errors.length > before) return;
  const kind = isObj(agent.trigger) ? Object.keys(agent.trigger)[0] : null;
  if (!TRIGGER_KINDS.includes(kind)) return;
  const tdef = agent.trigger[kind] || {};
  const ctx = triggerContext(kind, tdef, null);

  if (kind === 'dispatch') {
    // Everything a dispatched run may touch comes from the caller's allowlist
    // (spec.dispatch.callers), never from the agent entry itself.
    for (const k of ['access', 'prompt_file', 'actions', 'job']) {
      if (agent[k] !== undefined) errors.push(`${where}.${k}: not allowed on a dispatch agent`);
    }
  }

  // access: default-deny, so an agent with no access list gets no repos at all.
  const aliasesInAccess = new Set();
  if (agent.access !== undefined) {
    const repos = isObj(agent.access) ? agent.access.repos : undefined;
    if (!Array.isArray(repos)) errors.push(`${where}.access.repos: must be a list`);
    else repos.forEach((r, i) => {
      const w = `${where}.access.repos[${i}]`;
      if (!isObj(r)) return errors.push(`${w}: must be a map`);
      unknownKeys(r, ['name', 'scope', 'branches', 'paths', 'when'], w, errors);
      checkRepoRef(r.name, spec, ctx, `${w}.name`, errors);
      if (typeof r.name === 'string') aliasesInAccess.add(r.name);
      if (!SCOPES.includes(r.scope)) errors.push(`${w}.scope: must be one of ${SCOPES.join('|')}`);
      for (const k of ['branches', 'paths']) {
        if (r[k] !== undefined && !(Array.isArray(r[k]) && r[k].every(s => typeof s === 'string'))) {
          errors.push(`${w}.${k}: must be a list of strings`);
        }
      }
      // `when`: the entry is granted only when a declared *boolean* param of
      // the trigger is true (e.g. `specage=true`). The repo itself is still a
      // reviewed literal — free text never decides *which* repo, only
      // whether a listed one is included.
      if (r.when !== undefined) {
        if (!isVar(r.when) || paramRefType(r.when.slice(1), kind, tdef) !== 'boolean') {
          errors.push(`${w}.when: must reference a declared boolean param of the trigger`);
        }
      }
    });
  }
  if (agent.permissions !== undefined) {
    if (!isObj(agent.permissions)) errors.push(`${where}.permissions: must be a map`);
    else for (const [k, v] of Object.entries(agent.permissions)) {
      if (!PERMISSIONS.includes(k)) errors.push(`${where}.permissions.${k}: unknown permission`);
      else if (!['read', 'write'].includes(v)) errors.push(`${where}.permissions.${k}: must be read|write`);
    }
  }
  if (agent.secrets !== undefined && !(Array.isArray(agent.secrets) && agent.secrets.every(s => /^[A-Z][A-Z0-9_]*$/.test(s)))) {
    errors.push(`${where}.secrets: must be a list of secret names`);
  }

  // job (scheduled non-LLM work) vs prompt (an LLM session)
  const isJob = agent.job !== undefined;
  if (isJob) {
    if (kind !== 'schedule') errors.push(`${where}.job: only valid with a schedule trigger`);
    if (!JOBS.includes(agent.job)) errors.push(`${where}.job: must be one of ${JOBS.join('|')}`);
    for (const k of ['prompt', 'prompt_file', 'prompt_append', 'request', 'actions']) {
      if (agent[k] !== undefined) errors.push(`${where}.${k}: not allowed on a job agent`);
    }
  } else if (kind === 'schedule') {
    errors.push(`${where}.job: required for a schedule trigger`);
  }
  if (agent.concurrency !== undefined) {
    if (kind !== 'schedule') errors.push(`${where}.concurrency: only valid with a schedule trigger`);
    else if (typeof agent.concurrency !== 'string' || !/^[\w.-]+$/.test(agent.concurrency)) errors.push(`${where}.concurrency: must be a group name`);
  }
  if (agent.settings !== undefined) {
    if (!isJob) errors.push(`${where}.settings: only valid on a job agent`);
    else if (!isObj(agent.settings)) errors.push(`${where}.settings: must be a map`);
    else for (const [k, v] of Object.entries(agent.settings)) {
      if (!/^[a-z][a-z0-9_]*$/.test(k)) errors.push(`${where}.settings.${k}: invalid name`);
      if (!['string', 'number', 'boolean'].includes(typeof v)) errors.push(`${where}.settings.${k}: must be a scalar`);
    }
  }
  // request: the synthesized text a system trigger hands the agent.
  if (SYSTEM_FIELDS[kind]) {
    if (typeof agent.request !== 'string' || !agent.request.trim()) errors.push(`${where}.request: required for a ${kind} trigger`);
    else checkVars(agent.request, ctx, [], `${where}.request`, errors);
  } else if (agent.request !== undefined && !isJob) {
    errors.push(`${where}.request: only valid with a ${Object.keys(SYSTEM_FIELDS).join('|')} trigger`);
  }

  // prompt
  const hasInline = agent.prompt !== undefined;
  const hasFile = agent.prompt_file !== undefined;
  if (!isJob && hasInline === hasFile) errors.push(`${where}: exactly one of prompt|prompt_file required`);
  if (hasInline) {
    if (typeof agent.prompt !== 'string' || !agent.prompt.trim()) errors.push(`${where}.prompt: must be a non-empty string`);
    else checkVars(agent.prompt, ctx, [], `${where}.prompt`, errors);
  }
  if (hasFile) {
    const f = agent.prompt_file;
    const w = `${where}.prompt_file`;
    if (!isObj(f)) errors.push(`${w}: must be a map {repo, ref?, path}`);
    else {
      unknownKeys(f, ['repo', 'ref', 'path'], w, errors);
      if (typeof f.repo !== 'string' || (!(f.repo in spec.repos) && !REPO_RE.test(f.repo))) {
        errors.push(`${w}.repo: undefined repo alias '${f.repo}'`);
      } else if (!aliasesInAccess.has(f.repo) && !spec.prompt_repos.includes(f.repo)) {
        errors.push(`${w}.repo: '${f.repo}' must be in access or prompt_repos`);
      }
      if (typeof f.path !== 'string' || !f.path || f.path.startsWith('/') || f.path.split('/').includes('..')) {
        errors.push(`${w}.path: relative path without '..' required`);
      }
      if (f.ref !== undefined) {
        if (typeof f.ref !== 'string' || !f.ref) errors.push(`${w}.ref: must be a string`);
        else if (isVar(f.ref)) {
          const n = f.ref.slice(1);
          if (!trustedForRef(n)) errors.push(`${w}.ref: '${f.ref}' is not a trusted source for a ref`);
          else if (!lookup(ctx, n).found) errors.push(`${w}.ref: unknown variable '${f.ref}' (not provided by the trigger)`);
        }
      }
    }
  }
  if (agent.prompt_append !== undefined) {
    if (!Array.isArray(agent.prompt_append)) errors.push(`${where}.prompt_append: must be a list of snippet names`);
    else for (const s of agent.prompt_append) {
      if (!(s in spec.snippets)) errors.push(`${where}.prompt_append: unknown snippet '${s}'`);
    }
  }

  // backend/model/effort: literal | $var | `$var | default`
  for (const k of ['backend', 'model', 'effort']) {
    if (agent[k] === undefined) continue;
    if (typeof agent[k] !== 'string') errors.push(`${where}.${k}: must be a string`);
    else checkVars(agent[k].split('|')[0], ctx, [], `${where}.${k}`, errors);
  }
  if (agent.timeout !== undefined && parseDuration(agent.timeout) === null) errors.push(`${where}.timeout: like 30s|60m|2h`);
  if (agent.limits !== undefined) validateLimits(agent.limits, `${where}.limits`, errors);

  // actions
  if (agent.actions !== undefined) {
    if (!Array.isArray(agent.actions)) errors.push(`${where}.actions: must be a list`);
    else {
      const names = new Set();
      agent.actions.forEach((a, i) => {
        validateAction(`${where}.actions[${i}]`, a, spec, ctx, aliasesInAccess, errors);
        if (isObj(a) && typeof a.name === 'string') {
          if (names.has(a.name)) errors.push(`${where}.actions[${i}].name: duplicate '${a.name}'`);
          names.add(a.name);
        }
      });
    }
  }
}

function validateLimits(l, where, errors) {
  if (!isObj(l)) return errors.push(`${where}: must be a map`);
  unknownKeys(l, ['max_runs_per_hour'], where, errors);
  if (l.max_runs_per_hour !== undefined && !(Number.isInteger(l.max_runs_per_hour) && l.max_runs_per_hour > 0)) {
    errors.push(`${where}.max_runs_per_hour: positive integer required`);
  }
}

function validateAction(where, a, spec, ctx, accessAliases, errors) {
  if (!isObj(a)) return errors.push(`${where}: must be a map`);
  unknownKeys(a, ['name', 'parameters', ...ACTION_KINDS], where, errors);
  if (typeof a.name !== 'string' || !a.name) errors.push(`${where}.name: required`);
  const kinds = ACTION_KINDS.filter(k => k in a);
  if (kinds.length !== 1) return errors.push(`${where}: exactly one of ${ACTION_KINDS.join('|')} required`);
  const kind = kinds[0];
  const cfg = a[kind];
  if (a.parameters !== undefined) validateParams(a.parameters, `${where}.parameters`, errors);
  const declared = Object.keys(a.parameters || {});
  const w = `${where}.${kind}`;
  if (!isObj(cfg)) return errors.push(`${w}: must be a map`);
  const checkTemplate = (v, key) => {
    if (typeof v === 'string') checkVars(v, ctx, declared, `${w}.${key}`, errors);
  };
  const accessible = (ref, key) => {
    checkRepoRef(ref, spec, ctx, `${w}.${key}`, errors);
    if (typeof ref === 'string' && !accessAliases.has(ref)) {
      errors.push(`${w}.${key}: '${ref}' is not in the agent's access`);
    }
  };
  if (kind === 'dispatch_agent') {
    unknownKeys(cfg, ['agent', 'with'], w, errors);
    if (!(cfg.agent in spec.agents)) errors.push(`${w}.agent: unknown agent '${cfg.agent}'`);
    else {
      const target = spec.agents[cfg.agent].trigger;
      const tk = isObj(target) ? Object.keys(target)[0] : null;
      if (tk !== 'manual') errors.push(`${w}.agent: '${cfg.agent}' must have a manual trigger to be dispatched`);
      else {
        const params = (target.manual || {}).parameters || {};
        const given = cfg.with || {};
        for (const p of Object.keys(params)) if (!(p in given)) errors.push(`${w}.with: missing parameter '${p}' of '${cfg.agent}'`);
        for (const p of Object.keys(given)) if (!(p in params)) errors.push(`${w}.with: unknown parameter '${p}' of '${cfg.agent}'`);
      }
    }
    for (const [k, v] of Object.entries(cfg.with || {})) {
      if (k === 'repo') accessible(v, 'with.repo'); else checkTemplate(v, `with.${k}`);
    }
  } else if (kind === 'dispatch_workflow') {
    unknownKeys(cfg, ['repo', 'name', 'scope', 'prompt'], w, errors);
    accessible(cfg.repo, 'repo');
    if (typeof cfg.name !== 'string' || !cfg.name) errors.push(`${w}.name: required`);
    if (cfg.scope !== undefined) {
      if (!isObj(cfg.scope)) errors.push(`${w}.scope: must be a map`);
      else {
        unknownKeys(cfg.scope, ['repo', 'issue'], `${w}.scope`, errors);
        if (cfg.scope.repo !== undefined) accessible(cfg.scope.repo, 'scope.repo');
        if (cfg.scope.issue !== undefined) checkTemplate(String(cfg.scope.issue), 'scope.issue');
      }
    }
    if (cfg.prompt !== undefined) {
      if (typeof cfg.prompt !== 'string' || !cfg.prompt.trim()) errors.push(`${w}.prompt: must be a non-empty string when present`);
      else checkTemplate(cfg.prompt, 'prompt');
    }
  } else {
    unknownKeys(cfg, ['repo', 'issue', 'body', 'title', 'labels'], w, errors);
    accessible(cfg.repo, 'repo');
    for (const k of ['issue', 'body', 'title']) if (cfg[k] !== undefined) checkTemplate(String(cfg[k]), k);
  }
}

// --- dispatch_agent: generic caller dispatch ------------------------------
// `dispatch.callers` is the allowlist for the generic entrypoint: keyed by the
// GitHub login that fires the workflow_dispatch (github.actor, which the
// caller cannot choose), it names the repos the caller may target, the extra
// repos it may grant the agent, the callbacks it may request and the prompt
// sources (repo + path/ref globs) it may use. Anything not listed is rejected.
const DISPATCH_KEYS = ['max_attempts', 'callers'];
const CALLER_KEYS = ['repos', 'access', 'callbacks', 'prompts', 'inline_prompt'];
const DISPATCH_REQUEST_KEYS = ['prompt', 'backend', 'model', 'effort', 'repo', 'issue', 'pr', 'access', 'callback',
  'context', 'attempt', 'max_attempts'];
const REPO_PATTERN_RE = /^[\w.-]+\/(?:[\w.-]+|\*)$/;
const WORKFLOW_RE = /^[\w.-]+\.ya?ml$/;
const PROMPT_SOURCE_RE = /^([\w.-]+\/[\w.-]+):([^@\s]+)@(\S+)$/;
const MAX_DISPATCH_ACCESS = 10;
const MAX_DISPATCH_PROMPT = 60000;
const MAX_DISPATCH_CONTEXT = 8000;
const DEFAULT_MAX_ATTEMPTS_CAP = 5;

function validateDispatch(spec, errors) {
  const d = spec.dispatch;
  if (!isObj(d)) return errors.push('dispatch: must be a map');
  unknownKeys(d, DISPATCH_KEYS, 'dispatch', errors);
  if (d.max_attempts !== undefined && !(Number.isInteger(d.max_attempts) && d.max_attempts >= 1)) {
    errors.push('dispatch.max_attempts: must be a positive integer');
  }
  if (d.callers === undefined) return;
  if (!isObj(d.callers)) return errors.push('dispatch.callers: must be a map of login -> allowlist');
  const repoPattern = (v, w) => {
    if (typeof v !== 'string' || !(v in spec.repos || REPO_PATTERN_RE.test(v))) errors.push(`${w}: undefined repo alias or pattern '${v}'`);
  };
  const globs = (v, w) => {
    if (!(Array.isArray(v) && v.length && v.every(g => typeof g === 'string' && g))) errors.push(`${w}: non-empty list of globs required`);
  };
  for (const [login, c] of Object.entries(d.callers)) {
    const where = `dispatch.callers.${login}`;
    if (!isObj(c)) { errors.push(`${where}: must be a map`); continue; }
    unknownKeys(c, CALLER_KEYS, where, errors);
    if (!Array.isArray(c.repos) || !c.repos.length) errors.push(`${where}.repos: non-empty list required (default-deny)`);
    else c.repos.forEach((r, i) => repoPattern(r, `${where}.repos[${i}]`));
    for (const [i, a] of (c.access === undefined ? [] : Array.isArray(c.access) ? c.access : [null]).entries()) {
      const w = `${where}.access[${i}]`;
      if (!isObj(a)) { errors.push(`${w}: must be a map`); continue; }
      unknownKeys(a, ['repo', 'scope'], w, errors);
      repoPattern(a.repo, `${w}.repo`);
      if (!SCOPES.includes(a.scope)) errors.push(`${w}.scope: must be one of ${SCOPES.join('|')}`);
    }
    for (const [i, cb] of (c.callbacks === undefined ? [] : Array.isArray(c.callbacks) ? c.callbacks : [null]).entries()) {
      const w = `${where}.callbacks[${i}]`;
      if (!isObj(cb)) { errors.push(`${w}: must be a map`); continue; }
      unknownKeys(cb, ['repo', 'workflow'], w, errors);
      if (typeof cb.repo !== 'string' || !(cb.repo in spec.repos || REPO_RE.test(cb.repo))) errors.push(`${w}.repo: undefined repo alias '${cb.repo}'`);
      if (typeof cb.workflow !== 'string' || !WORKFLOW_RE.test(cb.workflow)) errors.push(`${w}.workflow: workflow file name like callback.yml required`);
    }
    for (const [i, pr] of (c.prompts === undefined ? [] : Array.isArray(c.prompts) ? c.prompts : [null]).entries()) {
      const w = `${where}.prompts[${i}]`;
      if (!isObj(pr)) { errors.push(`${w}: must be a map`); continue; }
      unknownKeys(pr, ['repo', 'paths', 'refs'], w, errors);
      if (typeof pr.repo !== 'string' || !(pr.repo in spec.repos || REPO_RE.test(pr.repo))) errors.push(`${w}.repo: undefined repo alias '${pr.repo}'`);
      globs(pr.paths, `${w}.paths`);
      globs(pr.refs, `${w}.refs`); // a ref is always required: prompts are pinned
    }
    if (c.inline_prompt !== undefined && typeof c.inline_prompt !== 'boolean') errors.push(`${where}.inline_prompt: must be a boolean`);
  }
}

// alias | owner/repo | owner/* against a concrete owner/repo.
function repoPatternMatches(spec, pattern, repo) {
  const full = spec.repos[pattern] || pattern;
  if (full.endsWith('/*')) return lc(repo).startsWith(`${lc(full.slice(0, -1))}`);
  return lc(full) === lc(repo);
}

// Parses the dispatch_agent workflow_dispatch input (JSON text) into a request
// object; throws on anything that is not a JSON object.
function eventFromDispatch(actor, rawInput) {
  let request;
  try {
    request = typeof rawInput === 'string' ? JSON.parse(rawInput) : rawInput;
  } catch (e) {
    throw new Error(`dispatch input is not valid JSON: ${e.message}`);
  }
  if (!isObj(request)) throw new Error('dispatch input must be a JSON object');
  return { kind: 'dispatch', caller: actor || '', repo: typeof request.repo === 'string' ? request.repo : '', author: actor || '', request };
}

// Checks a dispatch request against the caller's allowlist. Returns
// { error } or { values } (the trigger values for resolveAgent). Every
// rejection names the rule it hit; nothing is silently narrowed.
function normalizeDispatch(spec, event) {
  const fail = (message) => ({ error: `dispatch_agent: ${message}` });
  const d = spec.dispatch || {};
  const caller = event.caller;
  // Loop avoidance: the bot's own dispatches (and its callbacks) never start a run.
  if (!caller || lc(caller) === lc(botLogin(spec))) return fail(`dispatches from '${caller || '(unknown)'}' are refused (loop avoidance)`);
  const entry = Object.entries(d.callers || {}).find(([login]) => lc(login) === lc(caller));
  if (!entry) return fail(`caller '${caller}' is not in dispatch.callers`);
  const c = entry[1];
  const req = event.request;
  for (const k of Object.keys(req)) if (!DISPATCH_REQUEST_KEYS.includes(k)) return fail(`unknown field '${k}'`);

  // `repo` / `issue` / `pr` are optional: target details may instead come from
  // the prompt, within the caller's `access` allowlist. A given repo is still
  // checked against `repos` and becomes the read/write workspace.
  let repo = '';
  if (req.repo !== undefined && req.repo !== null && req.repo !== '') {
    repo = req.repo;
    if (typeof repo !== 'string' || !REPO_RE.test(repo)) return fail('repo must be owner/repo');
    if (!allowedOwners(spec).has(lc(repo.split('/')[0]))) return fail(`owner of '${repo}' is not allowlisted`);
    if (!c.repos.some(p => repoPatternMatches(spec, p, repo))) return fail(`caller '${caller}' may not target '${repo}'`);
  }

  const int = (v, what) => {
    const n = typeof v === 'string' && /^\d+$/.test(v) ? Number(v) : v;
    return Number.isInteger(n) && n > 0 ? n : `${what} must be a positive integer`;
  };
  let issue = null;
  let pr = null;
  for (const [key, v] of [['issue', req.issue], ['pr', req.pr]]) {
    if (v === undefined || v === null || v === '') continue;
    const n = int(v, key);
    if (typeof n === 'string') return fail(n);
    if (key === 'issue') issue = n; else pr = n;
  }
  if ((issue !== null || pr !== null) && !repo) return fail('issue / pr need a repo');

  const cap = d.max_attempts ?? DEFAULT_MAX_ATTEMPTS_CAP;
  const attempt = req.attempt === undefined ? 1 : int(req.attempt, 'attempt');
  const maxAttempts = req.max_attempts === undefined ? 1 : int(req.max_attempts, 'max_attempts');
  if (typeof attempt === 'string') return fail(attempt);
  if (typeof maxAttempts === 'string') return fail(maxAttempts);
  if (maxAttempts > cap) return fail(`max_attempts ${maxAttempts} exceeds the cap of ${cap}`);
  if (attempt > maxAttempts) return fail(`attempt ${attempt} exceeds max_attempts ${maxAttempts}`);

  for (const [k, re] of [['backend', null], ['model', /^[\w.:[\]-]{1,64}$/], ['effort', /^[\w-]{1,20}$/]]) {
    const v = req[k];
    if (v === undefined || v === '') continue;
    if (typeof v !== 'string') return fail(`${k} must be a string`);
    if (k === 'backend' ? !BACKEND_KEYWORDS.includes(v.toLowerCase()) : !re.test(v)) return fail(`invalid ${k} '${v}'`);
  }

  // Extra repos: each must be covered by an allowlisted entry of at least that scope.
  const extra = [];
  if (req.access !== undefined) {
    if (!Array.isArray(req.access) || req.access.length > MAX_DISPATCH_ACCESS) return fail(`access must be a list of at most ${MAX_DISPATCH_ACCESS} {repo, scope}`);
    for (const a of req.access) {
      if (!isObj(a) || typeof a.repo !== 'string' || !REPO_RE.test(a.repo) || !SCOPES.includes(a.scope)) return fail(`malformed access entry ${JSON.stringify(a)}`);
      const ok = (c.access || []).some(g => repoPatternMatches(spec, g.repo, a.repo) && (a.scope === 'read' || g.scope === 'read/write'));
      if (!ok) return fail(`access ${a.scope} to '${a.repo}' is not allowed for caller '${caller}'`);
      extra.push({ repo: a.repo, scope: a.scope });
    }
  }

  let callback = null;
  if (req.callback !== undefined && req.callback !== null) {
    const cb = req.callback;
    if (!isObj(cb) || typeof cb.repo !== 'string' || typeof cb.workflow !== 'string') return fail('callback must be {repo, workflow}');
    const ok = (c.callbacks || []).some(g => repoPatternMatches(spec, g.repo, cb.repo) && g.workflow === cb.workflow);
    if (!ok) return fail(`callback ${cb.repo}/${cb.workflow} is not allowed for caller '${caller}'`);
    callback = { repo: cb.repo, workflow: cb.workflow };
  }

  let context = {};
  if (req.context !== undefined && req.context !== null) {
    if (!isObj(req.context)) return fail('context must be a JSON object');
    context = req.context;
  }
  if (JSON.stringify(context).length > MAX_DISPATCH_CONTEXT) return fail(`context is larger than ${MAX_DISPATCH_CONTEXT} characters`);

  // Prompt: `owner/repo:path@ref` (pinned; the resolved sha is recorded at
  // fetch time) or inline text when the caller is allowed inline prompts.
  const rawPrompt = req.prompt;
  if (typeof rawPrompt !== 'string' || !rawPrompt.trim()) return fail('prompt is required');
  if (rawPrompt.length > MAX_DISPATCH_PROMPT) return fail(`prompt is larger than ${MAX_DISPATCH_PROMPT} characters`);
  let promptSource = null;
  let inlinePrompt = null;
  const m = PROMPT_SOURCE_RE.exec(rawPrompt.trim());
  if (m) {
    const [, srepo, spath, sref] = m;
    if (spath.startsWith('/') || spath.split('/').includes('..') || sref.includes('..')) return fail('prompt source path/ref is not a safe relative reference');
    const ok = (c.prompts || []).some(g => repoPatternMatches(spec, g.repo, srepo)
      && g.paths.some(p => globToRegExp(p).test(spath)) && g.refs.some(r => globToRegExp(r).test(sref)));
    if (!ok) return fail(`prompt source ${srepo}:${spath}@${sref} is not allowed for caller '${caller}'`);
    promptSource = { repo: srepo, path: spath, ref: sref };
  } else {
    if (c.inline_prompt !== true) return fail(`inline prompts are not allowed for caller '${caller}'`);
    inlinePrompt = rawPrompt;
  }

  const backend = req.backend ? String(req.backend).toLowerCase() : '';
  return {
    values: {
      repo, author: caller, issue_number: pr ?? issue ?? '', text: inlinePrompt ?? '',
      params: backend ? { backend } : {},
      dispatch: {
        caller, repo, issue, pr, attempt, max_attempts: maxAttempts, model: req.model || '', effort: req.effort || '',
        backend, access: extra, callback, context: { ...context, attempt, max_attempts: maxAttempts },
        prompt_source: promptSource,
      },
    },
  };
}

// Detect agents whose triggers could both fire on one event.
function checkAmbiguity(spec, errors) {
  const seen = new Map();
  for (const [name, agent] of Object.entries(spec.agents)) {
    if (!isObj(agent) || !isObj(agent.trigger)) continue;
    const kind = Object.keys(agent.trigger)[0];
    const def = agent.trigger[kind] || {};
    let key = null;
    if (kind === 'comment') key = `comment:${(def.verb || name).toLowerCase()}:${(def.on || COMMENT_ON).slice().sort()}`;
    else if (kind === 'commit') key = `commit:${spec.repos[def.repo] || def.repo}:${def.branch}`.toLowerCase();
    else if (kind === 'schedule') key = `schedule:${def.cron}`;
    else if (SYSTEM_FIELDS[kind]) key = `${kind}:${lc(spec.repos[def.repo] || def.repo || '*')}`;
    else if (kind === 'telegram') key = 'telegram';
    else if (kind === 'dispatch') key = 'dispatch';
    if (key === null) continue;
    if (seen.has(key)) errors.push(`agents.${name}: ambiguous trigger, same as agent '${seen.get(key)}'`);
    else seen.set(key, name);
  }
}

// Returns { spec, errors } for an already-parsed YAML document. `spec` is
// normalized (defaults/repo aliases not yet applied to agents — see
// resolveAgent) and only usable when errors is empty.
function loadSpecObject(raw) {
  const errors = [];
  if (!isObj(raw)) return { spec: null, errors: ['top level must be a map'] };
  unknownKeys(raw, TOP_KEYS, 'top level', errors);
  if (raw.version !== 1) errors.push('version: must be 1');
  const spec = {
    version: raw.version,
    bot: raw.bot || 'the-intern-bot',
    defaults: raw.defaults || {},
    repos: raw.repos || {},
    allowed_owners: raw.allowed_owners || [],
    prompt_repos: raw.prompt_repos || [],
    snippets: raw.snippets || {},
    dispatch: raw.dispatch || {},
    agents: raw.agents || {},
  };
  if (typeof spec.bot !== 'string' || !/^[\w-]+$/.test(spec.bot)) errors.push('bot: must be a GitHub login');
  if (!isObj(spec.defaults)) { errors.push('defaults: must be a map'); spec.defaults = {}; }
  else {
    unknownKeys(spec.defaults, DEFAULT_KEYS, 'defaults', errors);
    if (spec.defaults.timeout !== undefined && parseDuration(spec.defaults.timeout) === null) errors.push('defaults.timeout: like 30s|60m|2h');
    if (spec.defaults.limits !== undefined) validateLimits(spec.defaults.limits, 'defaults.limits', errors);
  }
  if (!isObj(spec.repos)) { errors.push('repos: must be a map of alias -> owner/repo'); spec.repos = {}; }
  for (const [a, r] of Object.entries(spec.repos)) {
    if (typeof r !== 'string' || !REPO_RE.test(r)) errors.push(`repos.${a}: must be owner/repo`);
  }
  if (!isObj(spec.snippets)) { errors.push('snippets: must be a map'); spec.snippets = {}; }
  if (!Array.isArray(spec.allowed_owners) || !spec.allowed_owners.every(s => typeof s === 'string')) {
    errors.push('allowed_owners: must be a list of owners');
    spec.allowed_owners = [];
  }
  if (!Array.isArray(spec.prompt_repos)) { errors.push('prompt_repos: must be a list'); spec.prompt_repos = []; }
  else for (const r of spec.prompt_repos) {
    if (!(r in spec.repos) && !REPO_RE.test(r)) errors.push(`prompt_repos: undefined repo alias '${r}'`);
  }
  if (!isObj(spec.agents) || !Object.keys(spec.agents).length) {
    errors.push('agents: at least one agent required');
    return { spec: null, errors };
  }
  validateDispatch(spec, errors);
  for (const [name, agent] of Object.entries(spec.agents)) validateAgent(name, agent, spec, errors);
  if (!errors.length) checkAmbiguity(spec, errors);
  return { spec: errors.length ? null : spec, errors };
}

const toRepo = (spec, ref) => spec.repos[ref] || ref;
const lc = s => String(s || '').toLowerCase();
const authorList = a => (a === undefined ? null : [].concat(a).map(lc));
const botLogin = spec => `${spec.bot}[bot]`;

// Coerces a raw `key=value` string to a declared param type; undefined when
// it doesn't fit (then it stays prompt text / is ignored).
function coerceParam(type, v) {
  if (type === 'integer') return /^\d+$/.test(v) ? Number(v) : undefined;
  if (type === 'boolean') return /^(true|false)$/i.test(v) ? v.toLowerCase() === 'true' : undefined;
  return v;
}

// Validates typed parameters (manual triggers, action parameters). Returns an
// error string or null.
function checkTyped(declared, given, what = 'parameter') {
  for (const [k, t] of Object.entries(declared)) {
    const v = given[k];
    if (v === undefined) return `missing ${what} '${k}'`;
    if (t === 'integer' && !Number.isInteger(v)) return `${what} '${k}' must be an integer`;
    if (t === 'string' && typeof v !== 'string') return `${what} '${k}' must be a string`;
    if (t === 'boolean' && typeof v !== 'boolean') return `${what} '${k}' must be a boolean`;
  }
  for (const k of Object.keys(given)) if (!(k in declared)) return `unknown ${what} '${k}'`;
  return null;
}

// Does `event` fire this agent? Returns null or { kind, values } where values
// are the trigger fields ($trigger.<kind>.*) taken from the event, plus `text`
// (the request with control tokens removed) for comment/telegram.
// event: { kind, repo, author, ... } — normalized by the caller (see
// eventFromWebhook / eventFromTelegram):
//   comment: body, on, issue_number, implicit? | commit: branch, sha, paths |
//   telegram: body, chat_id, message_id | pull_request/issue: action, labels, number |
//   manual: agent, parameters | schedule: agent
// `implicit` on a comment means the mention gate is already satisfied by
// context — a reply on a thread the bot itself authored, a workflow_dispatch
// run, or an event the system synthesized (CI failure etc.) — so a catch-all
// (`verb: '*'`) agent matches without the literal @mention.
function matchAgent(spec, name, event) {
  const agent = spec.agents[name];
  const kind = Object.keys(agent.trigger)[0];
  if (event.kind !== kind) return null;
  const def = agent.trigger[kind] || {};
  const repo = lc(event.repo);
  if (def.repo && kind !== 'commit' && repo !== lc(toRepo(spec, def.repo))) return null;
  const authors = authorList(def.allowed_authors ?? def.authors);
  if (authors && !authors.includes(lc(event.author))) return null;

  if (kind === 'comment') {
    if (def.on && !def.on.includes(event.on)) return null;
    const verb = def.verb || name;
    const bot = `@${esc(spec.bot)}(?:\\[bot\\])?`;
    const body = event.body || '';
    const declared = def.params || {};
    const params = {};
    let text;
    if (verb === '*') {
      // Catch-all: any mention (anywhere in the body), optionally followed by
      // a backend keyword, like the pre-yaml mention gate.
      const m = new RegExp(`(?:^|\\s)${bot}(?![\\w-])(?:\\s+(${BACKEND_KEYWORDS.join('|')})(?![\\w-]))?`, 'i').exec(body);
      if (!m && !event.implicit) return null;
      if (m && m[1] && 'backend' in declared) params.backend = m[1].toLowerCase();
      // Every mention (and a backend keyword right after it) is stripped from
      // the request text, as parse-trigger.js always did.
      text = body.replace(new RegExp(`${bot}(?![\\w-])\\s*(?:(?:${BACKEND_KEYWORDS.join('|')})(?![\\w-])\\s*)?`, 'gi'), '').trim();
    } else {
      const m = new RegExp(`^\\s*${bot}\\s+(${esc(verb)})(?![\\w-])(.*)$`, 'is').exec(body);
      if (!m) return null;
      text = m[2].trim();
    }
    // Only a leading run of declared key=value tokens counts; the run ends at
    // the first undeclared one, which stays prompt text (e.g. `-c model=x`
    // later in the request is never a control token).
    let rest = text;
    for (;;) {
      const t = /^([a-z_]\w*)=(\S+)\s*/i.exec(rest);
      if (!t || !(t[1].toLowerCase() in declared)) break;
      const k = t[1].toLowerCase();
      const v = coerceParam(declared[k], t[2]);
      if (v !== undefined) params[k] = v;
      rest = rest.slice(t[0].length);
    }
    text = rest.replace(/\s+/g, ' ').trim();
    return { kind, values: { repo: event.repo, author: event.author, issue_number: event.issue_number, params, text } };
  }
  if (kind === 'commit') {
    if (repo !== lc(toRepo(spec, def.repo))) return null;
    if (!authorList(def.author).includes(lc(event.author))) return null;
    const { re } = branchPattern(def.branch);
    const bm = re.exec(event.branch || '');
    if (!bm) return null;
    if (def.paths && !(event.paths || []).some(p => def.paths.some(g => globToRegExp(g).test(p)))) return null;
    return { kind, values: { repo: event.repo, author: event.author, sha: event.sha, branch: event.branch, matcher: { ...bm.groups } } };
  }
  if (kind === 'pull_request' || kind === 'issue') {
    if (!def.events.includes(event.action)) return null;
    if (def.labels && !def.labels.some(l => (event.labels || []).includes(l))) return null;
    return { kind, values: { repo: event.repo, author: event.author, number: event.number } };
  }
  if (kind === 'telegram') {
    // Same convention as the old parse-telegram-trigger.js: declared
    // `key=value` tokens anywhere in the text are control tokens and are
    // removed from the message.
    const declared = def.params || {};
    const params = {};
    const body = event.body || '';
    for (const [, k, v] of body.matchAll(/(?:^|\s)([a-z_]\w*)=(\S+)/gi)) {
      const key = k.toLowerCase();
      if (!(key in declared)) continue;
      const val = coerceParam(declared[key], v);
      if (val !== undefined) params[key] = val;
    }
    const names = Object.keys(declared);
    const text = names.length
      ? body.replace(new RegExp(`(?:^|\\s)(?:${names.map(esc).join('|')})=\\S+`, 'gi'), ' ').replace(/\s+/g, ' ').trim()
      : body.replace(/\s+/g, ' ').trim();
    return { kind, values: { chat_id: event.chat_id, message_id: event.message_id, params, text } };
  }
  if (SYSTEM_FIELDS[kind]) {
    // Structural gates only: who authored the PR (and, for a review, who
    // reviewed it) decides whether the system may act on it.
    if (!(def.pr_authors || []).map(lc).includes(lc(event.pr_author))) return null;
    const values = { repo: event.repo, author: event.author || '', number: event.number };
    if (kind === 'ci_failure' && !['failure', 'timed_out'].includes(event.conclusion)) return null;
    if (kind === 'merge_conflict' && event.mergeable_state !== 'dirty') return null;
    if (kind === 'review') {
      if (!(def.reviewers || []).map(lc).includes(lc(event.reviewer))) return null;
      if (!(def.actions || ['submitted']).includes(event.action)) return null;
    }
    for (const f of SYSTEM_FIELDS[kind]) values[f] = event[f] ?? '';
    return { kind, values };
  }
  if (kind === 'dispatch') {
    const r = normalizeDispatch(spec, event);
    return r.error ? { error: r.error } : { kind, values: r.values };
  }
  if (kind === 'schedule') return event.agent === name ? { kind, values: {} } : null;
  if (kind === 'manual') {
    if (event.agent !== name) return null;
    const parameters = event.parameters || {};
    const error = checkTyped(def.parameters || {}, parameters);
    if (error) return { error };
    return { kind, values: { parameters } };
  }
  return null;
}

function interpolate(str, ctx, extra = {}) {
  return str.replace(VAR_RE, (whole, name) => {
    if (name in extra) return String(extra[name]);
    const r = lookup(ctx, name);
    return r.found && r.value !== undefined && r.value !== null ? String(r.value) : whole;
  });
}

// Like interpolate, but a variable that is missing or empty is an error: a
// synthesized request must never reach the agent with a hole in it.
function interpolateStrict(str, ctx) {
  return str.replace(VAR_RE, (whole, name) => {
    const r = lookup(ctx, name);
    if (!r.found || r.value === undefined || r.value === null || r.value === '') {
      throw new Error(`request: '$${name}' resolved to nothing`);
    }
    return String(r.value);
  });
}

// Resolves `$var | fallback` (fallback defaults to the agent default).
function resolveSetting(raw, ctx) {
  const [head, ...rest] = String(raw).split('|').map(s => s.trim());
  const fallback = rest.length ? rest[rest.length - 1] : 'default';
  if (isVar(head)) {
    const r = lookup(ctx, head.slice(1));
    return r.found && r.value ? String(r.value) : fallback;
  }
  return head;
}

function allowedOwners(spec) {
  return new Set([
    ...spec.allowed_owners.map(lc),
    ...Object.values(spec.repos).map(r => lc(r.split('/')[0])),
  ]);
}

// alias | owner/repo | $trusted-var -> owner/repo, or throws. Never a silent
// partial scope: a capture that isn't a declared alias, or an owner outside
// the allowlist, is an error.
function resolveRepoRef(spec, ctx, ref) {
  if (ref === ALL_REPOS) return ref;
  let full = ref;
  if (isVar(ref)) {
    const r = lookup(ctx, ref.slice(1));
    full = r.found ? r.value : undefined;
    if (typeof full !== 'string' || !full) throw new Error(`access: '${ref}' resolved to nothing`);
    // Branch captures are bare project names: they must be declared in `repos`.
    if (full in spec.repos) full = spec.repos[full];
  } else if (ref in spec.repos) full = spec.repos[ref];
  if (!REPO_RE.test(full)) throw new Error(`access: '${full}' is not a valid owner/repo`);
  if (!allowedOwners(spec).has(lc(full.split('/')[0]))) throw new Error(`access: owner of '${full}' is not allowlisted`);
  return full;
}

// Fully resolves an agent for a matched trigger: defaults applied, repos
// validated against the owner allowlist, access list concretized.
// Throws on any invalid resolved repo — never a silent partial scope.
function resolveAgent(spec, name, match) {
  const agent = spec.agents[name];
  const ctx = triggerContext(match.kind, agent.trigger[match.kind] || {}, match.values);
  const resolveRepo = ref => resolveRepoRef(spec, ctx, ref);
  const d = spec.defaults;
  const pick = (k, fb) => agent[k] !== undefined ? agent[k] : d[k] !== undefined ? d[k] : fb;
  const granted = (agent.access?.repos || []).filter(r => {
    if (r.when === undefined) return true;
    const v = lookup(ctx, r.when.slice(1));
    return v.found && v.value === true;
  });
  const access = granted.map(r => ({
    repo: resolveRepo(r.name),
    scope: r.scope,
    ...(r.branches ? { branches: r.branches } : {}),
    ...(r.paths ? { paths: r.paths } : {}),
  }));
  const dispatch = match.kind === 'dispatch' ? match.values.dispatch : null;
  if (dispatch) {
    // The allowlist already vetted these in normalizeDispatch; here they only
    // become the token scope: the target (read/write) and the extra grants.
    // The prompt source is fetched with its own read-only token, so it is not
    // listed here. A repo listed twice keeps the wider scope.
    const wanted = [
      ...(dispatch.repo ? [{ repo: dispatch.repo, scope: 'read/write' }] : []),
      ...dispatch.access,
    ];
    for (const w of wanted) {
      const have = access.find(a => lc(a.repo) === lc(w.repo));
      if (!have) access.push({ repo: w.repo, scope: w.scope });
      else if (w.scope === 'read/write') have.scope = 'read/write';
    }
  }
  let prompt = null;
  let prompt_file = null;
  if (agent.prompt_file) {
    let ref = agent.prompt_file.ref || null;
    if (ref && isVar(ref)) {
      const r = lookup(ctx, ref.slice(1));
      if (!r.found || typeof r.value !== 'string' || !r.value) throw new Error(`prompt_file.ref: '${ref}' resolved to nothing`);
      ref = r.value;
    }
    prompt_file = { repo: resolveRepo(agent.prompt_file.repo), ref, path: agent.prompt_file.path };
  } else {
    prompt = agent.prompt === undefined ? null : interpolate(agent.prompt, ctx);
  }
  const request = agent.request === undefined ? null : interpolateStrict(agent.request, ctx);
  const actions = (agent.actions || []).map(a => ({
    name: a.name,
    parameters: a.parameters || {},
    kind: ACTION_KINDS.find(k => k in a),
  }));
  return {
    agent: name,
    trigger: match.kind,
    backend: dispatch?.backend || resolveSetting(pick('backend', 'claude'), ctx),
    model: dispatch?.model || resolveSetting(pick('model', 'default'), ctx),
    effort: dispatch?.effort || resolveSetting(pick('effort', 'default'), ctx),
    timeout_seconds: parseDuration(pick('timeout', '60m')),
    limits: { max_runs_per_hour: (agent.limits || d.limits || {}).max_runs_per_hour ?? null },
    access,
    permissions: agent.permissions || {},
    secrets: agent.secrets || [],
    prompt,
    request,
    job: agent.job ?? null,
    concurrency: agent.concurrency ?? null,
    settings: agent.settings || {},
    prompt_file,
    prompt_append: (agent.prompt_append || []).map(s => spec.snippets[s]),
    // Pinned = ref given; otherwise the default branch of that repo.
    prompt_pinned: prompt_file ? Boolean(prompt_file.ref) : null,
    params: match.values.params || match.values.parameters || {},
    // Request text (comment/telegram) with control tokens removed; null for
    // triggers that carry no free text.
    text: match.values.text ?? null,
    actions,
    dispatch,
    repo: ctx.repo ?? null,
    issue_number: ctx.issue_number ?? null,
  };
}

// Executes the declarative part of an action an agent emitted at runtime:
// validates `params` against the action's declared parameters, resolves the
// `with` templates and checks the result against the *target* agent's manual
// trigger. Returns { kind: 'dispatch_agent', agent, parameters }; throws on
// anything undeclared or mistyped. Only dispatch_agent is executable today.
function resolveAction(spec, name, match, actionName, params = {}) {
  const agent = spec.agents[name];
  const action = (agent.actions || []).find(a => a.name === actionName);
  if (!action) throw new Error(`agent '${name}' declares no action '${actionName}'`);
  const err = checkTyped(action.parameters || {}, params);
  if (err) throw new Error(`action '${actionName}': ${err}`);
  const kind = ACTION_KINDS.find(k => k in action);
  if (kind !== 'dispatch_agent') throw new Error(`action '${actionName}': '${kind}' actions are not executable yet`);
  const ctx = triggerContext(match.kind, agent.trigger[match.kind] || {}, match.values);
  const resolved = resolveAgent(spec, name, match);
  const cfg = action.dispatch_agent;
  const parameters = {};
  for (const [k, v] of Object.entries(cfg.with || {})) {
    let out = v;
    if (k === 'repo') {
      out = resolveRepoRef(spec, ctx, v);
      if (!accessAllows(resolved, out)) throw new Error(`action '${actionName}': repo '${out}' is not in the agent's access`);
    } else if (isVar(v)) {
      // A bare `$var` keeps its type (an integer action param stays a number).
      const n = v.slice(1);
      out = n in params ? params[n] : lookup(ctx, n).value;
    } else if (typeof v === 'string') {
      out = interpolate(v, ctx, params);
    }
    parameters[k] = out;
  }
  const target = spec.agents[cfg.agent];
  const targetErr = checkTyped((target.trigger.manual || {}).parameters || {}, parameters);
  if (targetErr) throw new Error(`action '${actionName}' -> '${cfg.agent}': ${targetErr}`);
  return { kind, agent: cfg.agent, parameters };
}

// Is `repo` (and optionally branch/path) reachable under a resolved access list?
function accessAllows(resolved, repo, need = 'read', { branch, path } = {}) {
  return resolved.access.some(a => {
    if (a.repo !== ALL_REPOS && lc(a.repo) !== lc(repo)) return false;
    if (need === 'write' && a.scope !== 'read/write') return false;
    if (branch && a.branches && !a.branches.some(g => globToRegExp(g).test(branch))) return false;
    if (path && a.paths && !a.paths.some(g => globToRegExp(g).test(path))) return false;
    return true;
  });
}

// Which agent(s) fire for an event. >1 is an ambiguity error, never a guess.
function route(spec, event) {
  const hits = [];
  for (const name of Object.keys(spec.agents)) {
    const m = matchAgent(spec, name, event);
    if (m) hits.push({ name, match: m });
  }
  if (hits.length > 1) throw new Error(`ambiguous: ${hits.map(h => h.name).join(', ')} all match`);
  return hits[0] || null;
}

// Dry-run: what would happen for this event? Never throws on a non-match.
function explain(spec, event) {
  let hit;
  try {
    hit = route(spec, event);
  } catch (e) {
    return { matched: false, reason: e.message };
  }
  if (!hit) return { matched: false, reason: 'no agent trigger matches' };
  if (hit.match.error) return { matched: false, agent: hit.name, reason: hit.match.error };
  try {
    return { matched: true, ...resolveAgent(spec, hit.name, hit.match) };
  } catch (e) {
    return { matched: false, agent: hit.name, reason: e.message };
  }
}

// Normalizes a GitHub webhook delivery (what the worker receives, and what it
// forwards verbatim to dispatcher.yml) into a trigger event, or null when the
// event type carries no agent trigger. Shared by the worker and
// scripts/resolve-agent.js so both sides route identically.
function eventFromWebhook(spec, eventType, payload) {
  const repo = payload.repository?.full_name || '';
  if (eventType === 'push') {
    const ref = payload.ref || '';
    if (!ref.startsWith('refs/heads/')) return null;
    const sha = payload.after || '';
    const paths = new Set();
    for (const c of payload.commits || []) {
      for (const k of ['added', 'modified', 'removed']) for (const p of c[k] || []) paths.add(p);
    }
    return {
      kind: 'commit',
      repo,
      author: payload.sender?.login || '',
      branch: ref.slice('refs/heads/'.length),
      sha,
      deleted: Boolean(payload.deleted) || !sha || /^0+$/.test(sha),
      message: payload.head_commit?.message || '',
      paths: [...paths],
    };
  }
  let on;
  let author;
  let body;
  let issue_number;
  let thread_author;
  let comment_id;
  if (eventType === 'issue_comment') {
    on = payload.issue?.pull_request ? 'pr' : 'issue';
    author = payload.comment?.user?.login;
    body = payload.comment?.body;
    issue_number = payload.issue?.number;
    thread_author = payload.issue?.user?.login;
  } else if (eventType === 'pull_request_review') {
    on = 'pr';
    author = payload.review?.user?.login;
    body = payload.review?.body;
    issue_number = payload.pull_request?.number;
    thread_author = payload.pull_request?.user?.login;
  } else if (eventType === 'pull_request_review_comment') {
    on = 'review_thread';
    author = payload.comment?.user?.login;
    body = payload.comment?.body;
    issue_number = payload.pull_request?.number;
    thread_author = payload.pull_request?.user?.login;
    comment_id = payload.comment?.id;
  } else {
    return null;
  }
  author = author || payload.sender?.login || '';
  const bot = lc(botLogin(spec));
  // A reply on a thread the bot itself opened is an implicit request — unless
  // the bot wrote it (or every status update would re-trigger a dispatch).
  const implicit = Boolean(thread_author) && lc(thread_author) === bot && lc(author) !== bot;
  return {
    kind: 'comment',
    repo,
    author,
    on,
    issue_number: issue_number ?? null,
    body: typeof body === 'string' ? body : '',
    thread_author: thread_author || '',
    implicit,
    ...(comment_id !== undefined ? { comment_id } : {}),
  };
}

// Normalizes a system-synthesized request — the payload the worker forwards
// (and the nightly crawl sends) as a repository_dispatch — into a trigger
// event. `type` is the dispatch event type; returns null for other types. The
// worker builds its dispatch payload and routes it through this same function,
// so it and scripts/resolve-agent.js can never disagree.
const SYSTEM_EVENT_TYPES = { ci_failure: 'ci_failure', merge_conflict: 'merge_conflict', coderabbit_review: 'review' };
function eventFromSystem(type, raw) {
  const kind = SYSTEM_EVENT_TYPES[type];
  if (!kind) return null;
  const pr = raw.pull_request || {};
  const event = {
    kind,
    repo: raw.repository?.full_name || '',
    author: '',
    number: pr.number ?? null,
    pr_author: pr.user?.login || '',
  };
  if (kind === 'ci_failure') {
    Object.assign(event, {
      conclusion: raw.check_suite?.conclusion || '',
      head_sha: raw.check_suite?.head_sha || '',
      html_url: raw.check_suite?.html_url || '',
    });
  } else if (kind === 'merge_conflict') {
    Object.assign(event, {
      base_ref: raw.merge_conflict?.base_ref || '',
      mergeable_state: raw.merge_conflict?.mergeable_state || '',
    });
  } else {
    Object.assign(event, {
      reviewer: raw.coderabbit_review?.reviewer || '',
      html_url: raw.coderabbit_review?.html_url || '',
      action: raw.coderabbit_review?.action || '',
    });
  }
  return event;
}

// Lower-cased logins named by any `field` list (`pr_authors`, `reviewers`) of
// the agents with a `kind` trigger — lets the worker skip work for PRs/reviews
// no agent could take before it makes API calls. Routing stays authoritative.
function systemActors(spec, kind, field) {
  const out = new Set();
  for (const agent of Object.values(spec.agents || {})) {
    for (const l of agent?.trigger?.[kind]?.[field] || []) out.add(lc(l));
  }
  return out;
}

// Normalizes a Telegram message (Bot API `message` object, or the worker's
// forwarded client_payload) into a trigger event.
function eventFromTelegram(message) {
  return {
    kind: 'telegram',
    chat_id: message.chat?.id ?? message.chat_id ?? null,
    message_id: message.message_id ?? null,
    body: message.text || message.caption || '',
  };
}

module.exports = {
  loadSpecObject, matchAgent, route, resolveAgent, resolveAction, explain, accessAllows, branchPattern,
  parseDuration, eventFromWebhook, eventFromTelegram, eventFromSystem, eventFromDispatch, normalizeDispatch, systemActors, botLogin, ALL_REPOS, JOBS,
};
