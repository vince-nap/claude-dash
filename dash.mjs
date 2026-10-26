#!/usr/bin/env node
// Dash: usage snapshots, projections and task planning for Claude Code accounts.
// Usage: node dash.mjs <command> [options]   (see `claude-dash help`)
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import { spawn, execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const HOME = os.homedir();
const HOUR = 3600e3;
const SESSION_MS = 5 * HOUR;
const WEEK_MS = 7 * 24 * HOUR;
const expand = p => (p && p.startsWith('~') ? path.join(HOME, p.slice(1)) : p);

// ---------- config ----------
// Looked up in order: --config <file>, $DASH_CONFIG, dash.config.json next to this script,
// then the per-user config file (see userConfigPath). Every key is optional.
function userConfigPath() {
  if (process.platform === 'win32') return path.join(process.env.APPDATA || path.join(HOME, 'AppData', 'Roaming'), 'claude-dash', 'config.json');
  return path.join(process.env.XDG_CONFIG_HOME || path.join(HOME, '.config'), 'claude-dash', 'config.json');
}
function defaultDataDir() {
  if (process.platform === 'win32') return path.join(process.env.LOCALAPPDATA || path.join(HOME, 'AppData', 'Local'), 'claude-dash');
  if (process.platform === 'darwin') return path.join(HOME, 'Library', 'Application Support', 'claude-dash');
  return path.join(process.env.XDG_DATA_HOME || path.join(HOME, '.local', 'share'), 'claude-dash');
}
const DEFAULTS = {
  accounts: null,            // null = auto-discover ~/.claude* config dirs
  defaultAccount: null,      // null = $CLAUDE_CONFIG_DIR, else ~/.claude
  dataDir: null,             // null = defaultDataDir()
  port: 7077,
  browser: null,             // path to a Chromium browser for `open --app`; null = try common locations
  idleShutdownMinutes: 30,
  costModel: {},             // overrides for SEED below
};
function findConfigFile(explicit) {
  const c = [explicit, process.env.DASH_CONFIG, path.join(HERE, 'dash.config.json'), userConfigPath()].filter(Boolean).map(expand);
  return c.find(f => fs.existsSync(f)) || null;
}
function loadConfig(explicit) {
  const file = findConfigFile(explicit);
  let user = {};
  if (file) {
    try { user = JSON.parse(fs.readFileSync(file, 'utf8')); }
    catch (e) { throw new Error(`config ${file} is not valid JSON: ${e.message}`); }
  } else if (explicit) throw new Error(`config file not found: ${explicit}`);
  const cfg = { ...DEFAULTS, ...user, file };
  cfg.dataDir = expand(cfg.dataDir) || defaultDataDir();
  return cfg;
}

// ---------- accounts ----------
// An account is a Claude Code config dir. The OAuth token comes from <dir>/.credentials.json,
// or (macOS) the login Keychain, or a `tokenCommand` you configure.
function discoverDirs() {
  return fs.readdirSync(HOME).filter(n => n.startsWith('.claude') && fs.statSync(path.join(HOME, n), { throwIfNoEntry: false })?.isDirectory()
    && (fs.existsSync(path.join(HOME, n, '.credentials.json')) || fs.existsSync(path.join(HOME, n, '.claude.json')) || n === '.claude'))
    .map(n => ({ key: n.replace(/^\./, ''), dir: path.join(HOME, n) }));
}
function configuredAccounts(cfg) {
  if (Array.isArray(cfg.accounts) && cfg.accounts.length) {
    return cfg.accounts.map(a => ({ key: a.key || path.basename(expand(a.dir)).replace(/^\./, ''), dir: expand(a.dir), tokenCommand: a.tokenCommand }));
  }
  return discoverDirs();
}
function readCreds(acct) {
  if (acct.tokenCommand) {
    const out = execSync(acct.tokenCommand, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    try { const j = JSON.parse(out); return j.claudeAiOauth || j; } catch { return { accessToken: out }; }
  }
  try { return JSON.parse(fs.readFileSync(path.join(acct.dir, '.credentials.json'), 'utf8')).claudeAiOauth || null; } catch {}
  if (process.platform === 'darwin' && path.resolve(acct.dir) === path.join(HOME, '.claude')) {
    try {
      const out = execSync('security find-generic-password -s "Claude Code-credentials" -w', { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
      return JSON.parse(out).claudeAiOauth || null;
    } catch {}
  }
  return null;
}
function accountInfo(acct) {
  const o = readCreds(acct) || {};
  let email = null;
  try { email = JSON.parse(fs.readFileSync(path.join(acct.dir, '.claude.json'), 'utf8')).oauthAccount?.emailAddress; } catch {}
  return { ...acct, plan: o.subscriptionType || 'unknown', tier: o.rateLimitTier || '', email, expiresAt: o.expiresAt };
}
function resolveAccount(cfg, sel) {
  const all = configuredAccounts(cfg);
  sel = sel || cfg.defaultAccount;
  if (!sel) {
    const env = expand(process.env.CLAUDE_CONFIG_DIR);
    const dir = env && fs.existsSync(env) ? env : path.join(HOME, '.claude');
    return accountInfo(all.find(a => path.resolve(a.dir) === path.resolve(dir)) || { key: path.basename(dir).replace(/^\./, ''), dir });
  }
  const want = String(sel).replace(/^\./, '');
  const hit = all.find(a => a.key === want) || all.map(accountInfo).find(a => a.plan === want);
  if (!hit) throw new Error(`No account '${sel}'. Known: ${all.map(a => a.key).join(', ') || '(none found)'}`);
  return accountInfo(hit);
}

// ---------- endpoint + history ----------
// Uses the same (unofficial) endpoint Claude Code's /usage reads. It may change without notice.
async function fetchUsage(acct) {
  const o = readCreds(acct);
  if (!o?.accessToken) throw new Error(`no OAuth token for ${acct.key} (log in with Claude Code on that account, or set tokenCommand in the config)`);
  if (o.expiresAt && o.expiresAt < Date.now()) throw new Error(`token for ${acct.key} expired; start a Claude Code session on that account to refresh it`);
  const r = await fetch('https://api.anthropic.com/api/oauth/usage', {
    headers: { Authorization: 'Bearer ' + o.accessToken, 'anthropic-beta': 'oauth-2025-04-20', 'User-Agent': 'claude-dash' },
  });
  if (!r.ok) throw new Error(`usage endpoint ${r.status}`);
  return r.json();
}
let DATA = null;
const acctDir = a => { const d = path.join(DATA, a.key); fs.mkdirSync(d, { recursive: true }); return d; };
function readJsonl(f) { try { return fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)); } catch { return []; } }
function readJson(f, dflt) { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return dflt; } }

function normalise(raw) {
  const pick = (kind, fb) => {
    const l = (raw.limits || []).find(x => x.kind === kind);
    const w = raw[fb];
    const pct = l?.percent ?? w?.utilization ?? null;
    const reset = l?.resets_at ?? w?.resets_at ?? null;
    return pct == null && !reset ? null : { pct, reset };
  };
  return {
    t: Date.now(),
    session: pick('session', 'five_hour'),
    weekly: pick('weekly_all', 'seven_day'),
    scoped: (raw.limits || []).filter(l => l.kind === 'weekly_scoped').map(l => ({ model: l.scope?.model?.display_name, pct: l.percent, reset: l.resets_at })),
    breakdown: raw.seven_day_breakdown?.rows?.map(r => ({ k: r.display_name, pct: r.percent })) || [],
    extra: raw.extra_usage?.is_enabled ? raw.extra_usage : null,
  };
}
async function snapshot(acct, { record = true } = {}) {
  const snap = normalise(await fetchUsage(acct));
  if (record) {
    const f = path.join(acctDir(acct), 'history.jsonl');
    const last = readJsonl(f).at(-1);
    // skip duplicates written within 60s with identical numbers
    const same = last && snap.t - last.t < 60e3 && last.session?.pct === snap.session?.pct && last.weekly?.pct === snap.weekly?.pct;
    if (!same) fs.appendFileSync(f, JSON.stringify(snap) + '\n');
  }
  return snap;
}

// ---------- projection ----------
// Burn rate in pct/hour for a window: recent slope if enough points, else average since window start.
function burn(points, start, now, pctNow) {
  const win = points.filter(p => p.t >= start && p.pct != null);
  const recent = win.filter(p => p.t >= now - 2 * HOUR);
  if (recent.length >= 2) {
    const a = recent[0], b = recent.at(-1);
    if (b.t - a.t > 5 * 60e3 && b.pct >= a.pct) return { rate: (b.pct - a.pct) / ((b.t - a.t) / HOUR), basis: 'recent slope' };
  }
  const el = (now - start) / HOUR;
  return { rate: el > 0.05 ? pctNow / el : 0, basis: 'window average' };
}
function project(hist, snap) {
  const now = snap.t;
  const out = {};
  for (const [name, span] of [['session', SESSION_MS], ['weekly', WEEK_MS]]) {
    const w = snap[name];
    if (!w || w.pct == null || !w.reset) { out[name] = null; continue; }
    const reset = Date.parse(w.reset), start = reset - span;
    const pts = hist.map(h => ({ t: h.t, pct: h[name]?.reset && Math.abs(Date.parse(h[name].reset) - reset) < 120e3 ? h[name].pct : null }));
    pts.push({ t: now, pct: w.pct });
    const { rate, basis } = burn(pts.filter(p => p.pct != null), start, now, w.pct);
    const hitsLimit = rate > 0 && w.pct + rate * (reset - now) / HOUR >= 100;
    out[name] = {
      pct: w.pct, start, reset, rate, basis,
      projectedAtReset: w.pct + rate * (reset - now) / HOUR,
      limitAt: hitsLimit ? now + (100 - w.pct) / rate * HOUR : null,
      points: pts.filter(p => p.pct != null && p.t >= start),
    };
  }
  return out;
}

// ---------- cost model ----------
// Seeds are relative estimates; `claude-dash done` recalibrates them from measured deltas.
// Override any of them with "costModel" in the config.
const SEED = {
  // % of a 5h session for a Sonnet @ medium run of each size, one agent
  sizes: { XS: 0.5, S: 2, M: 6, L: 15, XL: 35 },
  model: { haiku: 0.35, sonnet: 1, opus: 1.7, fable: 3 },
  effort: { low: 0.6, medium: 1, high: 1.6, xhigh: 2.4, max: 3.5 },
  weeklyPerSession: 0.12, // weekly % consumed per 1% of session (learned by `claude-dash done`)
};
let COST = SEED;
function loadCal(acct) {
  const c = readJson(path.join(acctDir(acct), 'calibration.json'), {});
  return { ...COST, ...c, sizes: { ...COST.sizes, ...c.sizes }, model: { ...COST.model, ...c.model }, effort: { ...COST.effort, ...c.effort }, runs: c.runs || [] };
}
const AGENT_PARALLEL_OVERHEAD = 0.15; // each extra agent re-reads context; cost = n * (1+overhead*(n>1))
function estimate(cal, size, model, effort, agents) {
  const base = cal.sizes[size] * cal.model[model] * cal.effort[effort];
  const session = base * agents * (agents > 1 ? 1 + AGENT_PARALLEL_OVERHEAD : 1);
  return { session, weekly: session * cal.weeklyPerSession };
}

// ---------- text rendering ----------
const fmtT = ms => new Date(ms).toLocaleString([], { weekday: 'short', hour: '2-digit', minute: '2-digit' });
const fmtIn = ms => { const m = Math.round(ms / 60e3); return m < 60 ? `${m}m` : m < 2880 ? `${(m / 60).toFixed(1)}h` : `${(m / 1440).toFixed(1)}d`; };
function bar(used, task, width = 40) {
  const u = Math.round(Math.min(100, used) / 100 * width);
  const t = Math.min(width - u, Math.round(Math.min(100, used + task) / 100 * width) - u);
  const over = used + task > 100;
  return '[' + '█'.repeat(u) + (over ? '▓' : '▒').repeat(Math.max(t, task > 0 ? 1 : 0)) + '░'.repeat(Math.max(0, width - u - Math.max(t, task > 0 ? 1 : 0))) + ']';
}
function renderStatus(acct, snap, proj) {
  const L = [`Dash · ${acct.key} (${acct.plan}${acct.tier ? ' / ' + acct.tier : ''})${acct.email ? ' · ' + acct.email : ''}`];
  for (const [name, label] of [['session', 'Session (5h)'], ['weekly', 'Weekly (7d)']]) {
    const p = proj[name];
    if (!p) { L.push(`${label}: no limit data for this plan`); continue; }
    const hit = p.limitAt ? `limit hit ~${fmtT(p.limitAt)} (in ${fmtIn(p.limitAt - snap.t)})` : 'no limit hit before reset';
    L.push(`${label}: ${bar(p.pct, 0)} ${p.pct}% used · burn ${p.rate.toFixed(1)}%/h (${p.basis}) · projected ${Math.min(999, p.projectedAtReset).toFixed(0)}% at reset · ${hit} · resets ${fmtT(p.reset)} (in ${fmtIn(p.reset - snap.t)})`);
  }
  if (snap.scoped?.some(s => s.pct)) L.push('Scoped weekly: ' + snap.scoped.map(s => `${s.model} ${s.pct}%`).join(', '));
  if (snap.breakdown?.length) L.push('Weekly by surface: ' + snap.breakdown.filter(b => b.pct).map(b => `${b.k} ${b.pct}%`).join(', '));
  return L.join('\n');
}

// ---------- args ----------
function parseArgs(argv) {
  const o = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) { const k = a.slice(2); const v = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : true; o[k] = v; } else o._.push(a);
  }
  return o;
}

