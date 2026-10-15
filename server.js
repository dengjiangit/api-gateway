#!/usr/bin/env node
// 本地多账号 · 多平台 LLM 网关（含 WebUI 管理页）
// - 任意 OpenAI 兼容平台（SenseNova / ModelScope / DashScope / DeepSeek / Moonshot / SiliconFlow ...）
// - 多账号粘性/轮询 + 429/超时/5xx 立即切换 + 冷却 + 跨平台模型回退 + 模型别名
// - WebUI 管理页（/ 或 /admin/ui）：可视化管理 providers / accounts / 规则 / 测试 / 日志
// - 纯 Node >= 20 零依赖（内置 fetch / Readable.fromWeb / AbortController）

const http = require('node:http');
const { Readable } = require('node:stream');
const fs = require('node:fs');
const path = require('node:path');

// ============== 配置加载 ==============
function parseConfigPath() {
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--config' && argv[i + 1]) return argv[i + 1];
    if (argv[i].startsWith('--config=')) return argv[i].slice('--config='.length);
  }
  return process.env.GATEWAY_CONFIG || path.join(process.cwd(), 'config.json');
}

function loadConfig(cfgPath) {
  const raw = fs.readFileSync(cfgPath, 'utf8');
  const cfg = JSON.parse(raw);
  cfg.port = cfg.port ?? 8080;
  cfg.host = cfg.host ?? '127.0.0.1';
  cfg.rotation = cfg.rotation || 'on_failure';
  cfg.failover_on = cfg.failover_on || ['rate_limit', 'timeout', 'server_error'];
  cfg.cooldown_ms = cfg.cooldown_ms ?? 30000;
  cfg.request_timeout_ms = cfg.request_timeout_ms ?? 120000;
  cfg.max_attempts = cfg.max_attempts ?? 10;
  cfg.model_fallback = cfg.model_fallback || {};
  cfg.model_alias = cfg.model_alias || {};
  cfg.persist_stats = cfg.persist_stats || false;
  cfg.health_check = cfg.health_check || false;
  // 全局模型优先级列表：非空时忽略请求中的 model 字段，永远从列表第 0 个开始依次尝试
  cfg.model_order = Array.isArray(cfg.model_order) ? cfg.model_order : [];
  // 分层路由：[[entry,...], ...]，层间串行降级，层内按 weight 加权分摊。非空时优先于 model_order
  cfg.model_routes = Array.isArray(cfg.model_routes) ? cfg.model_routes : [];
  // 健康度感知：成功率低的账号/模型自动降权，恢复后回升
  cfg.health_aware = cfg.health_aware !== false;
  if (cfg.health_check === true) cfg.health_check = { enabled: true, interval_ms: 60000, path: '/v1/models', timeout_ms: 10000 };
  if (!Array.isArray(cfg.accounts) || cfg.accounts.length === 0) {
    throw new Error('config.accounts 必须是非空数组');
  }

  // ---- 多平台 providers + 向后兼容 ----
  const providers = {};
  if (Array.isArray(cfg.providers) && cfg.providers.length > 0) {
    for (const p of cfg.providers) {
      if (!p.name) throw new Error('providers[] 缺少 name');
      if (!p.base_url) throw new Error(`providers[${p.name}] 缺少 base_url`);
      // 平台级模型列表：元素可以是 "model" 或 {name, priority, weight}
      // 同一平台下账号通常开通的模型一致，写一次即可；模型级 priority/weight 在选号时覆盖账号默认值
      const modelList = [];
      const modelPrefs = {};
      if (Array.isArray(p.models)) {
        for (const m of p.models) {
          if (typeof m === 'string') {
            if (!modelPrefs[m]) modelPrefs[m] = {};
            modelList.push(m);
          } else if (m && typeof m.name === 'string') {
            if (!modelPrefs[m.name]) modelPrefs[m.name] = {};
            if (typeof m.priority === 'number') modelPrefs[m.name].priority = m.priority;
            if (typeof m.weight === 'number' && m.weight > 0) modelPrefs[m.name].weight = m.weight;
            modelList.push(m.name);
          }
        }
      }
      providers[p.name] = {
        name: p.name,
        base_url: String(p.base_url).replace(/\/+$/, ''),
        auth_style: p.auth_style || 'bearer_header',
        models: modelList,
        model_prefs: modelPrefs,
      };
    }
  } else if (cfg.upstream) {
    providers['default'] = {
      name: 'default',
      base_url: String(cfg.upstream).replace(/\/+$/, ''),
      auth_style: 'bearer_header',
      models: [],
      model_prefs: {},
    };
    console.log('[config] 未声明 providers，基于顶层 upstream 自动建 "default" provider（向后兼容）');
  } else {
    throw new Error('config 必须有 providers 数组或顶层 upstream 字段');
  }
  cfg.providers = providers;

  cfg.accounts.forEach((a, i) => {
    if (!a.name) a.name = `account-${i + 1}`;
    if (!a.api_key) throw new Error(`accounts[${i}] 缺少 api_key`);
    const pname = a.provider || 'default';
    const provider = providers[pname];
    if (!provider) {
      throw new Error(`accounts[${i}] (${a.name}) 引用了未定义的 provider "${pname}"；已知: ${Object.keys(providers).join(', ')}`);
    }
    a._provider = provider;
    // 模型可省略：继承所属平台的模型列表
    if (!Array.isArray(a.models) || a.models.length === 0) {
      if (provider.models.length === 0) {
        throw new Error(`accounts[${i}] (${a.name}) 未列 models，且其 provider "${pname}" 也没有 models —— 至少一处要声明`);
      }
      a.models = provider.models.slice();
    }
    // 选号参数：weight=加权分布权重（默认1，越大分到越多流量）；priority=排名（默认100，越小越优先，on_failure 粘性时优先用）
    a.weight = (typeof a.weight === 'number' && a.weight > 0) ? a.weight : 1;
    a.priority = (typeof a.priority === 'number') ? a.priority : 100;
  });
  cfg._config_dir = path.dirname(cfgPath);
  cfg.request_log_file = cfg.request_log_file || '';
  cfg.default_model = cfg.default_model || '';
  return cfg;
}

