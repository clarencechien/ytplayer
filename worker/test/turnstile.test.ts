// Turnstile 通行證（docs/privacy-hardening.md §3）
import { describe, it, expect } from 'vitest';
import {
  turnstileConfigured,
  issuePass,
  passValid,
  readCookie,
  safeNext,
  safeEqual,
  passCookie,
  challengePage,
  PASS_COOKIE,
} from '../src/turnstile';

const SECRET = '0x4AAAAAAA-test-secret';

describe('turnstileConfigured', () => {
  it('兩個都要有才算設定好（半套的安全機制比沒有更糟）', () => {
    expect(turnstileConfigured({})).toBe(false);
    expect(turnstileConfigured({ TURNSTILE_SITE_KEY: 'a' })).toBe(false);
    expect(turnstileConfigured({ TURNSTILE_SECRET: 'b' })).toBe(false);
    expect(turnstileConfigured({ TURNSTILE_SITE_KEY: 'a', TURNSTILE_SECRET: 'b' })).toBe(true);
  });
});

describe('通行證（HMAC 簽章，無狀態）', () => {
  it('簽出來的通行證驗得過', async () => {
    expect(await passValid(SECRET, await issuePass(SECRET))).toBe(true);
  });

  it('偽造的簽章驗不過 —— 不是「有 cookie 就算數」', async () => {
    const now = Math.floor(Date.now() / 1000);
    expect(await passValid(SECRET, `${now + 999}.randomsignature`)).toBe(false);
    expect(await passValid(SECRET, `${now + 999}.`)).toBe(false);
    expect(await passValid(SECRET, 'garbage')).toBe(false);
    expect(await passValid(SECRET, null)).toBe(false);
  });

  it('換一把 secret 就全部失效（洩漏時的撤銷手段）', async () => {
    expect(await passValid('another-secret', await issuePass(SECRET))).toBe(false);
  });

  it('過期的不收', async () => {
    const past = Math.floor(Date.now() / 1000) - 10 * 24 * 3600;
    const stale = await issuePass(SECRET, past - 30 * 24 * 3600);
    expect(await passValid(SECRET, stale)).toBe(false);
  });

  it('cookie 屬性齊全（HttpOnly/Secure/SameSite）', async () => {
    const c = passCookie(await issuePass(SECRET));
    expect(c.startsWith(`${PASS_COOKIE}=`)).toBe(true);
    for (const attr of ['Path=/', 'HttpOnly', 'Secure', 'SameSite=Lax', 'Max-Age=']) expect(c).toContain(attr);
  });
});

describe('readCookie / safeNext', () => {
  it('從 cookie 標頭挑出指定的那個', () => {
    expect(readCookie('a=1; ytp_pass=abc.def; b=2', PASS_COOKIE)).toBe('abc.def');
    expect(readCookie('a=1', PASS_COOKIE)).toBe(null);
    expect(readCookie(null, PASS_COOKIE)).toBe(null);
  });

  it('safeNext 只放行同源路徑（擋 open redirect）', () => {
    expect(safeNext('/watch/abcdefghijk?x=1')).toBe('/watch/abcdefghijk?x=1');
    expect(safeNext('//evil.example')).toBe('/'); // 協定相對網址也是絕對網址
    expect(safeNext('https://evil.example')).toBe('/');
    expect(safeNext(undefined)).toBe('/');
  });
});

describe('challengePage', () => {
  it('帶入 site key 與回跳路徑，且自己也是 noindex', () => {
    const p = challengePage('0xSITEKEY', '/watch/abcdefghijk');
    expect(p).toContain('data-sitekey="0xSITEKEY"');
    expect(p).toContain('"/watch/abcdefghijk"');
    expect(p).toContain('noindex');
    expect(p).toContain('challenges.cloudflare.com/turnstile/v0/api.js');
  });

  it('site key 有跳脫（外部值一律當敵意輸入）', () => {
    expect(challengePage('a"><script>x</script>', '/')).not.toContain('<script>x</script>');
  });
});

describe('safeNext — 反斜線也是外站', () => {
  it('放行站內路徑', () => {
    expect(safeNext('/watch/abc')).toBe('/watch/abc');
    expect(safeNext('/a?b=1#c')).toBe('/a?b=1#c');
  });

  it('擋掉 protocol-relative 與反斜線變體', () => {
    // 瀏覽器會把 /\evil 正規化成 //evil，所以只擋 // 是不夠的
    expect(safeNext('//evil.example')).toBe('/');
    expect(safeNext('/\\evil.example')).toBe('/');
    expect(safeNext('/\\\\evil.example')).toBe('/');
  });

  it('非字串與非絕對路徑一律回 /', () => {
    expect(safeNext('https://evil.example')).toBe('/');
    expect(safeNext('watch/abc')).toBe('/');
    expect(safeNext(undefined)).toBe('/');
    expect(safeNext(123)).toBe('/');
  });
});

describe('safeEqual — 定時比較', () => {
  it('相同就是 true', () => {
    expect(safeEqual('abc', 'abc')).toBe(true);
    expect(safeEqual('', '')).toBe(true);
    expect(safeEqual('中文金鑰', '中文金鑰')).toBe(true);
  });

  it('不同、長度不同、undefined 都是 false', () => {
    expect(safeEqual('abc', 'abd')).toBe(false);
    expect(safeEqual('abc', 'abcd')).toBe(false);
    expect(safeEqual('abc', '')).toBe(false);
    expect(safeEqual(undefined, 'abc')).toBe(false);
    expect(safeEqual('abc', undefined)).toBe(false);
    expect(safeEqual(undefined, undefined)).toBe(false);
  });
});
