// Cloudflare Turnstile 閘門（docs/privacy-hardening.md §3）——
// 隱私第三層：擋掉「不理會 noindex 又偽造 UA」的無頭爬蟲。
//
// 設計原則：
//   1. **沒設定就完全不生效**（兩個環境變數缺一 → 直接放行）。半套的安全機制比沒有更糟
//   2. 只擋頁面，不擋 /subs 與 API —— player 抓字幕、ext ingest、本機工具都不能壞
//   3. 正牌搜尋引擎不擋（同 botVerdict 的理由：擋了它就讀不到 noindex）
//   4. 自己人（帶 key 或 Access 通過）不擋
//   5. 通行證是 **HMAC 簽章的 cookie**，不是「有 cookie 就算數」——
//      否則隨便偽造一個 cookie 就繞過去了

export interface TurnstileEnv {
  TURNSTILE_SITE_KEY?: string;
  TURNSTILE_SECRET?: string;
}

export const PASS_COOKIE = 'ytp_pass';
const PASS_TTL_S = 30 * 24 * 3600; // 30 天：自用場景，別讓自己每天過閘門

export const turnstileConfigured = (env: TurnstileEnv): boolean =>
  !!(env.TURNSTILE_SITE_KEY && env.TURNSTILE_SECRET);

const b64url = (buf: ArrayBuffer): string =>
  btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

async function hmac(secret: string, msg: string): Promise<string> {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, [
    'sign',
  ]);
  return b64url(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(msg)));
}

// 通行證格式 `${到期秒數}.${簽章}` — 無狀態（不需要 KV/DO 存 session）
export async function issuePass(secret: string, nowS = Math.floor(Date.now() / 1000)): Promise<string> {
  const exp = String(nowS + PASS_TTL_S);
  return `${exp}.${await hmac(secret, exp)}`;
}

export async function passValid(secret: string, value: string | null, nowS = Math.floor(Date.now() / 1000)): Promise<boolean> {
  if (!value) return false;
  const [exp, sig] = value.split('.');
  if (!exp || !sig || !/^\d+$/.test(exp) || Number(exp) < nowS) return false;
  const expect = await hmac(secret, exp);
  // 長度先比，再逐字元比（避免早退造成的時間差；自用規模下屬防禦性寫法）
  if (sig.length !== expect.length) return false;
  let diff = 0;
  for (let i = 0; i < sig.length; i++) diff |= sig.charCodeAt(i) ^ expect.charCodeAt(i);
  return diff === 0;
}

export function readCookie(header: string | null, name: string): string | null {
  if (!header) return null;
  for (const part of header.split(';')) {
    const [k, ...rest] = part.trim().split('=');
    if (k === name) return rest.join('=');
  }
  return null;
}

// 只接受同源路徑，擋掉 open redirect（`//evil.com` 也是絕對網址）
export function safeNext(next: unknown): string {
  if (typeof next !== 'string' || !next.startsWith('/')) return '/';
  // `//evil.example` 是 protocol-relative,瀏覽器會當成外站。`/\evil.example`
  // 也是 —— Chrome 與 Firefox 都把反斜線正規化成斜線,所以只擋 `//` 是不夠的。
  if (next.startsWith('//') || next.startsWith('/\\')) return '/';
  return next;
}

/**
 * 定時比較。字串的 `===` 一遇到不同的字元就回傳,理論上洩漏「猜對了幾個字元」。
 *
 * 實務上這條路很難走通 —— 網路抖動遠大於那點差異,而且 Cloudflare 前面還有
 * 一層邊緣。但金鑰比對寫成定時是零成本的事,沒有理由不做。
 */
export function safeEqual(a: string | undefined, b: string | undefined): boolean {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  // 長度本來就會從這裡洩漏(比對前就知道)。用固定長度的雜湊拉平:
  // 兩邊都先轉成同長度的位元組再逐位比。
  const ea = new TextEncoder().encode(a);
  const eb = new TextEncoder().encode(b);
  let diff = ea.length ^ eb.length;
  const n = Math.max(ea.length, eb.length);
  for (let i = 0; i < n; i++) diff |= (ea[i] ?? 0) ^ (eb[i] ?? 0);
  return diff === 0;
}

export async function siteverify(secret: string, token: string, ip: string | null): Promise<boolean> {
  const body = new FormData();
  body.append('secret', secret);
  body.append('response', token);
  if (ip) body.append('remoteip', ip);
  try {
    const res = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', { method: 'POST', body });
    return ((await res.json()) as { success?: boolean }).success === true;
  } catch {
    return false; // 驗不到就是沒過（寧可擋掉也不要放行）
  }
}

export const passCookie = (value: string): string =>
  `${PASS_COOKIE}=${value}; Path=/; Max-Age=${PASS_TTL_S}; HttpOnly; Secure; SameSite=Lax`;

const esc = (s: string): string => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

export function challengePage(siteKey: string, next: string): string {
  return `<!doctype html>
<html lang="zh-Hant-TW">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow, noarchive">
<title>驗證中…</title>
<style>
  body { background:#111; color:#eee; font-family:system-ui,-apple-system,"Noto Sans TC",sans-serif;
         display:flex; min-height:100vh; margin:0; align-items:center; justify-content:center; }
  .box { text-align:center; padding:24px; max-width:22rem; }
  h1 { font-size:1.1rem; font-weight:600; margin:0 0 6px; }
  p { color:#999; font-size:.85rem; line-height:1.6; margin:0 0 18px; }
  .err { color:#f66; font-size:.85rem; min-height:1.2em; }
  noscript { color:#f66; font-size:.85rem; }
</style>
</head>
<body>
  <div class="box">
    <h1>先確認你不是機器人</h1>
    <p>這個站台不對外開放給自動抓取工具。通過一次後 30 天內不會再問。</p>
    <div class="cf-turnstile" data-sitekey="${esc(siteKey)}" data-callback="onOk" data-theme="dark"></div>
    <div class="err" id="err"></div>
    <noscript>需要 JavaScript 才能通過驗證。</noscript>
  </div>
<script>
var NEXT = ${JSON.stringify(next)};
function onOk(token) {
  fetch("/turnstile/verify", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ token: token, next: NEXT })
  })
    .then(function (r) { return r.json(); })
    .then(function (d) {
      if (d.ok) location.replace(d.next || "/");
      else document.getElementById("err").textContent = "驗證沒過，請重新整理再試一次";
    })
    .catch(function (e) { document.getElementById("err").textContent = String(e); });
}
</script>
<script src="https://challenges.cloudflare.com/turnstile/v0/api.js" async defer></script>
</body>
</html>`;
}