// ============== 模型池 / 状态 / 请求日志 ==============
let config;
let modelPools = new Map();
let cursors = Object.create(null);
let stats = Object.create(null);
const requestLog = [];           // 环形缓冲，最多 200 条
const REQUEST_LOG_MAX = 200;

function pushLog(entry) {
  entry.ts = new Date().toISOString();
  requestLog.push(entry);
  if (requestLog.length > REQUEST_LOG_MAX) requestLog.shift();
  // 可选：把每条路由结果追加写到 JSONL 文件（相对 config 目录解析）
  if (config && config.request_log_file) {
    try {
      const fp = path.isAbsolute(config.request_log_file)
        ? config.request_log_file
        : path.resolve(config._config_dir || process.cwd(), config.request_log_file);
      fs.appendFileSync(fp, JSON.stringify(entry) + '\n');
    } catch { /* 写日志失败不影响主流程 */ }
  }
}

function buildPools() {
  const pools = new Map();
  config.accounts.forEach((acc, idx) => {
    acc.models.forEach((m) => {
      if (!pools.has(m)) pools.set(m, []);
      pools.get(m).push({ idx, name: acc.name, provider: acc._provider.name, weight: acc.weight, priority: acc.priority });
    });
  });
  return pools;
}
function clampCursors() {
  for (const m of modelPools.keys()) {
    const n = modelPools.get(m).length;
    cursors[m] = (((cursors[m] || 0) % n) + n) % n;
  }
}
function initStats() {
  // 每次 reload 都重置（不要 if(!stats[name]) 跳过），否则热加载时 loadPersistedStats 会把落盘计数叠加到内存计数上导致翻倍
  for (const acc of config.accounts) {
    stats[acc.name] = {
      provider: acc._provider.name,
      requests: 0, rate_limits: 0, timeouts: 0, server_errors: 0, network_errors: 0,
      last_error: null, last_error_at: null, last_used_at: null, cooldown_until: 0,
      health: 'unknown', last_check_at: null, last_check_error: null,
    };
  }
}
function reload() {
  const cfgPath = parseConfigPath();
  config = loadConfig(cfgPath);
  modelPools = buildPools();
  clampCursors();
  initStats();
  loadPersistedStats();
  log('config reloaded from', cfgPath, '| providers:', Object.keys(config.providers).length,
      '| accounts:', config.accounts.length, '| models:', modelPools.size);
}

// ============== 选账号 ==============
function pickFromCandidates(cands, model) {
  if (!cands || cands.length === 0) return null;
  const now = Date.now();
  // 可用 = 未冷却 且 未被探活标记 dead
  const avail = cands.filter((p) => {
    const s = stats[p.name];
    if (!s) return true;
    if (s.cooldown_until && s.cooldown_until > now) return false; // 冷却中
    if (s.health === 'dead') return false;                         // 探活已标记死亡
    return true;
  });
  const list = avail.length ? avail : cands; // 全冷却/全 dead 时退化全池兜底，仍尝试
  // 生效 priority/weight：平台对该模型的设置（provider.models 里的 {name,priority,weight}）覆盖账号默认值
  const eff = (p) => {
    const prov = config.providers[p.provider];
    const mp = prov && prov.model_prefs && prov.model_prefs[model];
    const hf = config.health_aware ? healthOf(p.name) : 1; // 健康度感知降权
    return {
      p: (mp && typeof mp.priority === 'number') ? mp.priority : (p.priority || 100),
      w: ((mp && typeof mp.weight === 'number') ? mp.weight : (p.weight || 1)) * hf,
    };
  };
  let chosen;
  if (config.rotation === 'every_request') {
    chosen = weightedPick(list, eff); // 按 weight 加权随机分布（默认权重1=均匀）
  } else {
    // on_failure（默认粘性）：排名优先（priority 小者先），平级按 weight 大者先；可用则持续粘住，挂了自动降级到下一个最优账号
    chosen = [...list].sort((a, b) => {
      const ea = eff(a), eb = eff(b);
      return (ea.p - eb.p) || (eb.w - ea.w);
    })[0];
  }
  return { idx: chosen.idx, name: chosen.name, provider: chosen.provider, account: config.accounts[chosen.idx] };
}
function pickAccount(model) {
  return pickFromCandidates(modelPools.get(model), model);
}

// ============== 分层路由（层间串行降级，层内按权重分摊） ==============
function normalizeEntry(e) {
  if (typeof e === 'string') return { model: e, provider: null, weight: 1 };
  if (!e || typeof e.model !== 'string' || !e.model) return null;
  return {
    model: e.model,
    provider: (typeof e.provider === 'string' && e.provider) ? e.provider : null,
    weight: (typeof e.weight === 'number' && e.weight > 0) ? e.weight : 1,
  };
}
// 条目 → 候选账号（provider 为空 = 不限平台，沿用合并池）
function entryCandidates(entry) {
  const pool = modelPools.get(entry.model) || [];
  if (!entry.provider) return pool;
  return pool.filter((c) => c.provider === entry.provider);
}
// 从一层里按权重挑一个条目；tried 排除本请求已试过的 "模型|账号下标"
function pickTierEntry(tier, tried) {
  const avail = [];
  for (const entry of tier) {
    const cands = entryCandidates(entry).filter((c) => !tried.has(entry.model + '|' + c.idx));
    if (!cands.length) continue;
    let hs = 1;
    if (config.health_aware) hs = cands.reduce((m, c) => Math.max(m, healthOf(c.name)), 0.05);
    avail.push({ entry, cands, w: entry.weight * hs });
  }
  if (!avail.length) return null;
  const total = avail.reduce((s, x) => s + x.w, 0);
  if (total <= 0) return avail[0];
  let r = Math.random() * total;
  for (const x of avail) { r -= x.w; if (r <= 0) return x; }
  return avail[avail.length - 1];
}
// 统一成层的表示：[[entry...], ...]
function buildTiers(chain, reqProvider) {
  if (config.model_routes.length) {
    const tiers = [];
    for (const t of config.model_routes) {
      const list = (Array.isArray(t) ? t : [t]).map(normalizeEntry).filter(Boolean);
      if (list.length) tiers.push(list);
    }
    if (tiers.length) return tiers;
  }
  // 兼容：model_order / 旧链路 → 每个模型独占一层（等价于原有串行降级）
  // reqProvider 非空时，把同模型限定在指定平台（测试模块按平台选模型 / 客户端显式指定 provider）
  return chain.filter((m) => typeof m === 'string' && modelPools.has(m))
    .map((m) => [{ model: m, provider: reqProvider || null, weight: 1 }]);
}
function weightedPick(list, eff) {
  const ws = list.map((p) => eff(p).w);
  const total = ws.reduce((s, w) => s + w, 0);
  let r = Math.random() * total;
  for (let i = 0; i < list.length; i++) {
    r -= ws[i];
    if (r <= 0) return list[i];
  }
  return list[list.length - 1];
}
function advanceCursorOnFailover(model) {
  const pool = modelPools.get(model);
  if (!pool) return;
  cursors[model] = ((cursors[model] || 0) + 1) % pool.length;
}