// ---------- commands ----------
async function cmdPlan(acct, o, cfg) {
  const snap = await snapshot(acct);
  const hist = readJsonl(path.join(acctDir(acct), 'history.jsonl'));
  const proj = project(hist, snap);
  const cal = loadCal(acct);
  const size = String(o.size || 'M').toUpperCase();
  if (!cal.sizes[size]) throw new Error('--size must be one of ' + Object.keys(cal.sizes).join(','));
  const agents = Math.max(1, parseInt(o.agents || '1', 10));
  const s = proj.session, w = proj.weekly;
  if (!s || !w) return console.log(renderStatus(acct, snap, proj) + '\n(No limits on this plan; planning is advisory only.)');

  const sessFree = 100 - s.pct;
  const rows = [];
  for (const model of Object.keys(cal.model)) for (const effort of Object.keys(cal.effort)) {
    const e = estimate(cal, size, model, effort, agents);
    rows.push({ model, effort, session: e.session, weekly: e.weekly, fitsSession: s.pct + e.session <= 100, fitsWeek: w.projectedAtReset + e.weekly <= 100 });
  }
  const focus = rows.filter(r => ['low', 'medium', 'high', 'max'].includes(r.effort));
  if (o.json) return console.log(JSON.stringify({ account: acct.key, snap, proj: { session: { ...s, points: undefined }, weekly: { ...w, points: undefined } }, size, agents, options: rows }, null, 2));

  const L = [renderStatus(acct, snap, proj), '', `Task plan: size ${size}, ${agents} agent${agents > 1 ? 's' : ''}${o.desc ? ' · ' + o.desc : ''}`, '', 'Legend: █ used  ▒ task (fits)  ▓ task (overflows)  ░ free', ''];
  L.push('model   effort  session%  weekly%  session bar                                 verdict');
  for (const r of focus) {
    const verdict = r.fitsSession && r.fitsWeek ? 'fits' : !r.fitsSession ? `exceeds session by ${(s.pct + r.session - 100).toFixed(0)}% - wait for reset (${fmtIn(s.reset - snap.t)}) or downshift` : `weekly would project ${(w.projectedAtReset + r.weekly).toFixed(0)}% - tight`;
    L.push(`${r.model.padEnd(7)} ${r.effort.padEnd(7)} ${r.session.toFixed(1).padStart(7)}  ${r.weekly.toFixed(1).padStart(7)}  ${bar(s.pct, r.session, 30)}  ${verdict}`);
  }
  // recommendation: highest-ranked config that fits both windows with 20% headroom
  const heavy = size === 'L' || size === 'XL';
  const want = heavy ? [['opus', 'high'], ['sonnet', 'high'], ['sonnet', 'medium']] : size === 'M' ? [['sonnet', 'high'], ['sonnet', 'medium'], ['haiku', 'high']] : [['sonnet', 'medium'], ['haiku', 'medium'], ['haiku', 'low']];
  const pick = want.map(([m, e]) => rows.find(r => r.model === m && r.effort === e)).find(r => r && s.pct + r.session * 1.2 <= 100 && w.projectedAtReset + r.weekly * 1.2 <= 100) || [...focus].sort((a, b) => a.session - b.session)[0];
  L.push('', `Recommendation: ${pick.model} @ ${pick.effort}, ~${pick.session.toFixed(1)}% of session, ~${pick.weekly.toFixed(1)}% of week.`);
  if (agents > 1 || o.workflow) {
    // agents that fit: split remaining session budget (keeping 20% headroom) by per-agent cost of recommended config
    const per = estimate(cal, size, pick.model, pick.effort, 1).session;
    const budget = Math.max(0, sessFree * 0.8);
    const maxAgents = Math.max(1, Math.floor(budget / (per * (1 + AGENT_PARALLEL_OVERHEAD))));
    L.push(`Agents: ${maxAgents} fit this session at that config (per-agent ~${per.toFixed(1)}%). ${agents > maxAgents ? `Requested ${agents} would exceed it; use <= ${maxAgents}.` : 'Requested count fits.'}`);
  }
  console.log(L.join('\n'));
  fs.writeFileSync(path.join(acctDir(acct), 'pending.json'), JSON.stringify({ t: snap.t, size, agents, model: o.model, effort: o.effort, s0: s.pct, w0: w.pct, sReset: s.reset }));
  if (o.open) cmdOpen(acct, { plan: `${size},${agents}` }, cfg);
}

