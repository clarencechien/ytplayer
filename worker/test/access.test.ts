// Cloudflare Access 的 JWT 驗簽,以及它在 fetch handler 裡的授權範圍。
//
// 起因(2026-09-04 安全檢視):`cf-access-authenticated-user-email` 這個 header 原本被
// 當成明文憑證信任,而且套用在**所有路徑**上。Access application 只蓋 /admin/*,
// 而 Access 沒蓋到的路徑 Cloudflare 不會把使用者自帶的同名 header 拿掉 ——
// 等於任何人送一個 header 就拿到 INGEST_KEY 等級的權限,而 owner email 是公開的
// git author。這一份把「偽造 header 不能授權」釘成回歸測試。
import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { accessEmail, _resetAccessCerts } from '../src/access';
import worker from '../src/index';
import { FakeR2, FakeQueue } from './fakes';

const TEAM = 'myteam';
const AUD = 'a'.repeat(64);
const EMAIL = 'owner@example.com';

const b64uStr = (s: string) => btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const b64uBuf = (b: ArrayBuffer) =>
  btoa(String.fromCharCode(...new Uint8Array(b))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

let priv: CryptoKey;
let jwk: JsonWebKey & { kid?: string };

async function makeJwt(over: Record<string, unknown> = {}, kid = 'test-kid') {
  const header = b64uStr(JSON.stringify({ alg: 'RS256', kid }));
  const body = b64uStr(
    JSON.stringify({
      exp: Math.floor(Date.now() / 1000) + 600,
      aud: [AUD],
      iss: `https://${TEAM}.cloudflareaccess.com`,
      email: EMAIL,
      ...over,
    }),
  );
  const sig = await crypto.subtle.sign(
    'RSASSA-PKCS1-v1_5',
    priv,
    new TextEncoder().encode(`${header}.${body}`),
  );
  return `${header}.${body}.${b64uBuf(sig)}`;
}

const reqWith = (jwt?: string, url = 'https://ytplayer.ai-apps.work/admin') =>
  new Request(url, { headers: jwt ? { 'cf-access-jwt-assertion': jwt } : {} });

beforeEach(async () => {
  _resetAccessCerts();
  const pair = await crypto.subtle.generateKey(
    { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
    true,
    ['sign', 'verify'],
  );
  priv = pair.privateKey;
  jwk = (await crypto.subtle.exportKey('jwk', pair.publicKey)) as JsonWebKey & { kid?: string };
  jwk.kid = 'test-kid';
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response(JSON.stringify({ keys: [jwk] }), { headers: { 'content-type': 'application/json' } })),
  );
});
afterEach(() => vi.unstubAllGlobals());

const env = { ACCESS_TEAM: TEAM, ACCESS_AUD: AUD };

describe('accessEmail:Access JWT 驗簽', () => {
  it('簽章、aud、iss、exp 都對 → 回 email', async () => {
    expect(await accessEmail(reqWith(await makeJwt()), env)).toBe(EMAIL);
  });

  it('沒設 ACCESS_TEAM / ACCESS_AUD → 一律 null(不採信任何 header)', async () => {
    const jwt = await makeJwt();
    expect(await accessEmail(reqWith(jwt), {})).toBeNull();
    expect(await accessEmail(reqWith(jwt), { ACCESS_TEAM: TEAM })).toBeNull();
    expect(await accessEmail(reqWith(jwt), { ACCESS_AUD: AUD })).toBeNull();
  });

  it('沒有 JWT header → null', async () => {
    expect(await accessEmail(reqWith(undefined), env)).toBeNull();
  });

  it('aud 不符 → null(別的 Access application 的 token 不能通用)', async () => {
    expect(await accessEmail(reqWith(await makeJwt({ aud: ['b'.repeat(64)] })), env)).toBeNull();
  });

  it('iss 不符 → null(別的團隊簽的不算)', async () => {
    expect(await accessEmail(reqWith(await makeJwt({ iss: 'https://evil.cloudflareaccess.com' })), env)).toBeNull();
  });

  it('過期 → null', async () => {
    expect(await accessEmail(reqWith(await makeJwt({ exp: Math.floor(Date.now() / 1000) - 1 })), env)).toBeNull();
  });

  it('沒有 exp 欄位 → null(不接受沒有效期的 token)', async () => {
    expect(await accessEmail(reqWith(await makeJwt({ exp: undefined })), env)).toBeNull();
  });

  it('kid 對不到公鑰 → null', async () => {
    expect(await accessEmail(reqWith(await makeJwt({}, 'other-kid')), env)).toBeNull();
  });

  it('簽章被竄改 → null', async () => {
    const jwt = await makeJwt();
    const [h, p] = jwt.split('.');
    const forged = `${h}.${p}.${b64uBuf(new Uint8Array(256).buffer)}`;
    expect(await accessEmail(reqWith(forged), env)).toBeNull();
  });

  it('亂七八糟的字串不會拋例外,只回 null', async () => {
    for (const junk of ['', 'a', 'a.b', 'a.b.c', '...', '%%%.%%%.%%%']) {
      expect(await accessEmail(reqWith(junk), env)).toBeNull();
    }
  });
});

// ---- fetch handler 層:授權範圍 ----
const workerEnv = (extra: Record<string, unknown> = {}) =>
  ({
    SUBS: new FakeR2() as unknown as R2Bucket,
    JOBS: new FakeQueue() as unknown as Queue,
    INGEST_KEY: 'test-key',
    ALLOWED_EMAIL: EMAIL,
    ...extra,
  }) as never;

const get = (env: never, path: string, headers: Record<string, string> = {}) =>
  worker.fetch(new Request(`https://ytplayer.ai-apps.work${path}`, { headers }), env);

describe('授權範圍:cf-access-* header 不是憑證', () => {
  it('光送 email header 不能授權 —— 這是 2026-09-04 修掉的那條', async () => {
    const res = await get(workerEnv(), '/videos.json', {
      'cf-access-authenticated-user-email': EMAIL,
    });
    expect(res.status).toBe(403);
  });

  it('連 JWT 都帶上,但路徑不是 /admin → 仍然不授權', async () => {
    const res = await get(workerEnv({ ACCESS_TEAM: TEAM, ACCESS_AUD: AUD }), '/videos.json', {
      'cf-access-jwt-assertion': await makeJwt(),
      'cf-access-authenticated-user-email': EMAIL,
    });
    expect(res.status).toBe(403);
  });

  it('正確的 key 照樣通', async () => {
    const res = await get(workerEnv(), '/videos.json', { 'x-ingest-key': 'test-key' });
    expect(res.status).toBe(200);
  });

  it('INGEST_KEY 沒設時 fail-closed,不是全部放行', async () => {
    const res = await get(workerEnv({ INGEST_KEY: undefined }), '/videos.json');
    expect(res.status).toBe(403);
  });
});
