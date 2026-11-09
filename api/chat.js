// duckai-vercel — api/chat.js
// Vercel Node.js serverless function: POST /api/chat
// Bearer auth against DUCKAI_SECRET env var (REQUIRED — there is no .secret
// file on Vercel). Same handshake/chat logic as the VM service
// (~/workspace/duckai-service/server.js): fresh proof per request, SSE parse.
// Logging: counts / latencies / error codes only. NEVER prompt or reply
// content (duck.ai may retain prompts; nothing sensitive belongs in logs).
'use strict';

const crypto = require('crypto');
const { solveChallenge, buildProof } = require('../shim.js');

const BASE = 'https://duck.ai';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36';
const HANDSHAKE_TIMEOUT_MS = 10_000;
const CHAT_TIMEOUT_MS = 30_000;
const SOLVE_TIMEOUT_MS = 15_000;
const MAX_BODY_BYTES = 64 * 1024;
const MAX_MESSAGES = 40;

const MODELS = {
  'luna': 'gpt-6-luna',
  'gpt-6-luna': 'gpt-6-luna',
  'mini': 'gpt-5.4-mini',
  'gpt-5.4-mini': 'gpt-5.4-mini',
  'haiku': 'claude-haiku-5-5',
  'claude-haiku-5-5': 'claude-haiku-5-5',
  'mistral': 'mistral-small-2603',
  'mistral-small-2603': 'mistral-small-2603',
  'oss': 'tinfoil/gpt-oss-120b',
  'tinfoil/gpt-oss-120b': 'tinfoil/gpt-oss-120b',
  'gemma': 'tinfoil/gemma4-31b',
  'tinfoil/gemma4-31b': 'tinfoil/gemma4-31b',
};
const DEFAULT_MODEL = 'gpt-6-luna';
const REASONING_EFFORT = { 'tinfoil/gpt-oss-120b': 'low' };

function log(obj) {
  // Counts / timings / codes only — never message content.
  console.log(JSON.stringify({ t: new Date().toISOString(), ...obj }));
}

function b64Json(obj) {
  return Buffer.from(JSON.stringify(obj)).toString('base64');
}

async function fetchWithTimeout(url, opts, timeoutMs) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    return await fetch(url, { ...opts, signal: ctrl.signal });
  } finally {
    clearTimeout(timer);
  }
}

// Race any promise against a timer. The timer bounds the WAIT: the caller
// gets a coded error and returns an error JSON instead of hanging forever.
// NOTE: fetchWithTimeout above only bounds time-to-headers — once fetch
// resolves, its timer is cleared, so a stalled response BODY (resp.text())
// was previously unbounded. Every body read below goes through
// readTextWithTimeout instead.
function withTimeout(promise, ms, code) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(Object.assign(new Error('timeout'), { code })), ms);
  });
  return Promise.race([
    promise.then((v) => { clearTimeout(timer); return v; },
      (e) => { clearTimeout(timer); throw e; }),
    timeout,
  ]);
}

async function readTextWithTimeout(resp, ms, code) {
  let timedOut = false;
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      timedOut = true;
      reject(Object.assign(new Error('body read timeout'), { code }));
    }, ms);
  });
  try {
    return await Promise.race([resp.text().finally(() => clearTimeout(timer)), timeout]);
  } catch (e) {
    if (timedOut) { try { if (resp.body) await resp.body.cancel(); } catch {} }
    throw e;
  }
}