async function cmdDone(acct, o) {
  const pf = path.join(acctDir(acct), 'pending.json');
  const p = readJson(pf, null);
  if (!p) return console.log('No pending plan.');
  const model = String(o.model || p.model || 'sonnet'), effort = String(o.effort || p.effort || 'medium');
  const snap = await snapshot(acct);
  if (!snap.session || Date.parse(snap.session.reset) - Date.parse(p.sReset) > 120e3) return console.log('Session window rolled over during the task; skipping calibration.');
  const actual = snap.session.pct - p.s0;
  const cal = loadCal(acct);
  if (!cal.model[model] || !cal.effort[effort]) throw new Error(`unknown model/effort '${model}/${effort}'`);
  const est = estimate(cal, p.size, model, effort, p.agents).session;
  if (actual > 0 && est > 0) {
    // blend the observed/estimated ratio into the size base (EMA, alpha .3). Includes other sessions' noise, so keep alpha low.
    const ratio = actual / est;
    const next = { sizes: { ...cal.sizes, [p.size]: cal.sizes[p.size] * (1 + 0.3 * (ratio - 1)) } };
    const dw = snap.weekly.pct - p.w0;
    if (actual >= 1 && dw >= 0) next.weeklyPerSession = cal.weeklyPerSession * 0.7 + (dw / actual) * 0.3;
    const runs = [...cal.runs.slice(-49), { t: Date.now(), size: p.size, agents: p.agents, model, effort, est, actual, dw }];
    fs.writeFileSync(path.join(acctDir(acct), 'calibration.json'), JSON.stringify({ ...next, runs }, null, 1));
  }
  fs.unlinkSync(pf);
  console.log(`Task used ${actual.toFixed(1)}% of session (estimated ${est.toFixed(1)}%). ${actual > 0 && est > 0 ? 'Calibration updated.' : 'Nothing measurable; calibration unchanged.'}`);
}

