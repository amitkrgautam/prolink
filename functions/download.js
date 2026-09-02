const DEFAULT_SECRET = 'MyS3cr3tK3y2024!@#';
const COOKIE_NAME = 'token_session';
const SESSION_SECONDS = 60;

const DOMAIN_SWAP_RULES = {
  'files.abcmax.info': 'go.pvtcdn.com',
  'files.pvtcdn.com': 'go.pvtcdn.com',
};

const DECODED_URL_SWAP_RULES = {
  'fsiblog.nl': 'ltdporn.com',
};

const ALLOWED_EXT = new Set([
  'mp4', 'webm', 'mkv', 'avi', 'mov', 'flv', 'm4v', 'ts', 'mp3', 'm4a', 'pdf',
]);

const MIME = {
  mp4: 'video/mp4',
  webm: 'video/webm',
  mkv: 'video/x-matroska',
  avi: 'video/x-msvideo',
  mov: 'video/quicktime',
  flv: 'video/x-flv',
  m4v: 'video/x-m4v',
  ts: 'video/mp2t',
  mp3: 'audio/mpeg',
  m4a: 'audio/mp4',
  pdf: 'application/pdf',
};

export async function onRequest(context) {
  const { request, env } = context;
  const url = new URL(request.url);
  const secret = env.SECRET_KEY || DEFAULT_SECRET;
  let rawToken = (url.searchParams.get('id') || '').trim();

  if (!rawToken) {
    const cookie = readSessionCookie(request);
    if (cookie?.token && unixNow() - cookie.created_at < SESSION_SECONDS) {
      return redirectTo(`/download?id=${encodeURIComponent(cookie.token)}`);
    }
    return redirectTo('/404');
  }

  const decoded = decodeDownloadUrl(rawToken, secret);
  if (decoded.error) return redirectTo('/404');

  const targetUrl = decoded.url;
  const fetchUrl = swapHost(swapDomain(targetUrl, DECODED_URL_SWAP_RULES), 'ltdporn.com');

  let html;
  try {
    const upstream = await fetch(fetchUrl, {
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124 Safari/537.36',
        'Accept-Language': 'en-US,en;q=0.9',
        Accept: 'text/html,application/xhtml+xml',
      },
      redirect: 'follow',
      signal: AbortSignal.timeout(15000),
    });
    if (!upstream.ok) return redirectTo('/404');
    html = await upstream.text();
  } catch {
    return redirectTo('/404');
  }

  const videoData = extractVideoData(html, targetUrl);
  if (!videoData) return redirectTo('/404');

  if (url.searchParams.get('dl') && videoData.contentUrl) {
    return streamDownload(videoData);
  }

  const headers = new Headers({
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  headers.append(
    'Set-Cookie',
    `${COOKIE_NAME}=${sessionCookieValue(rawToken)}; Path=/; Max-Age=${SESSION_SECONDS}; HttpOnly; SameSite=Lax`,
  );

  return new Response(renderPage(videoData, rawToken), { status: 200, headers });
}

function extractVideoData(html, targetUrl) {
  let name = getMeta(html, 'name') || getMeta(html, '', 'og:title');
  const description = getMeta(html, 'description') || getMeta(html, '', 'og:description');
  let thumbnail = getMeta(html, 'thumbnailUrl') || getMeta(html, '', 'og:image');
  let contentUrl = getMeta(html, 'contentURL') || getMeta(html, '', 'og:video');
  const duration = parseDuration(getMeta(html, 'duration'));

  if (!name) {
    const title = html.match(/<title[^>]*>([^<]+)<\/title>/i);
    if (title) name = decodeEntities(title[1].trim());
  }

  if (contentUrl) contentUrl = swapDomain(contentUrl, DOMAIN_SWAP_RULES);
  if (thumbnail) thumbnail = swapDomain(thumbnail, DOMAIN_SWAP_RULES);

  let ext = 'mp4';
  if (contentUrl) {
    try {
      const path = new URL(contentUrl).pathname;
      const detected = (path.split('.').pop() || '').toLowerCase();
      if (ALLOWED_EXT.has(detected)) ext = detected;
    } catch {
      /* keep default */
    }
  }

  if (!name && !contentUrl) return null;

  return { name, description, thumbnail, contentUrl, ext, targetUrl, duration };
}

async function streamDownload(videoData) {
  const ext = videoData.ext || 'mp4';
  const filename = makeFilename(videoData.name || `media-${Date.now()}`, ext);
  const upstream = await fetch(videoData.contentUrl, {
    headers: { 'User-Agent': 'Mozilla/5.0' },
    redirect: 'follow',
  });

  if (!upstream.ok || !upstream.body) {
    return Response.redirect(videoData.contentUrl, 302);
  }

  const headers = new Headers(upstream.headers);
  headers.set('Content-Type', MIME[ext] || 'application/octet-stream');
  headers.set(
    'Content-Disposition',
    `attachment; filename="${filename}"; filename*=UTF-8''${encodeURIComponent(filename)}`,
  );
  headers.set('Cache-Control', 'no-store');
  headers.delete('content-encoding');
  headers.delete('content-length');

  return new Response(upstream.body, { status: 200, headers });
}

function decodeDownloadUrl(token, key) {
  const b64 = token.replace(/-/g, '+').replace(/_/g, '/');
  const padded = b64 + '='.repeat((4 - (b64.length % 4)) % 4);
  let encrypted;
  try {
    encrypted = atob(padded);
  } catch {
    return { error: 'Invalid token' };
  }

  let decrypted = '';
  for (let i = 0; i < encrypted.length; i++) {
    decrypted += String.fromCharCode(encrypted.charCodeAt(i) ^ key.charCodeAt(i % key.length));
  }

  try {
    const data = JSON.parse(decrypted);
    if (!data?.url || typeof data.url !== 'string') return { error: 'Malformed token' };
    return { url: data.url };
  } catch {
    return { error: 'Malformed token' };
  }
}

function swapDomain(url, rules) {
  if (!url) return url;
  try {
    const parsed = new URL(url);
    const next = rules[parsed.host] || rules[parsed.host.toLowerCase()];
    if (!next) return url;
    parsed.host = next;
    return parsed.toString();
  } catch {
    return url;
  }
}

function swapHost(url, newHost) {
  try {
    const parsed = new URL(url);
    parsed.host = newHost;
    return parsed.toString();
  } catch {
    return url;
  }
}

function getMeta(html, itemprop = '', property = '') {
  const attrs = [];
  if (itemprop) attrs.push(['itemprop', itemprop]);
  if (property) attrs.push(['property', property]);

  for (const [attr, value] of attrs) {
    const escaped = value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const patterns = [
      new RegExp(
        `<meta\\b[^>]*\\b${attr}=["']${escaped}["'][^>]*\\bcontent=["']([^"']*)["'][^>]*>`,
        'i',
      ),
      new RegExp(
        `<meta\\b[^>]*\\bcontent=["']([^"']*)["'][^>]*\\b${attr}=["']${escaped}["'][^>]*>`,
        'i',
      ),
    ];
    for (const pattern of patterns) {
      const match = html.match(pattern);
      if (match && match[1].trim()) return decodeEntities(match[1].trim());
    }
  }
  return '';
}

function parseDuration(iso) {
  if (!iso) return '';
  const match = iso.match(/^P(?:(\d+)D)?T?(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/i);
  if (!match) return '';
  let hours = (Number(match[2]) || 0) + (Number(match[1]) || 0) * 24;
  const minutes = Number(match[3]) || 0;
  const seconds = Number(match[4]) || 0;
  if (hours > 0) {
    return `${hours}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
  }
  if (minutes > 0 || seconds > 0) {
    return `${minutes}:${String(seconds).padStart(2, '0')}`;
  }
  return '';
}

function makeFilename(title, ext = 'mp4') {
  let name = decodeEntities(title)
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')
    .replace(/[\s-]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 80)
    .replace(/-$/g, '');
  if (!name) name = `media-${Date.now()}`;
  return `${name}.${String(ext).replace(/^\./, '')}`;
}

function decodeEntities(value) {
  return value
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCharCode(parseInt(n, 16)));
}

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function unixNow() {
  return Math.floor(Date.now() / 1000);
}

function readSessionCookie(request) {
  const raw = request.headers.get('Cookie') || '';
  const match = raw.match(new RegExp(`(?:^|; )${COOKIE_NAME}=([^;]+)`));
  if (!match) return null;
  try {
    return JSON.parse(atob(decodeURIComponent(match[1])));
  } catch {
    return null;
  }
}

function sessionCookieValue(token) {
  return btoa(JSON.stringify({ token, created_at: unixNow() }));
}

function redirectTo(path) {
  return new Response(null, {
    status: 302,
    headers: { Location: path, 'Cache-Control': 'no-store' },
  });
}

function renderPage(video, token) {
  const name = video.name || 'Untitled Media';
  const ext = (video.ext || 'mp4').toUpperCase();
  const filename = makeFilename(name, video.ext || 'mp4');
  const durationRow = video.duration
    ? `<tr><td>Duration</td><td class="val-orange">${escapeHtml(video.duration)}</td></tr>`
    : '';
  const durationBadge = video.duration
    ? `<div class="duration-badge">${escapeHtml(video.duration)}</div>`
    : '';

  const preview = video.thumbnail
    ? `<img src="${escapeHtml(video.thumbnail)}" alt="${escapeHtml(name)}" loading="lazy">
      <div class="preview-badge">Preview</div>
      <div class="quality-badge">${escapeHtml(ext)}</div>
      ${durationBadge}
      <div class="preview-bar"><span class="preview-bar-title">${escapeHtml(name)}</span></div>`
    : `<div class="preview-placeholder">
        <svg viewBox="0 0 24 24"><path d="M18 4l2 4h-3l-2-4h-2l2 4h-3l-2-4H8l2 4H7L5 4H4a2 2 0 00-2 2v12a2 2 0 002 2h16a2 2 0 002-2V4h-4z"/></svg>
        <span>Media File</span>
      </div>
      <div class="preview-badge">Preview</div>
      ${durationBadge}`;

  const downloadBlock = video.contentUrl
    ? `<button onclick="openDownload()" class="dl-btn" id="dlBtn">
        <span class="dl-btn-icon"><svg viewBox="0 0 24 24"><path d="M19 9h-4V3H9v6H5l7 7 7-7zM5 18v2h14v-2H5z"/></svg></span>
        Download Now &mdash; ${escapeHtml(ext)}
      </button>
      <script>
      var downloadLink = "?id=${encodeURIComponent(token)}&dl=1";
      function openDownload() { if (downloadLink) window.open(downloadLink, "_self"); }
      </script>`
    : `<div style="background:#fff;border:1px dashed var(--border);border-radius:var(--radius);padding:20px;text-align:center;color:var(--text-light);font-size:.78rem;margin-bottom:20px">
        No downloadable file found for this link.
      </div>`;

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1.0">
<title>${escapeHtml(name)} — Prolinks</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet">
<style>
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
:root{--bg:#f5f3ee;--bg-card:#ffffff;--border:#e8e4dc;--border-light:#f0ece4;--text:#1a1a1a;--text-muted:#6b7280;--text-light:#9ca3af;--accent-orange:#ff6b35;--accent-gradient:linear-gradient(135deg,#ff6b35 0%,#ff4d8d 100%);--font:'Inter',system-ui,sans-serif;--radius:12px;--shadow:0 1px 3px rgba(0,0,0,0.08),0 1px 2px rgba(0,0,0,0.06);--shadow-md:0 4px 16px rgba(0,0,0,0.10)}
html{font-family:var(--font);color:var(--text);background:var(--bg);-webkit-font-smoothing:antialiased}
img{display:block;max-width:100%}a{text-decoration:none;color:inherit}
body{min-height:100vh;display:flex;flex-direction:column}
.nav{background:#fff;border-bottom:1px solid var(--border);padding:0 20px;height:56px;display:flex;align-items:center;justify-content:space-between;position:sticky;top:0;z-index:10}
.nav-logo{display:flex;align-items:center;gap:10px}
.nav-logo-icon{width:36px;height:36px;background:var(--accent-gradient);border-radius:10px;display:flex;align-items:center;justify-content:center}
.nav-logo-icon svg{width:18px;height:18px;fill:#fff}
.nav-logo-text{font-size:1.05rem;font-weight:700;letter-spacing:-.01em}
.nav-back{font-size:.82rem;color:var(--text-muted);display:flex;align-items:center;gap:4px}
.nav-back:hover{color:var(--text)}
.nav-back svg{width:14px;height:14px;fill:currentColor}
.main{flex:1;max-width:480px;width:100%;margin:0 auto;padding:20px 16px 40px}
.breadcrumb{font-size:.75rem;color:var(--text-light);margin-bottom:16px;display:flex;align-items:center;gap:6px}
.breadcrumb a{color:var(--accent-orange)}
.breadcrumb svg{width:10px;height:10px;fill:var(--text-light)}
.file-title{font-size:1.25rem;font-weight:700;line-height:1.35;letter-spacing:-.02em;margin-bottom:18px}
.preview-wrap{border-radius:var(--radius);overflow:hidden;background:#111;margin-bottom:16px;position:relative;aspect-ratio:16/9;box-shadow:var(--shadow-md)}
.preview-wrap img{width:100%;height:100%;object-fit:cover}
.preview-badge{position:absolute;top:10px;left:10px;background:rgba(0,0,0,0.6);color:#fff;font-size:.62rem;font-weight:700;letter-spacing:.08em;padding:4px 8px;border-radius:5px;text-transform:uppercase}
.quality-badge{position:absolute;top:10px;right:10px;background:var(--accent-orange);color:#fff;font-size:.62rem;font-weight:700;letter-spacing:.06em;padding:4px 8px;border-radius:5px;text-transform:uppercase}
.duration-badge{position:absolute;bottom:10px;right:10px;background:rgba(0,0,0,0.6);color:#fff;font-size:.72rem;font-weight:700;padding:4px 9px;border-radius:5px}
.preview-bar{position:absolute;bottom:0;left:0;right:0;padding:20px 12px 10px}
.preview-bar-title{font-size:.78rem;font-weight:600;color:#fff}
.preview-placeholder{width:100%;height:100%;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:10px;color:rgba(255,255,255,.3)}
.preview-placeholder svg{width:40px;height:40px;fill:currentColor}
.pills{display:flex;gap:8px;margin-bottom:18px;flex-wrap:wrap}
.pill{display:inline-flex;align-items:center;gap:5px;padding:5px 12px;border:1px solid var(--border);border-radius:99px;font-size:.75rem;font-weight:600;color:var(--text-muted);background:#fff}
.pill.active{border-color:var(--accent-orange);color:var(--accent-orange);background:#fff8f5}
.pill-dot{width:7px;height:7px;border-radius:50%;background:var(--accent-orange)}
.dl-btn{display:flex;align-items:center;justify-content:center;gap:10px;width:100%;padding:17px 20px;border-radius:var(--radius);background:var(--accent-gradient);color:#fff;font-size:.92rem;font-weight:700;border:none;cursor:pointer;box-shadow:0 4px 20px rgba(255,107,53,0.35);margin-bottom:20px}
.dl-btn-icon{width:22px;height:22px;border-radius:7px;background:rgba(255,255,255,.25);display:flex;align-items:center;justify-content:center}
.dl-btn-icon svg{width:13px;height:13px;fill:#fff}
.details-card{background:#fff;border:1px solid var(--border);border-radius:var(--radius);overflow:hidden;margin-bottom:16px;box-shadow:var(--shadow)}
.details-header{padding:12px 16px;border-bottom:1px solid var(--border-light);display:flex;align-items:center;gap:7px}
.details-header-text{font-size:.72rem;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:var(--text-muted)}
.details-table{width:100%;border-collapse:collapse}
.details-table tr{border-bottom:1px solid var(--border-light)}
.details-table tr:last-child{border-bottom:none}
.details-table td{padding:11px 16px;font-size:.78rem}
.details-table td:first-child{color:var(--text-light);font-weight:500;letter-spacing:.04em;text-transform:uppercase;font-size:.68rem;width:42%}
.details-table td:last-child{color:var(--text);font-weight:600;text-align:right}
.val-orange{color:var(--accent-orange)!important}
.status-badge{display:inline-flex;align-items:center;gap:5px;background:#f0fdf4;color:#16a34a;border:1px solid #bbf7d0;border-radius:99px;padding:3px 10px;font-size:.72rem;font-weight:600}
.status-badge svg{width:11px;height:11px;fill:#16a34a}
.footer{border-top:1px solid var(--border);padding:16px;text-align:center;font-size:.72rem;color:var(--text-light);display:flex;align-items:center;justify-content:center;flex-wrap:wrap;gap:12px}
.footer a{color:var(--text-light)}.footer a:hover{color:var(--text-muted)}
.footer-copy{width:100%;text-align:center;margin-top:4px;font-size:.68rem}
@media(max-width:480px){.main{padding:16px 12px 32px}.file-title{font-size:1.1rem}}
</style>
</head>
<body>
<nav class="nav">
  <div class="nav-logo">
    <div class="nav-logo-icon"><svg viewBox="0 0 24 24"><path d="M19 9h-4V3H9v6H5l7 7 7-7zM5 18v2h14v-2H5z"/></svg></div>
    <span class="nav-logo-text">Prolinks</span>
  </div>
  <a href="/" class="nav-back">
    <svg viewBox="0 0 24 24"><path d="M20 11H7.83l5.59-5.59L12 4l-8 8 8 8 1.41-1.41L7.83 13H20v-2z"/></svg>
    Back
  </a>
</nav>
<div class="main">
  <div class="breadcrumb">
    <a href="/">Home</a>
    <svg viewBox="0 0 24 24"><path d="M10 6L8.59 7.41 13.17 12l-4.58 4.59L10 18l6-6z"/></svg>
    <span>Download File</span>
  </div>
  <h1 class="file-title">${escapeHtml(name)}</h1>
  <div class="preview-wrap">${preview}</div>
  <div class="pills"><span class="pill active"><span class="pill-dot"></span>${escapeHtml(ext)}</span></div>
  <div class="details-card">
    <div class="details-header"><span>📋</span><span class="details-header-text">File Details</span></div>
    <table class="details-table">
      <tr><td>File Name</td><td>${escapeHtml(filename)}</td></tr>
      <tr><td>Format</td><td class="val-orange">${escapeHtml(ext)}</td></tr>
      ${durationRow}
      <tr><td>Status</td><td><span class="status-badge"><svg viewBox="0 0 24 24"><path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41L9 16.17z"/></svg>Ready</span></td></tr>
    </table>
  </div>
  ${downloadBlock}
</div>
<footer class="footer">
  <a href="/privacy">Privacy</a>
  <a href="/terms">Terms</a>
  <a href="/dmca">DMCA</a>
  <a href="/contact">Contact</a>
  <div class="footer-copy">&copy; 2026 ProLinks. All rights reserved.</div>
</footer>
<script>
(function(){if(history.replaceState){var u=new URL(location.href);u.searchParams.delete('id');history.replaceState(null,'',u);}})();
</script>
<script async src="https://www.googletagmanager.com/gtag/js?id=G-BJXFQT2H32"></script>
<script>window.dataLayer=window.dataLayer||[];function gtag(){dataLayer.push(arguments);}gtag('js',new Date());gtag('config','G-BJXFQT2H32');</script>
</body>
</html>`;
}