// Fresh handshake per request: homepage -> fe_version, status -> challenge,
// solve in vm realm, build proof. Never cached (proofs expire in minutes).
async function freshProof() {
  const t0 = Date.now();
  const home = await fetchWithTimeout(`${BASE}/`, {
    headers: { 'User-Agent': UA, 'Accept-Language': 'en-US,en;q=0.9' },
  }, HANDSHAKE_TIMEOUT_MS);
  if (!home.ok) throw Object.assign(new Error('homepage'), { code: 'duckai_homepage', status: home.status });
  const html = await readTextWithTimeout(home, HANDSHAKE_TIMEOUT_MS, 'duckai_home_timeout');
  log({ ev: 'hs', stage: 'home_ok', status: home.status, bytes: html.length, ms: Date.now() - t0 });
  const tag = html.match(/data-version-tag="([^"]*)"/)?.[1] || 'dev';
  const sha = html.match(/data-version-sha="([^"]*)"/)?.[1] || 'hash';
  const feVersion = `${tag}-${sha}`;

  const st = await fetchWithTimeout(`${BASE}/duckchat/v1/status`, {
    headers: {
      'User-Agent': UA,
      'x-vqd-accept': '1',
      'Cache-Control': 'no-store',
      'x-fe-version': feVersion,
      'Origin': BASE,
      'Referer': `${BASE}/`,
    },
  }, HANDSHAKE_TIMEOUT_MS);
  const raw = st.headers.get('x-vqd-hash-1');
  if (!raw) throw Object.assign(new Error('no challenge'), { code: 'duckai_no_challenge', status: st.status });
  const src = Buffer.from(raw + '='.repeat((-raw.length) % 4), 'base64').toString('utf8');
  // Variant fingerprint for diagnostics only (marker strings, never content).
  const variant = src.includes('Content-Security-Policy') ? 'E-csp'
    : src.includes('innerHTML') ? 'A-innerHTML'
    : src.includes('offsetWidth') ? 'B-layout'
    : src.includes('toString.call(window)') ? 'D-integrity' : 'unknown';
  log({ ev: 'hs', stage: 'status_ok', status: st.status, variant, ms: Date.now() - t0 });
  const solved = await withTimeout(
    Promise.resolve().then(() => solveChallenge(src, { beVersion: tag, feHash: sha })),
    SOLVE_TIMEOUT_MS, 'duckai_solve_timeout');
  if (!solved || solved.__error) {
    throw Object.assign(new Error('solve failed'), { code: 'duckai_solve_failed' });
  }
  log({ ev: 'hs', stage: 'solved', variant, ms: Date.now() - t0 });
  return { feVersion, proof: buildProof(solved), variant };
}

function toDuckMessages(messages) {
  // Our API takes [{role, content:string}]; duck.ai wants user content as
  // [{type:'text', text}] parts and assistant content as a plain string.
  return messages.map((m) => {
    const content = typeof m.content === 'string' ? m.content : '';
    if (m.role === 'user') return { role: 'user', content: [{ type: 'text', text: content }] };
    return { role: 'assistant', content };
  });
}

async function chatOnce(messages, model) {
  const t0 = Date.now();
  const { feVersion, proof, variant } = await freshProof();
  const body = {
    model,
    messages: toDuckMessages(messages),
    canUseTools: true,
    reasoningEffort: REASONING_EFFORT[model] || 'none',
    canUseApproxLocation: null,
    canDelegateImageGeneration: null,
    canShowGreeting: false,
  };
  const resp = await fetchWithTimeout(`${BASE}/duckchat/v1/chat`, {
    method: 'POST',
    headers: {
      'User-Agent': UA,
      'Content-Type': 'application/json',
      'Accept': 'text/event-stream',
      'Origin': BASE,
      'Referer': `${BASE}/`,
      'x-fe-version': feVersion,
      'x-fe-signals': b64Json({
        start: Date.now(),
        events: [{ name: 'action', delta: 1200, trusted: true }],
        end: 1500,
      }),
      'X-Vqd-Hash-1': proof,
    },
    body: JSON.stringify(body),
  }, CHAT_TIMEOUT_MS);
  log({ ev: 'chat', stage: 'post_ok', status: resp.status, variant, ms: Date.now() - t0 });

  if (resp.status === 418) {
    throw Object.assign(new Error('challenge rejected (418)'), { code: 'challenge_rejected', status: 418, retryable: true, variant });
  }
  if (resp.status === 403) {
    throw Object.assign(new Error('forbidden (403)'), { code: 'duckai_forbidden', status: 403, variant });
  }
  if (resp.status === 429) {
    throw Object.assign(new Error('rate limited (429)'), { code: 'duckai_rate_limited', status: 429, variant });
  }
  if (!resp.ok) {
    throw Object.assign(new Error(`duck.ai HTTP ${resp.status}`), { code: 'duckai_http', status: resp.status, variant });
  }

  const text = await readTextWithTimeout(resp, CHAT_TIMEOUT_MS, 'duckai_sse_timeout');
  log({ ev: 'chat', stage: 'sse_read', bytes: text.length, variant, ms: Date.now() - t0 });
  let reply = '';
  for (const line of text.split('\n')) {
    if (!line.startsWith('data: ')) continue;
    const payload = line.slice(6).trim();
    if (!payload || payload.startsWith('[')) continue;
    let ev;
    try { ev = JSON.parse(payload); } catch { continue; }
    if (ev.action === 'error') {
      throw Object.assign(new Error(`duck.ai error ${ev.status || ''} ${ev.type || ''}`.trim()),
        { code: 'duckai_error', status: ev.status || null });
    }
    if (typeof ev.message === 'string' && ev.message) reply += ev.message;
  }
  if (!reply) throw Object.assign(new Error('empty reply'), { code: 'duckai_empty', variant });
  return { reply, variant };
}

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.status(status);
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Content-Length', Buffer.byteLength(body));
  res.end(body);
}

