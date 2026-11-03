// Loader, validator, trigger matcher and `explain` for agentic.yaml — the
// declarative source of truth for who triggers which agent, what it can touch,
// and what it runs. Pure functions only (no I/O, no network, no dependencies)
// so the worker (which bundles this file verbatim, see
// scripts/bundle-agentic.js), CI and tests can all share it. YAML parsing lives
// in ./agentic-yaml.js so this file stays dependency-free.

const TRIGGER_KINDS = ['comment', 'commit', 'pull_request', 'issue', 'schedule', 'manual', 'telegram'];
const SCOPES = ['read', 'read/write'];
// Access name meaning every repo the GitHub App is installed in.
const ALL_REPOS = '*';
const ACTION_KINDS = ['dispatch_agent', 'dispatch_workflow', 'comment', 'label', 'open_issue'];
const PARAM_TYPES = ['string', 'integer', 'boolean'];
const COMMENT_ON = ['issue', 'pr', 'review_thread'];
const PERMISSIONS = ['contents', 'issues', 'pull_requests', 'workflows', 'actions', 'checks', 'statuses'];
const AGENT_KEYS = ['trigger', 'access', 'prompt', 'prompt_file', 'prompt_append', 'backend', 'model',
  'effort', 'timeout', 'limits', 'actions', 'permissions', 'secrets', 'network', 'tools'];
const DEFAULT_KEYS = ['backend', 'model', 'effort', 'timeout', 'limits'];
const TOP_KEYS = ['version', 'bot', 'defaults', 'repos', 'allowed_owners', 'prompt_repos', 'snippets', 'agents'];
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
  const m = /^(\d+)(s|m|h)$/.exec(String(v));
  if (!m) return null;
  return Number(m[1]) * { s: 1, m: 60, h: 3600 }[m[2]];
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
    case 'telegram': {
      const param = {};
      for (const p of Object.keys(def.params || {})) param[p] = v ? (v.params || {})[p] : true;
      t = { chat_id: ph('chat_id'), message_id: ph('message_id'), param };
      break;
    }
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
  return /^(repo|trigger\.(comment|commit|pull_request|issue)\.repo|trigger\.commit\.matcher\.[a-z_]\w*|trigger\.manual\.parameters\.[a-z_]\w*)$/i.test(dotted);
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

  // prompt
  const hasInline = agent.prompt !== undefined;
  const hasFile = agent.prompt_file !== undefined;
  if (hasInline === hasFile) errors.push(`${where}: exactly one of prompt|prompt_file required`);
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
    else if (kind === 'telegram') key = 'telegram';
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
    prompt = interpolate(agent.prompt, ctx);
  }
  const actions = (agent.actions || []).map(a => ({
    name: a.name,
    parameters: a.parameters || {},
    kind: ACTION_KINDS.find(k => k in a),
  }));
  return {
    agent: name,
    trigger: match.kind,
    backend: resolveSetting(pick('backend', 'claude'), ctx),
    model: resolveSetting(pick('model', 'default'), ctx),
    effort: resolveSetting(pick('effort', 'default'), ctx),
    timeout_seconds: parseDuration(pick('timeout', '60m')),
    limits: { max_runs_per_hour: (agent.limits || d.limits || {}).max_runs_per_hour ?? null },
    access,
    permissions: agent.permissions || {},
    secrets: agent.secrets || [],
    prompt,
    prompt_file,
    prompt_append: (agent.prompt_append || []).map(s => spec.snippets[s]),
    // Pinned = ref given; otherwise the default branch of that repo.
    prompt_pinned: prompt_file ? Boolean(prompt_file.ref) : null,
    params: match.values.params || match.values.parameters || {},
    // Request text (comment/telegram) with control tokens removed; null for
    // triggers that carry no free text.
    text: match.values.text ?? null,
    actions,
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
  parseDuration, eventFromWebhook, eventFromTelegram, botLogin, ALL_REPOS,
};