function markCooldown(name, reason) {
  const s = stats[name] || (stats[name] = {});
  s.cooldown_until = Date.now() + config.cooldown_ms;
  s.last_error = reason;
  s.last_error_at = new Date().toISOString();
  if (reason === 'rate_limit') s.rate_limits++;
  else if (reason === 'timeout') s.timeouts++;
  else if (reason === 'server_error') s.server_errors++;
  else if (reason === 'network_error') s.network_errors++;
  s.hs = (typeof s.hs === 'number') ? s.hs * 0.9 : 0.9; // 健康度 EWMA（失败→0）
}
function noteSuccess(name) {
  const s = stats[name] || (stats[name] = {});
  s.requests = (s.requests || 0) + 1;
  s.last_used_at = new Date().toISOString();
  s.hs = (typeof s.hs === 'number') ? s.hs * 0.9 + 0.1 : 1; // 健康度 EWMA（成功→1）
}
// 健康度系数（0.05~1），health_aware 关闭时恒为 1
function healthOf(name) {
  const s = stats[name];
  if (!s || typeof s.hs !== 'number') return 1;
  return Math.max(0.05, Math.min(1, s.hs));
}

// ============== 统计持久化（persist_stats 开关控制） ==============
function statsFilePath() { return parseConfigPath() + '.stats.json'; }
function persistStats() {
  if (!config.persist_stats) return;
  try {
    const data = { stats, requestLog, saved_at: new Date().toISOString() };
    const p = statsFilePath();
    fs.writeFileSync(p + '.tmp', JSON.stringify(data), 'utf8');
    fs.renameSync(p + '.tmp', p);
  } catch (e) {
    log('persist_stats write failed:', e.message);
  }
}
function loadPersistedStats() {
  if (!config.persist_stats) return;
  try {
    const p = statsFilePath();
    if (!fs.existsSync(p)) return;
    const d = JSON.parse(fs.readFileSync(p, 'utf8'));
    if (d.stats) {
      for (const [name, prev] of Object.entries(d.stats)) {
        if (stats[name]) {
          stats[name].requests += prev.requests || 0;
          stats[name].rate_limits += prev.rate_limits || 0;
          stats[name].timeouts += prev.timeouts || 0;
          stats[name].server_errors += prev.server_errors || 0;
          stats[name].network_errors += prev.network_errors || 0;
          if (prev.last_error) { stats[name].last_error = prev.last_error; stats[name].last_error_at = prev.last_error_at; }
          if (prev.last_used_at && (!stats[name].last_used_at || prev.last_used_at > stats[name].last_used_at)) stats[name].last_used_at = prev.last_used_at;
          stats[name].health = 'unknown'; // 重启后重新探活
        }
      }
    }
    if (Array.isArray(d.requestLog)) {
      for (const e of d.requestLog) requestLog.push(e);
      if (requestLog.length > REQUEST_LOG_MAX) requestLog.splice(0, requestLog.length - REQUEST_LOG_MAX);
    }
    log('persisted stats loaded from', p);
  } catch (e) {
    log('load persisted stats failed:', e.message);
  }
}

// ============== 上游探活（health_check 开关控制） ==============
let lastHealthCheckAt = 0;
async function runHealthCheck() {
  const hc = config.health_check;
  if (!hc || !hc.enabled) return;
  const pathP = hc.path || '/v1/models';
  const timeoutMs = hc.timeout_ms || 10000;
  for (const acc of config.accounts) {
    const provider = acc._provider;
    const url = provider.base_url + pathP;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    let ok = false, err = null;
    try {
      const r = await fetch(url, { method: 'GET', headers: { 'Authorization': 'Bearer ' + acc.api_key }, signal: ctrl.signal });
      if (r.ok) ok = true; else { err = 'HTTP ' + r.status; try { await r.text(); } catch {} }
    } catch (e) {
      err = String((e && e.message) || e);
    } finally {
      clearTimeout(timer);
    }
    const s = stats[acc.name] || (stats[acc.name] = {});
    s.health = ok ? 'ok' : 'dead';
    s.last_check_at = new Date().toISOString();
    s.last_check_error = ok ? null : err;
    log(`health-check  ${provider.name}/${acc.name} -> ${ok ? 'OK' : 'DEAD (' + err + ')'}`);
  }
}
// 后台任务：每 15s 检查一次开关，按各开关节奏执行
function startBackgroundTasks() {
  let lastPersist = 0;
  setInterval(() => {
    const now = Date.now();
    if (config.persist_stats && now - lastPersist >= 15000) { lastPersist = now; persistStats(); }
    if (config.health_check && config.health_check.enabled) {
      const interval = config.health_check.interval_ms || 60000;
      if (now - lastHealthCheckAt >= interval) { lastHealthCheckAt = now; runHealthCheck(); }
    }
  }, 15000);
}

// ============== 带超时的 fetch 辅助 ==============
async function fetchWithTimeout(url, opts = {}, timeoutMs = 15000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    return await fetch(url, { ...opts, signal: ctrl.signal });
  } finally {
    clearTimeout(timer);
  }
}