// A Chromium browser gives the dashboard its own app window (--app). Falls back to the default browser.
function findBrowser(cfg) {
  if (cfg.browser) return fs.existsSync(expand(cfg.browser)) ? expand(cfg.browser) : null;
  const pf = process.env.ProgramFiles || 'C:/Program Files', pf86 = process.env['ProgramFiles(x86)'] || 'C:/Program Files (x86)';
  const cands = process.platform === 'win32'
    ? [`${pf}/Google/Chrome/Application/chrome.exe`, `${pf86}/Google/Chrome/Application/chrome.exe`, `${pf86}/Microsoft/Edge/Application/msedge.exe`, `${pf}/Microsoft/Edge/Application/msedge.exe`]
    : process.platform === 'darwin'
      ? ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge', '/Applications/Chromium.app/Contents/MacOS/Chromium']
      : ['/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/microsoft-edge'];
  return cands.find(p => fs.existsSync(p)) || null;
}
function openUrl(url) {
  const [cmd, args] = process.platform === 'win32' ? ['cmd', ['/c', 'start', '', url]] : process.platform === 'darwin' ? ['open', [url]] : ['xdg-open', [url]];
  spawn(cmd, args, { detached: true, stdio: 'ignore' }).unref();
}
function cmdOpen(acct, o, cfg) {
  const port = cfg.port;
  const url = `http://localhost:${port}/?account=${encodeURIComponent(acct.key)}${o.plan ? '&plan=' + o.plan : ''}`;
  const exe = o.app && findBrowser(cfg);
  const launch = () => exe
    ? spawn(exe, [`--app=${url}`, '--window-size=1180,900'], { detached: true, stdio: 'ignore' }).unref() // own window => own taskbar button
    : openUrl(url);
  const probe = http.get(`http://localhost:${port}/ping`, r => { r.resume(); launch(); console.log('Dash open: ' + url); });
  probe.on('error', () => {
    const args = [fileURLToPath(import.meta.url), 'serve', '--port', String(port)];
    if (cfg.file) args.push('--config', cfg.file);
    spawn(process.execPath, args, { detached: true, stdio: 'ignore' }).unref();
    setTimeout(launch, 700);
    console.log('Dash started: ' + url);
  });
}