// Vercel may pre-parse a JSON body into req.body (object); otherwise read the
// raw stream with the same 64 KB cap as the VM service.
function readBody(req) {
  return new Promise((resolve, reject) => {
    if (req.body !== undefined && req.body !== null) {
      if (typeof req.body === 'string') return resolve(req.body);
      return resolve(JSON.stringify(req.body));
    }
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      // Coerce: some runtimes deliver string chunks; Buffer.concat needs Buffers.
      const buf = Buffer.isBuffer(c) ? c : Buffer.from(String(c));
      size += buf.length;
      if (size > MAX_BODY_BYTES) { reject(Object.assign(new Error('body too large'), { code: 'body_too_large' })); req.destroy(); return; }
      chunks.push(buf);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

module.exports = async (req, res) => {
  const t0 = Date.now();
  try {
    if (req.method !== 'POST') {
      sendJson(res, 405, { error: 'bad_request', detail: 'use POST /api/chat' });
      return;
    }
    // Auth: DUCKAI_SECRET env var is REQUIRED on Vercel (no .secret file).
    const secret = (process.env.DUCKAI_SECRET || '').trim();
    if (!secret) {
      log({ ev: 'chat', status: 500, ms: Date.now() - t0 });
      sendJson(res, 500, { error: 'server_error', detail: 'DUCKAI_SECRET is not configured' });
      return;
    }
    const auth = req.headers.authorization || '';
    const token = auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';
    if (!token || token.length !== secret.length ||
        !crypto.timingSafeEqual(Buffer.from(token), Buffer.from(secret))) {
      log({ ev: 'chat', status: 401, ms: Date.now() - t0 });
      sendJson(res, 401, { error: 'unauthorized', detail: 'missing or invalid Bearer token' });
      return;
    }
    let parsed;
    try {
      const raw = await readBody(req);
      if (Buffer.byteLength(raw) > MAX_BODY_BYTES) {
        throw Object.assign(new Error('body too large'), { code: 'body_too_large' });
      }
      parsed = JSON.parse(raw);
    } catch (e) {
      sendJson(res, 400, { error: 'bad_request', detail: e.code === 'body_too_large' ? 'body too large' : 'invalid JSON' });
      return;
    }
    const messages = parsed.messages;
    if (!Array.isArray(messages) || messages.length === 0 || messages.length > MAX_MESSAGES ||
        !messages.every((m) => m && typeof m.role === 'string' && typeof m.content === 'string' && m.content.length > 0)) {
      sendJson(res, 400, { error: 'bad_request', detail: 'messages must be a non-empty array of {role, content} (max 40)' });
      return;
    }
    const model = MODELS[parsed.model || ''] || DEFAULT_MODEL;
    const { reply, variant } = await chatOnce(messages, model);
    log({ ev: 'chat', status: 200, model, variant, msgs: messages.length, reply_chars: reply.length, ms: Date.now() - t0 });
    sendJson(res, 200, { reply });
  } catch (e) {
    const status = e.status && e.status >= 400 && e.status < 600 ? e.status : 502;
    const code = e.code || 'upstream_error';
    log({ ev: 'chat', status, code, variant: e.variant || undefined, ms: Date.now() - t0 });
    // Clean error JSON so the caller can fall back. No retry loop here.
    sendJson(res, status, { error: code, detail: String(e.message || 'upstream error').slice(0, 200) });
  }
};