// ============== /admin/fetch-models（拉取平台模型列表） ==============
// body: { base_url, api_key?, path?, timeout_ms? }
async function handleFetchModels(req, res) {
  let body = {};
  try {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const text = Buffer.concat(chunks).toString('utf8');
    if (text) body = JSON.parse(text);
  } catch { /* ignore */ }
  const baseUrl = String(body.base_url || '').replace(/\/+$/, '');
  const apiKey = body.api_key || '';
  const pathP = (body.path && String(body.path).startsWith('/')) ? body.path : '/v1/models';
  const timeoutMs = Number(body.timeout_ms) || 15000;
  if (!baseUrl) {
    res.statusCode = 400; res.setHeader('Content-Type', 'application/json');
    return res.end(JSON.stringify({ ok: false, error: { type: 'bad_request', message: '缺少 base_url' } }));
  }
  let r;
  try {
    r = await fetchWithTimeout(baseUrl + pathP, {
      method: 'GET',
      headers: apiKey ? { 'Authorization': 'Bearer ' + apiKey } : {},
    }, timeoutMs);
  } catch (e) {
    const reason = (e && e.name === 'AbortError') ? 'timeout' : 'network_error';
    res.statusCode = 200; res.setHeader('Content-Type', 'application/json');
    return res.end(JSON.stringify({ ok: false, stage: 'connect', reason, message: String((e && e.message) || e) }));
  }
  const txt = await r.text();
  if (!r.ok) {
    res.statusCode = 200; res.setHeader('Content-Type', 'application/json');
    return res.end(JSON.stringify({ ok: false, stage: 'http', status: r.status, message: txt.slice(0, 500) }));
  }
  let j = null;
  try { j = JSON.parse(txt); } catch { /* ignore */ }
  const ids = (j && Array.isArray(j.data)) ? j.data.map((m) => m.id || m.name).filter(Boolean) : [];
  res.statusCode = 200; res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify({ ok: true, count: ids.length, models: ids }));
}

// ============== /admin/verify-account（验证账号 key 有效 + 模型可调用） ==============
// body: { base_url, api_key, models?: string[], chat?: bool, timeout_ms? }
async function handleVerifyAccount(req, res) {
  let body = {};
  try {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const text = Buffer.concat(chunks).toString('utf8');
    if (text) body = JSON.parse(text);
  } catch { /* ignore */ }
  const baseUrl = String(body.base_url || '').replace(/\/+$/, '');
  const apiKey = body.api_key || '';
  const timeoutMs = Number(body.timeout_ms) || 20000;
  const doChat = body.chat === true;
  if (!baseUrl) {
    res.statusCode = 400; res.setHeader('Content-Type', 'application/json');
    return res.end(JSON.stringify({ ok: false, error: { type: 'bad_request', message: '缺少 base_url' } }));
  }
  // 1) 鉴权 + 拿到可用模型列表
  let r, txt, ids = [];
  try {
    r = await fetchWithTimeout(baseUrl + '/v1/models', {
      method: 'GET',
      headers: apiKey ? { 'Authorization': 'Bearer ' + apiKey } : {},
    }, timeoutMs);
  } catch (e) {
    const reason = (e && e.name === 'AbortError') ? 'timeout' : 'network_error';
    res.statusCode = 200; res.setHeader('Content-Type', 'application/json');
    return res.end(JSON.stringify({ ok: false, stage: 'connect', reason, message: String((e && e.message) || e) }));
  }
  txt = await r.text();
  if (!r.ok) {
    res.statusCode = 200; res.setHeader('Content-Type', 'application/json');
    return res.end(JSON.stringify({ ok: false, stage: 'auth', status: r.status, message: txt.slice(0, 500) }));
  }
  try { const j = JSON.parse(txt); if (j && Array.isArray(j.data)) ids = j.data.map((m) => m.id || m.name).filter(Boolean); } catch { /* ignore */ }
  // 2) 交叉核对账号里填写的模型是否都在可用列表
  const listed = Array.isArray(body.models) ? body.models.filter(Boolean) : [];
  const missing = listed.filter((m) => !ids.includes(m));
  // 3) 可选：真实发一次最小 chat 调用，确认模型真的能调通
  let chatOk = null, chatModel = null, chatMessage = null;
  if (doChat) {
    const testModel = listed[0] || ids[0];
    if (testModel) {
      chatModel = testModel;
      try {
        const cr = await fetchWithTimeout(baseUrl + '/v1/chat/completions', {
          method: 'POST',
          headers: Object.assign({ 'Content-Type': 'application/json' }, apiKey ? { 'Authorization': 'Bearer ' + apiKey } : {}),
          body: JSON.stringify({ model: testModel, messages: [{ role: 'user', content: 'hi' }], max_tokens: 5, stream: false }),
        }, timeoutMs);
        const ctxt = await cr.text();
        if (cr.ok) chatOk = true;
        else { chatOk = false; chatMessage = ctxt.slice(0, 500); }
      } catch (e) {
        chatOk = false;
        chatMessage = String((e && e.message) || e) + ((e && e.name === 'AbortError') ? ' (timeout)' : '');
      }
    } else {
      chatMessage = '该平台 /v1/models 未返回任何可用模型';
    }
  }
  res.statusCode = 200; res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify({
    ok: true,
    available_count: ids.length,
    missing_models: missing,
    chat_ok: chatOk,
    chat_model: chatModel,
    chat_message: chatMessage,
  }));
}

function log(...a) { console.log('[' + new Date().toISOString() + ']', ...a); }

// ============== 改写 body 中的 model 字段 ==============
function setModelInBody(bodyText, newModel) {
  const re = /("model"\s*:\s*)"[^"]*"/;
  if (re.test(bodyText)) return bodyText.replace(re, `$1${JSON.stringify(newModel)}`);
  return bodyText;
}