async function cmdServe(o, cfg) {
  const port = parseInt(o.port || cfg.port, 10);
  let last = Date.now();
  const html = () => fs.readFileSync(path.join(HERE, 'dash.html'), 'utf8');
  const srv = http.createServer(async (req, res) => {
    last = Date.now();
    const u = new URL(req.url, 'http://x');
    try {
      if (u.pathname === '/ping') return res.end('ok');
      if (u.pathname === '/api/data') {
        const accounts = configuredAccounts(cfg).map(accountInfo);
        const acct = accounts.find(a => a.key === (u.searchParams.get('account') || '')) || resolveAccount(cfg);
        let snap = null, err = null;
        try { snap = await snapshot(acct); } catch (e) { err = e.message; }
        const hist = readJsonl(path.join(acctDir(acct), 'history.jsonl'));
        const cal = loadCal(acct);
        // compact history for the analytics: [t, session %, session reset, weekly %, weekly reset], last 42 days
        const since = Date.now() - 42 * 24 * HOUR;
        const history = hist.filter(h => h.t >= since).map(h => [h.t, h.session?.pct ?? null, h.session?.reset ? Date.parse(h.session.reset) : null, h.weekly?.pct ?? null, h.weekly?.reset ? Date.parse(h.weekly.reset) : null]);
        res.setHeader('content-type', 'application/json');
        return res.end(JSON.stringify({
          accounts: accounts.map(a => ({ key: a.key, plan: a.plan, email: a.email })), account: acct.key, plan: acct.plan, tier: acct.tier,
          snap, err, proj: snap ? project(hist, snap) : null, history, snapshots: hist.length, firstSnapshot: hist[0]?.t ?? null,
          cal: { sizes: cal.sizes, model: cal.model, effort: cal.effort, weeklyPerSession: cal.weeklyPerSession, runs: cal.runs }, now: Date.now(),
        }));
      }
      if (u.pathname === '/dash.png') { res.setHeader('content-type', 'image/png'); return res.end(fs.readFileSync(path.join(HERE, 'dash.png'))); }
      res.setHeader('content-type', 'text/html'); res.end(html());
    } catch (e) { res.statusCode = 500; res.end(String(e)); }
  });
  srv.listen(port, '127.0.0.1'); // local only: the page shows account e-mail addresses
  const idle = Math.max(1, Number(cfg.idleShutdownMinutes) || 30) * 60e3;
  setInterval(() => { if (Date.now() - last > idle) process.exit(0); }, 60e3);
}

