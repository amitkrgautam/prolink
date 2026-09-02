const LINK_TTL_SECONDS = 24 * 60 * 60;
const CODE_CHARS = 'abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const CODE_LENGTH = 8;
const MAX_URL_LENGTH = 2048;
const MAX_META_BYTES = 2048;

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Max-Age': '86400',
};

export async function onRequest(context) {
  const { request, env } = context;

  if (request.method === 'OPTIONS') {
    return json(null, 204);
  }

  if (!env.LINKS) {
    return json({
      success: false,
      error: 'KV namespace LINKS is not bound. Create it and bind it in wrangler.toml or the Pages dashboard.',
    }, 500);
  }

  const url = new URL(request.url);
  const action = url.searchParams.get('action') || '';

  try {
    if (action === 'create' && request.method === 'POST') {
      return await createLink(request, env);
    }
    if (action === 'get' && request.method === 'GET') {
      return await getLink(url, env);
    }
    return json({ success: false, error: 'Unknown action' }, 400);
  } catch (err) {
    return json({ success: false, error: 'Server error' }, 500);
  }
}

async function createLink(request, env) {
  let input;
  try {
    input = await request.json();
  } catch {
    return json({ success: false, error: 'Invalid JSON' }, 400);
  }

  const originalUrl = String(input.url || '').trim();
  if (!isHttpUrl(originalUrl) || originalUrl.length > MAX_URL_LENGTH) {
    return json({ success: false, error: 'Invalid URL' }, 400);
  }

  const meta = sanitizeMeta(input.meta);
  const lookupKey = await urlIndexKey(originalUrl);
  const existingCode = await env.LINKS.get(lookupKey);

  if (existingCode) {
    const existing = await env.LINKS.get(existingCode, 'json');
    if (existing && !isExpired(existing)) {
      return json({ success: true, code: existingCode, existing: true });
    }
  }

  let code;
  for (let i = 0; i < 8; i++) {
    const candidate = generateCode();
    if (!(await env.LINKS.get(candidate))) {
      code = candidate;
      break;
    }
  }
  if (!code) {
    return json({ success: false, error: 'Could not generate a unique code' }, 500);
  }

  const now = unixNow();
  const entry = {
    original_url: originalUrl,
    meta,
    created_at: now,
    hits: 0,
  };

  await Promise.all([
    env.LINKS.put(code, JSON.stringify(entry), { expirationTtl: LINK_TTL_SECONDS }),
    env.LINKS.put(lookupKey, code, { expirationTtl: LINK_TTL_SECONDS }),
  ]);

  return json({ success: true, code, existing: false });
}

async function getLink(url, env) {
  const code = String(url.searchParams.get('code') || '').trim();
  if (!code || !/^[a-zA-Z0-9]{4,16}$/.test(code)) {
    return json({ success: false, error: 'No code provided' }, 400);
  }

  const entry = await env.LINKS.get(code, 'json');
  if (!entry || isExpired(entry)) {
    if (entry) await env.LINKS.delete(code);
    return json({ success: false, error: 'not_found' }, 404);
  }

  entry.hits = (entry.hits || 0) + 1;
  const remaining = remainingTtl(entry);
  if (remaining >= 60) {
    await env.LINKS.put(code, JSON.stringify(entry), { expirationTtl: remaining });
  }

  return json({
    success: true,
    code,
    original_url: entry.original_url,
    meta: entry.meta || {},
    created_at: entry.created_at,
    hits: entry.hits,
  });
}

function json(body, status = 200) {
  return new Response(body == null ? null : JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      ...CORS_HEADERS,
    },
  });
}

function unixNow() {
  return Math.floor(Date.now() / 1000);
}

function isExpired(entry) {
  return unixNow() - (entry.created_at || 0) > LINK_TTL_SECONDS;
}

function remainingTtl(entry) {
  return LINK_TTL_SECONDS - (unixNow() - (entry.created_at || 0));
}

function isHttpUrl(value) {
  try {
    const parsed = new URL(value);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

function generateCode() {
  const bytes = crypto.getRandomValues(new Uint8Array(CODE_LENGTH));
  let code = '';
  for (const byte of bytes) {
    code += CODE_CHARS[byte % CODE_CHARS.length];
  }
  return code;
}

async function urlIndexKey(url) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(url));
  const hex = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
  return `url:${hex}`;
}

function sanitizeMeta(meta) {
  if (!meta || typeof meta !== 'object' || Array.isArray(meta)) return {};
  const allowed = ['filename', 'ext', 'size', 'icon', 'type', 'format'];
  const clean = {};
  for (const key of allowed) {
    if (typeof meta[key] === 'string') {
      clean[key] = meta[key].slice(0, 200);
    }
  }
  if (JSON.stringify(clean).length > MAX_META_BYTES) return {};
  return clean;
}