// ============== 回写上游响应 ==============
async function sendUpstream(res, upstreamRes, accountName, providerName, ctrl, opts = {}) {
  res.statusCode = upstreamRes.status;
  const skip = new Set(['content-encoding', 'content-length', 'transfer-encoding', 'connection']);
  for (const [k, v] of upstreamRes.headers) {
    if (skip.has(k.toLowerCase())) continue;
    res.setHeader(k, v);
  }
  res.setHeader('x-gateway-account', encodeURIComponent(accountName));
  res.setHeader('x-gateway-provider', encodeURIComponent(providerName));
  if (!upstreamRes.body) { res.end(); return null; }
  // 手动泵送 web ReadableStream -> ServerResponse（比 Readable.fromWeb().pipe() 更稳，避免某些 Node 版本下流不结束导致客户端一直挂起）
  const reader = upstreamRes.body.getReader();
  res.on('close', () => {
    try { ctrl && ctrl.abort(); } catch {}
    try { reader.cancel().catch(() => {}); } catch {}
  });
  // 非流式：整包缓冲后返回（供解析 finish_reason / token 用量），再一次性回写客户端
  if (opts.buffer) {
    const chunks = [];
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value && value.length) chunks.push(Buffer.from(value));
      }
    } catch { /* 读取中断则按已收到的内容回写 */ }
    const body = Buffer.concat(chunks);
    if (!res.writableEnded) res.end(body);
    return body;
  }
  // 流式：边转发边扫描 finish_reason（不缓冲，避免破坏 SSE 实时性）
  const cap = opts.scan || null;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value && value.length) {
        if (cap) {
          const m = Buffer.from(value).toString('utf8').match(/"finish_reason"\s*:\s*"([\w-]+)"/g);
          if (m && m.length) {
            const v = m[m.length - 1].match(/"finish_reason"\s*:\s*"([\w-]+)"/);
            if (v && v[1] && v[1] !== 'null') cap.finish_reason = v[1];
          }
        }
        if (!res.write(value)) await new Promise((r) => res.once('drain', r));
      }
    }
    if (!res.writableEnded) res.end();
  } catch (e) {
    try { if (!res.writableEnded) res.destroy(); } catch {}
  }
  return null;
}

// 成功响应：转发 + 记录 finish_reason / token 用量（用于观测输出是否被截断）
async function completeOk(res, upstreamRes, pick, ctrl, ctx) {
  const cap = { finish_reason: null, completion_tokens: null, prompt_tokens: null, reasoning_tokens: null };
  if (!ctx.isStream) {
    const body = await sendUpstream(res, upstreamRes, pick.name, pick.provider, ctrl, { buffer: true });
    if (body && body.length) {
      try {
        const j = JSON.parse(body.toString('utf8'));
        const ch = j && j.choices && j.choices[0];
        if (ch && typeof ch.finish_reason === 'string') cap.finish_reason = ch.finish_reason;
        const u = j && j.usage;
        if (u) {
          if (typeof u.completion_tokens === 'number') cap.completion_tokens = u.completion_tokens;
          if (typeof u.prompt_tokens === 'number') cap.prompt_tokens = u.prompt_tokens;
          const rd = u.completion_tokens_details;
          if (rd && typeof rd.reasoning_tokens === 'number') cap.reasoning_tokens = rd.reasoning_tokens;
        }
      } catch { /* 非 JSON 响应则忽略 */ }
    }
  } else {
    await sendUpstream(res, upstreamRes, pick.name, pick.provider, ctrl, { scan: cap });
  }
  const truncated = cap.finish_reason === 'length';
  pushLog({
    client_model: ctx.requestedModel, model: ctx.modelName, provider: pick.provider, account: pick.name,
    status: ctx.status, latency_ms: Date.now() - ctx.reqStart, attempts: ctx.totalAttempts,
    outcome: ctx.status >= 400 ? 'passthrough' : 'ok', tier: ctx.ti + 1,
    finish_reason: cap.finish_reason,
    completion_tokens: cap.completion_tokens,
    prompt_tokens: cap.prompt_tokens,
    reasoning_tokens: cap.reasoning_tokens,
    truncated,
  });
  if (truncated) {
    log(`  !! 输出被截断 finish_reason=length  model=${ctx.modelName}  completion=${cap.completion_tokens}  reasoning=${cap.reasoning_tokens}  on ${pick.provider}/${pick.name}`);
  }
}