function cmdInit(o) {
  const target = expand(typeof o.path === 'string' ? o.path : userConfigPath());
  if (fs.existsSync(target) && !o.force) return console.log(`Config already exists: ${target}  (use --force to overwrite)`);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const found = discoverDirs();
  const example = JSON.parse(fs.readFileSync(path.join(HERE, 'config.example.json'), 'utf8'));
  delete example._comment;
  example.accounts = found.length ? found.map(a => ({ key: a.key, dir: '~/' + path.relative(HOME, a.dir).replace(/\\/g, '/') })) : example.accounts;
  fs.writeFileSync(target, JSON.stringify(example, null, 2) + '\n');
  console.log(`Wrote ${target}` + (found.length ? ` with ${found.length} account(s) found: ${found.map(a => a.key).join(', ')}` : ''));
}

const HELP = `claude-dash <command> [--account <key|plan>] [--config <file>]
  status                          current usage, burn rate, projected limit hit, resets
  snapshot                        record a data point (run periodically for better projections)
  plan --size XS|S|M|L|XL [--agents N] [--desc "..."] [--json] [--open]
                                  cost options by model/effort + fit verdict + recommendation
  done [--model m --effort e]     after the task: measure actual cost, recalibrate
  open [--app]                    open the dashboard (--app: own browser window)
  accounts                        list known accounts
  init [--path <file>] [--force]  write a starter config (default: ${userConfigPath()})
  config                          show which config file and data dir are in use`;

