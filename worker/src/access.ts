/* Cloudflare Access 的 JWT 驗簽。

   為什麼不能只看 email header:Access 只蓋得到它被設定的那些路徑
  (本專案是 /admin/*,見 docs/migration.md §5)。**Access 沒有蓋到的路徑,
   Cloudflare 不會幫你把使用者自己送的同名 header 拿掉** —— 也就是說
   `cf-access-authenticated-user-email` 在那些路徑上等於任何人都能自己寫的字串,
   而本專案的 owner email 是公開的 git author。真正可信的是
   `Cf-Access-Jwt-Assertion` 的 RS256 簽章。

   實作沿用 clarencechien/mahou 的 worker/index.js(已在正式站運作),
   額外收緊一項:exp 必須存在且是數字,沒有 exp 的 token 一律不收。 */

type Jwk = JsonWebKey & { kid?: string };

let certsCache: { at: number; keys: Jwk[] | null } = { at: 0, keys: null };

/** 測試用:清掉模組級快取 */
export function _resetAccessCerts(): void {
  certsCache = { at: 0, keys: null };
}

async function accessKeys(team: string): Promise<Jwk[]> {
  // Cloudflare 每六週輪替一次公鑰,所以快取只留一小時
  if (certsCache.keys && Date.now() - certsCache.at < 3_600_000) return certsCache.keys;
  const r = await fetch(`https://${team}.cloudflareaccess.com/cdn-cgi/access/certs`);
  if (!r.ok) throw new Error(`access certs ${r.status}`);
  const { keys } = (await r.json()) as { keys: Jwk[] };
  certsCache = { at: Date.now(), keys };
  return keys;
}

const b64u = (s: string) => atob(s.replace(/-/g, '+').replace(/_/g, '/'));

export type AccessEnv = { ACCESS_TEAM?: string; ACCESS_AUD?: string };

/**
 * 回傳「驗過簽章」的 Access 使用者 email;任何一項不成立都回 null。
 * 兩個設定值缺一 → 一律回 null,也就是這個部署不採信任何 Access header
 * (fail-closed:寧可退回 key 認證,也不要在沒驗簽的情況下相信 header)。
 */
export async function accessEmail(req: Request, env: AccessEnv): Promise<string | null> {
  if (!env.ACCESS_TEAM || !env.ACCESS_AUD) return null;
  const jwt = req.headers.get('cf-access-jwt-assertion');
  if (!jwt) return null;
  try {
    const [h, p, s] = jwt.split('.');
    if (!h || !p || !s) return null;
    const head = JSON.parse(b64u(h)) as { kid?: string; alg?: string };
    const body = JSON.parse(b64u(p)) as { exp?: unknown; aud?: unknown; iss?: unknown; email?: unknown };

    // 演算法寫死,不吃 header 的 alg(避免 alg:none / HS256 混淆)
    if (typeof body.exp !== 'number' || Date.now() / 1000 > body.exp) return null;
    const aud = Array.isArray(body.aud) ? body.aud : [body.aud];
    if (!aud.includes(env.ACCESS_AUD)) return null;
    if (body.iss !== `https://${env.ACCESS_TEAM}.cloudflareaccess.com`) return null;

    const jwk = (await accessKeys(env.ACCESS_TEAM)).find(k => k.kid === head.kid);
    if (!jwk) return null;
    const key = await crypto.subtle.importKey(
      'jwk',
      jwk,
      { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
      false,
      ['verify'],
    );
    const sig = Uint8Array.from(b64u(s), c => c.charCodeAt(0));
    const ok = await crypto.subtle.verify(
      'RSASSA-PKCS1-v1_5',
      key,
      sig,
      new TextEncoder().encode(`${h}.${p}`),
    );
    return ok && typeof body.email === 'string' ? body.email : null;
  } catch {
    return null;
  }
}