// ============== 代理核心 ==============
async function handleProxy(req, res, bodyText) {
  let requestedModel = null;
  let isStream = false;
  let reqProvider = null; // 客户端指定只走某平台（测试模块按平台选模型时用）；为空=按模型自动路由
  try {
    const j = JSON.parse(bodyText);
    if (j && typeof j.model === 'string') requestedModel = j.model;
    if (j && j.stream === true) isStream = true;
    if (j && typeof j.provider === 'string' && j.provider) reqProvider = j.provider;
  } catch { /* 非 JSON 也照常转发 */ }
  if (!reqProvider && req.headers['x-gateway-provider']) {
    const h = String(req.headers['x-gateway-provider']);
    if (h) reqProvider = decodeURIComponent(h);
  }

  // 全局模型优先级列表 model_order：若存在且非空，则忽略请求中的 model 字段，
  // 永远从列表第 0 个开始依次尝试（跨平台回退由列表顺序决定）。
  let chain, effectiveModel = requestedModel;
  if (config.model_order.length) {
    chain = config.model_order.slice();
    effectiveModel = chain[0] || requestedModel;
    log(`model_order 模式：忽略请求模型=${requestedModel || '(空)'}，按全局列表顺序尝试：${chain.join(' -> ')}`);
  } else {
    // 旧逻辑（兼容）：模型别名 → default_model → 该模型的 model_fallback 链
    if (requestedModel && config.model_alias[requestedModel]) {
      effectiveModel = config.model_alias[requestedModel];
      log(`alias: ${requestedModel} -> ${effectiveModel}`);
    }
    if (config.default_model && (!effectiveModel || !modelPools.has(effectiveModel) || modelPools.get(effectiveModel).length === 0)) {
      log(`default_model: ${effectiveModel || '(缺失)'} -> ${config.default_model}`);
      effectiveModel = config.default_model;
    }
    chain = [];
    if (effectiveModel) chain.push(effectiveModel);
    const fb = (config.model_fallback && config.model_fallback[effectiveModel]) || [];
    for (const m of fb) if (!chain.includes(m)) chain.push(m);
  }

  if (chain.length === 0) {
    res.statusCode = 400; res.setHeader('Content-Type', 'application/json');
    return res.end(JSON.stringify({
      error: {
        type: 'bad_request',
        message: '缺少或未知的 "model" 字段',
        hint: '可用模型: ' + Array.from(modelPools.keys()).join(', ') + '；或配置 default_model 让未知模型自动路由',
      },
    }));
  }

  const triggers = new Set(config.failover_on);
  let totalAttempts = 0;
  let lastError = null;
  const reqStart = Date.now();

  const tiers = buildTiers(chain, reqProvider);
  for (let ti = 0; ti < tiers.length; ti++) {
    const tier = tiers[ti];
    const tried = new Set(); // 本层内已试过的 "模型|账号下标"
    for (;;) {
      if (totalAttempts >= config.max_attempts) { log('max_attempts reached, stop'); break; }
      const sel = pickTierEntry(tier, tried);
      if (!sel) break;                                   // 本层穷尽 → 降级到下一层
      const pick = pickFromCandidates(sel.cands, sel.entry.model);
      if (!pick) break;
      tried.add(sel.entry.model + '|' + pick.idx);
      const modelName = sel.entry.model;

      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), config.request_timeout_ms);
      const payload = setModelInBody(bodyText, modelName);
      const url = pick.account._provider.base_url + req.url;
      totalAttempts++;
      const t0 = Date.now();
      log(`attempt #${totalAttempts}  tier=${ti + 1}/${tiers.length}  provider=${pick.provider}  model=${modelName}  account=${pick.name}  url=${url}`);

      let upstreamRes;
      try {
        upstreamRes = await fetch(url, {
          method: 'POST',
          headers: {
            'Authorization': 'Bearer ' + pick.account.api_key,
            'Content-Type': 'application/json',
          },
          body: payload,
          signal: ctrl.signal,
        });
      } catch (err) {
        clearTimeout(timer);
        const isAbort = err && (err.name === 'AbortError' || err.name === 'TimeoutError');
        const reason = isAbort ? 'timeout' : 'network_error';
        markCooldown(pick.name, reason);
        lastError = { reason, account: pick.name, provider: pick.provider, model: modelName, message: String((err && err.message) || err) };
        log(`  -> ${reason} (${Date.now() - t0}ms) on ${pick.provider}/${pick.name} for ${modelName}  ->  SWITCH`);
        continue;
      }
      clearTimeout(timer);

      const status = upstreamRes.status;
      if (status === 429 && triggers.has('rate_limit')) {
        markCooldown(pick.name, 'rate_limit');
        try { await upstreamRes.text(); } catch {}
        lastError = { reason: 'rate_limit', status, account: pick.name, provider: pick.provider, model: modelName };
        log(`  -> 429 (${Date.now() - t0}ms) on ${pick.provider}/${pick.name} for ${modelName}  ->  SWITCH`);
        continue;
      }
      if (status >= 500 && status < 600 && triggers.has('server_error')) {
        markCooldown(pick.name, 'server_error');
        try { await upstreamRes.text(); } catch {}
        lastError = { reason: 'server_error', status, account: pick.name, provider: pick.provider, model: modelName };
        log(`  -> ${status} (${Date.now() - t0}ms) on ${pick.provider}/${pick.name} for ${modelName}  ->  SWITCH`);
        continue;
      }
      // 上游 404 = 该平台没有这个模型（model_not_found）：切换到下一候选，而不是当成功原样转发给客户端
      if (status === 404) {
        try { await upstreamRes.text(); } catch {}
        lastError = { reason: 'not_found', status, account: pick.name, provider: pick.provider, model: modelName };
        log(`  -> 404 model_not_found (${Date.now() - t0}ms) on ${pick.provider}/${pick.name} for ${modelName}  ->  SWITCH`);
        continue;
      }

      // 上游 4xx（以及未启用切换的 5xx）：
      // - 内容审核拒绝（data_inspection_failed）：failover_on 含 "content_blocked" 时自动换下一个候选
      //   （同模型的其他平台账号 → 下一层回退模型），利用各平台审核尺度差异；审核拒绝不是账号故障，不进冷却。
      // - 其余原样透传给客户端（内容/参数问题，切了也没用），日志记 passthrough 而不是 ok。
      if (status >= 400) {
        let errBody = '';
        try { errBody = await upstreamRes.text(); } catch {}
        const blocked = /data_inspection_failed|inappropriate content/i.test(errBody);
        if (blocked && triggers.has('content_blocked')) {
          lastError = { reason: 'content_blocked', status, account: pick.name, provider: pick.provider, model: modelName };
          log(`  -> ${status} content_blocked (${Date.now() - t0}ms) on ${pick.provider}/${pick.name} for ${modelName}  ->  SWITCH`);
          continue;
        }
        res.statusCode = status;
        const ct = upstreamRes.headers && upstreamRes.headers.get && upstreamRes.headers.get('content-type');
        res.setHeader('Content-Type', ct || 'application/json');
        if (blocked) {
          res.setHeader('x-gateway-note', 'upstream-content-blocked');
          try {
            const j = JSON.parse(errBody);
            j.hint = '上游内容审核拦截（DataInspectionFailed），非网关/账号故障；可改写内容重试，或在 failover_on 加 "content_blocked" 让网关自动换平台。';
            errBody = JSON.stringify(j);
          } catch { /* 非 JSON 错误体则原样透传 */ }
        }
        log(`  -> ${status} passthrough${blocked ? ' (content_blocked, 未启用切换)' : ''} (${Date.now() - t0}ms) on ${pick.provider}/${pick.name} for ${modelName}`);
        pushLog({
          client_model: requestedModel, model: modelName, provider: pick.provider, account: pick.name,
          status, latency_ms: Date.now() - reqStart, attempts: totalAttempts,
          outcome: 'passthrough', tier: ti + 1, note: blocked ? 'content_blocked' : null,
        });
        res.end(errBody);
        return;
      }

      noteSuccess(pick.name);
      log(`  -> ${status} OK (${Date.now() - t0}ms) on ${pick.provider}/${pick.name} for ${modelName}`);
      return await completeOk(res, upstreamRes, pick, ctrl, {
        reqStart, requestedModel, modelName, totalAttempts, ti, status, isStream,
      });
    }
    if (totalAttempts >= config.max_attempts) break;
  }

  const latency = Date.now() - reqStart;
  pushLog({
    client_model: requestedModel, model: effectiveModel,
    provider: lastError && lastError.provider || null,
    account: lastError && lastError.account || null,
    status: 502, latency_ms: latency, attempts: totalAttempts, outcome: 'all_failed',
    last_error: lastError,
  });
  res.statusCode = 502;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify({
    error: {
      type: 'gateway_all_failed',
      message: '请求的 model 与所有回退 model 的账号都失败（限流/超时/5xx/内容审核），请加账号、配置回退或等冷却结束。',
      hint: '查看 http://' + config.host + ':' + config.port + '/admin/status',
      last_error: lastError,
    },
  }));
}