const o = parseArgs(process.argv.slice(2));
const cmd = o._[0] || 'help';
try {
  const cfg = loadConfig(typeof o.config === 'string' ? o.config : null);
  DATA = cfg.dataDir;
  COST = { ...SEED, ...cfg.costModel, sizes: { ...SEED.sizes, ...cfg.costModel?.sizes }, model: { ...SEED.model, ...cfg.costModel?.model }, effort: { ...SEED.effort, ...cfg.costModel?.effort } };
  if (cmd === 'serve') await cmdServe(o, cfg);
  else if (cmd === 'help' || o.help) console.log(HELP);
  else if (cmd === 'init') cmdInit(o);
  else if (cmd === 'config') console.log(`config:   ${cfg.file || '(none, using defaults)'}\ndata dir: ${cfg.dataDir}\nport:     ${cfg.port}\naccounts: ${configuredAccounts(cfg).map(a => `${a.key} (${a.dir})`).join(', ') || '(none found)'}`);
  else if (cmd === 'accounts') configuredAccounts(cfg).forEach(d => { const a = accountInfo(d); console.log(`${a.key}\t${a.plan}\t${a.email || ''}`); });
  else {
    const acct = resolveAccount(cfg, o.account);
    if (cmd === 'snapshot') { const s = await snapshot(acct); console.log(`recorded ${acct.key}: session ${s.session?.pct}% weekly ${s.weekly?.pct}%`); }
    else if (cmd === 'status') { const s = await snapshot(acct); const h = readJsonl(path.join(acctDir(acct), 'history.jsonl')); console.log(renderStatus(acct, s, project(h, s))); }
    else if (cmd === 'plan') await cmdPlan(acct, o, cfg);
    else if (cmd === 'done') await cmdDone(acct, o);
    else if (cmd === 'open') cmdOpen(acct, { app: o.app }, cfg);
    else console.log(HELP);
  }
} catch (e) { console.error('dash: ' + e.message); process.exitCode = 1; }