// ============== /v1/models ==============
function handleListModels(req, res) {
  const data = [];
  const seen = new Set();
  for (const [model, pool] of modelPools.entries()) {
    if (seen.has(model)) continue;
    seen.add(model);
    const providers = Array.from(new Set(pool.map((p) => p.provider)));
    data.push({
      id: model,
      object: 'model',
      created: Math.floor(Date.now() / 1000),
      owned_by: providers.length === 1 ? providers[0] : providers.join('+'),
      served_by: pool.map((p) => `${p.provider}/${p.name}`),
    });
  }
  // 模型别名也暴露出去，方便 client 直接用别名
  for (const [alias, real] of Object.entries(config.model_alias || {})) {
    if (!seen.has(alias)) {
      data.push({
        id: alias,
        object: 'model',
        created: Math.floor(Date.now() / 1000),
        owned_by: 'gateway-alias',
        alias_of: real,
      });
    }
  }
  data.sort((a, b) => a.id.localeCompare(b.id));
  res.statusCode = 200;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify({ object: 'list', data }));
}

// ============== /admin/status ==============
function handleStatus(req, res) {
  const providers = Object.values(config.providers).map((p) => ({ name: p.name, base_url: p.base_url, auth_style: p.auth_style, models: p.models, model_prefs: p.model_prefs }));
  const accounts = config.accounts.map((a) => {
    const s = stats[a.name] || {};
    const cooldownMsLeft = s.cooldown_until ? Math.max(0, s.cooldown_until - Date.now()) : 0;
    return {
      name: a.name,
      provider: a._provider.name,
      models: a.models,
      weight: a.weight,
      priority: a.priority,
      api_key_masked: maskKey(a.api_key),
      requests: s.requests || 0,
      rate_limits: s.rate_limits || 0,
      timeouts: s.timeouts || 0,
      server_errors: s.server_errors || 0,
      network_errors: s.network_errors || 0,
      last_error: s.last_error || null,
      last_error_at: s.last_error_at || null,
      last_used_at: s.last_used_at || null,
      cooldown_ms_left: cooldownMsLeft,
      health: s.health || 'unknown',
      health_score: (typeof s.hs === 'number') ? Math.round(s.hs * 100) / 100 : null,
      last_check_at: s.last_check_at || null,
      last_check_error: s.last_check_error || null,
    };
  });
  const models = {};
  for (const [m, pool] of modelPools.entries()) {
    models[m] = { accounts: pool.map((p) => `${p.provider}/${p.name}`), cursor: cursors[m] || 0 };
  }
  const totalRequests = Object.values(stats).reduce((n, s) => n + (s.requests || 0), 0);
  const totalRateLimits = Object.values(stats).reduce((n, s) => n + (s.rate_limits || 0), 0);
  res.statusCode = 200;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify({
    config: {
      port: config.port, host: config.host,
      rotation: config.rotation, failover_on: config.failover_on,
      cooldown_ms: config.cooldown_ms, request_timeout_ms: config.request_timeout_ms,
      max_attempts: config.max_attempts,       model_fallback: config.model_fallback,
      model_alias: config.model_alias,
      model_order: config.model_order || [],
      model_routes: config.model_routes || [],
      health_aware: config.health_aware !== false,
      default_model: config.default_model || null,
      persist_stats: config.persist_stats,
      health_check: config.health_check,
      request_log_file: config.request_log_file || null,
      local_api_key_set: !!config.local_api_key,
    },
    summary: { total_requests: totalRequests, total_rate_limits: totalRateLimits },
    providers, accounts, models,
  }, null, 2));
}
function maskKey(k) {
  if (!k) return '';
  if (k.length <= 8) return '***';
  return k.slice(0, 4) + '...' + k.slice(-4);
}

// ============== /admin/config（WebUI 用） ==============
function handleGetConfig(req, res) {
  try {
    const cfgPath = parseConfigPath();
    const raw = fs.readFileSync(cfgPath, 'utf8');
    res.statusCode = 200;
    res.setHeader('Content-Type', 'application/json');
    res.end(raw); // 原样返回，保持用户的结构/注释顺序
  } catch (e) {
    res.statusCode = 500; res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ error: { type: 'read_failed', message: String(e.message || e) } }));
  }
}
async function handleSetConfig(req, res) {
  let bodyText;
  try {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    bodyText = Buffer.concat(chunks).toString('utf8');
  } catch {
    res.statusCode = 400; res.setHeader('Content-Type', 'application/json');
    return res.end(JSON.stringify({ error: { type: 'bad_request', message: '读取请求体失败' } }));
  }
  let parsed;
  try {
    parsed = JSON.parse(bodyText);
  } catch (e) {
    res.statusCode = 400; res.setHeader('Content-Type', 'application/json');
    return res.end(JSON.stringify({ error: { type: 'invalid_json', message: 'JSON 解析失败: ' + e.message } }));
  }
  if (!Array.isArray(parsed.accounts) || parsed.accounts.length === 0) {
    res.statusCode = 400; res.setHeader('Content-Type', 'application/json');
    return res.end(JSON.stringify({ error: { type: 'invalid_config', message: 'accounts 必须是非空数组' } }));
  }
  // 先落盘（原子写），再热加载；热加载失败则回滚提示
  const cfgPath = parseConfigPath();
  const tmpPath = cfgPath + '.tmp';
  try {
    fs.writeFileSync(tmpPath, JSON.stringify(parsed, null, 2) + '\n', 'utf8');
    fs.renameSync(tmpPath, cfgPath);
  } catch (e) {
    res.statusCode = 500; res.setHeader('Content-Type', 'application/json');
    return res.end(JSON.stringify({ error: { type: 'write_failed', message: String(e.message || e) } }));
  }
  try {
    reload();
    res.statusCode = 200; res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({
      ok: true,
      providers: Object.keys(config.providers).length,
      accounts: config.accounts.length,
      models: modelPools.size,
    }));
  } catch (e) {
    res.statusCode = 400; res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ error: { type: 'reload_failed', message: '已写盘但热加载失败: ' + String(e.message || e) } }));
  }
}

// ============== /admin/requests ==============
function handleRequestLog(req, res) {
  res.statusCode = 200;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify({ object: 'list', data: requestLog.slice().reverse() }));
}

// ============== 静态 WebUI ==============
const UI_PATH = path.join(__dirname, 'ui.html');
function serveUI(req, res) {
  fs.readFile(UI_PATH, (err, buf) => {
    if (err) {
      res.statusCode = 404; res.setHeader('Content-Type', 'application/json');
      return res.end(JSON.stringify({ error: { type: 'ui_missing', message: 'ui.html 不存在' } }));
    }
    res.statusCode = 200;
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.end(buf);
  });
}

// ============== 鉴权 ==============
function checkLocalAuth(req, res) {
  if (!config.local_api_key) return true;
  const h = req.headers['authorization'] || '';
  const token = h.startsWith('Bearer ') ? h.slice(7) : '';
  if (token === config.local_api_key) return true;
  res.statusCode = 401;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify({ error: { type: 'unauthorized', message: '本地网关 api key 无效' } }));
  return false;
}

// ============== HTTP 服务器 ==============
const server = http.createServer(async (req, res) => {
  try {
    const url = req.url || '/';
    const method = req.method || 'GET';
    const cleanUrl = url.split('?')[0];

    // WebUI
    if ((cleanUrl === '/' || cleanUrl === '/admin/ui') && method === 'GET') return serveUI(req, res);

    // 健康/状态/日志（本地面板用，开放）
    if (cleanUrl === '/health' && method === 'GET') {
      res.statusCode = 200; res.setHeader('Content-Type', 'application/json');
      return res.end(JSON.stringify({
        ok: true,
        providers: Object.keys(config.providers).length,
        accounts: config.accounts.length,
        models: modelPools.size,
      }));
    }
    if (cleanUrl === '/admin/status' && method === 'GET') return handleStatus(req, res);
    if (cleanUrl === '/admin/requests' && method === 'GET') return handleRequestLog(req, res);
    if (cleanUrl === '/admin/config' && method === 'GET') return handleGetConfig(req, res);
    if (cleanUrl === '/admin/config' && method === 'POST') return await handleSetConfig(req, res);
    if (cleanUrl === '/admin/fetch-models' && method === 'POST') return await handleFetchModels(req, res);
    if (cleanUrl === '/admin/verify-account' && method === 'POST') return await handleVerifyAccount(req, res);
    if (cleanUrl === '/admin/reload' && method === 'POST') {
      try {
        reload();
        res.statusCode = 200; res.setHeader('Content-Type', 'application/json');
        return res.end(JSON.stringify({
          ok: true,
          providers: Object.keys(config.providers).length,
          accounts: config.accounts.length,
          models: modelPools.size,
        }));
      } catch (e) {
        res.statusCode = 400; res.setHeader('Content-Type', 'application/json');
        return res.end(JSON.stringify({ error: { type: 'reload_failed', message: String(e.message || e) } }));
      }
    }

    // OpenAI/Anthropic 兼容接口（受 local_api_key 保护）
    if (cleanUrl === '/v1/models' && method === 'GET') {
      if (!checkLocalAuth(req, res)) return;
      return handleListModels(req, res);
    }
    if (cleanUrl.startsWith('/v1/') && method === 'POST') {
      if (!checkLocalAuth(req, res)) return;
      let bodyText;
      try {
        const chunks = [];
        for await (const c of req) chunks.push(c);
        bodyText = Buffer.concat(chunks).toString('utf8');
      } catch {
        try { res.destroy(); } catch {}
        return;
      }
      if (!bodyText) {
        res.statusCode = 400; res.setHeader('Content-Type', 'application/json');
        return res.end(JSON.stringify({ error: { type: 'bad_request', message: '请求体为空' } }));
      }
      return await handleProxy(req, res, bodyText);
    }

    res.statusCode = 404; res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({
      error: {
        type: 'not_found', path: cleanUrl,
        hint: '可用: GET / (WebUI), POST /v1/chat/completions, GET /v1/models, GET /admin/status, GET /admin/requests, GET|POST /admin/config',
      },
    }));
  } catch (e) {
    log('UNHANDLED', e && e.stack || e);
    if (!res.headersSent) {
      res.statusCode = 500; res.setHeader('Content-Type', 'application/json');
      try { res.end(JSON.stringify({ error: { type: 'internal', message: String((e && e.message) || e) } })); } catch {}
    } else {
      try { res.destroy(); } catch {}
    }
  }
});

// ============== 启动 ==============
reload();
startBackgroundTasks();
server.listen(config.port, config.host, () => {
  const provList = Object.values(config.providers).map((p) => `${p.name}@${p.base_url}`).join(', ');
  log(`本地多平台 LLM 网关已启动  http://${config.host}:${config.port}`);
  log(`  WebUI 管理页:            http://${config.host}:${config.port}/`);
  log(`  providers (${Object.keys(config.providers).length}): ${provList}`);
  log(`  accounts (${config.accounts.length}): ${config.accounts.map((a) => a._provider.name + '/' + a.name).join(', ')}`);
  log(`  models mounted (${modelPools.size}): ${Array.from(modelPools.keys()).join(', ')}`);
  log(`  rotation=${config.rotation}  failover_on=[${config.failover_on.join(',')}]  cooldown_ms=${config.cooldown_ms}  timeout_ms=${config.request_timeout_ms}`);
  log(`  客户端配置:  base_url = http://${config.host}:${config.port}/v1   api_key = ${config.local_api_key ? 'config 中的 local_api_key' : '任意值（本地开放）'}`);
});