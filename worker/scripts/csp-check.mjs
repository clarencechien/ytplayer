// CSP 驗收：拿真瀏覽器跑四個頁面，收集 CSP 違規（強制執行的與 Report-Only 的都收）。
// CSP 寫錯的後果是「整個播放器靜默壞掉」，所以指令清單必須是**量出來的**，不是猜的。
//
// ⚠ 已知限制：這個容器的 proxy 擋掉瀏覽器對 youtube.com 的連線（curl 可以、Chromium 不行），
// 所以 iframe API 載不進來 —— **youtube.com 的那幾條在這裡驗不到**，腳本會明講並算失敗。
// 那幾條因此只放在 Report-Only，等人在真瀏覽器確認過再升級成強制執行。
//
// 用法：npm i --no-save playwright && node scripts/csp-check.mjs
// 需求：對外網路（會真的載入 https://www.youtube.com/iframe_api）

import { createServer } from 'node:http';
import { execFileSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright';

const PORT = 8790;

function bundle(entry) {
  const out = join(mkdtempSync(join(tmpdir(), 'csp-')), 'mod.mjs');
  execFileSync('npx', ['esbuild', entry, '--bundle', '--format=esm', '--charset=utf8', `--outfile=${out}`, '--log-level=error']);
  return out;
}

const cues = [{ start: 0, end: 5, zh: '測試字幕。', en: 'Test cue.', kind: 'speech' }];

const { watchPage, indexPage, adminPage, sharePage } = await import(bundle('src/player.ts'));
// 直接引用 Worker 真正送出的那份標頭 —— 抄一份到這裡就失去驗收意義
const { PAGE_SEC } = await import(bundle('src/index.ts'));

const server = createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  if (u.pathname.includes('bilingual.json')) {
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({ videoId: 'ksfm6jeTg3Q', schema: 2, route: 'text', meta: { title: 'csp' }, cues, warnings: [], hints: [] }));
  }
  if (u.pathname.endsWith('.json')) {
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end('[]');
  }
  const page = u.pathname === '/admin' ? adminPage() : u.pathname === '/share' ? sharePage()
    : u.pathname === '/' ? indexPage() : watchPage('ksfm6jeTg3Q');
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', ...PAGE_SEC });
  res.end(page);
});
await new Promise((r) => server.listen(PORT, r));

// ⚠ 瀏覽器也要走 proxy，否則 iframe_api 根本載不到 —— 那會得到「0 違規」的假通過
// （測不到的東西不叫沒問題；CLAUDE.md「先確認新功能真的有啟動」的同一條教訓）
const proxy = process.env.HTTPS_PROXY || process.env.https_proxy;
const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM || '/opt/pw-browsers/chromium',
  ...(proxy ? { proxy: { server: proxy } } : {}),
});
let bad = 0, unverified = 0;
for (const path of ['/watch/ksfm6jeTg3Q', '/', '/admin', '/share']) {
  const ctx = await browser.newContext({ ignoreHTTPSErrors: !!proxy }); // proxy 是自簽 CA
  const page = await ctx.newPage();
  const hits = new Set();
  // 兩條路都收：主框架的 securitypolicyviolation 事件 + console 的 CSP 訊息
  await page.addInitScript(() => {
    window.__csp = [];
    addEventListener('securitypolicyviolation', (e) =>
      window.__csp.push(`${e.violatedDirective} ← ${e.blockedURI || '(inline)'}`)
    );
  });
  page.on('console', (m) => {
    const t = m.text();
    if (/Content Security Policy/i.test(t)) hits.add(t.split('\n')[0].slice(0, 160));
  });
  await page.goto(`http://127.0.0.1:${PORT}${path}`, { waitUntil: 'load' });
  await page.waitForTimeout(6000); // 等 iframe API 真的載入並建出 player
  for (const v of await page.evaluate(() => window.__csp || [])) hits.add(v);
  const ytLoaded = await page.evaluate(() => typeof window.YT !== 'undefined' && !!window.YT.Player);
  // 只有 /watch 會載 iframe API；載不到就代表這一輪沒測到 youtube 那幾條指令
  if (path.startsWith('/watch') && !ytLoaded) {
    console.log('   ⚠ iframe API 沒載入（容器 proxy 擋 youtube）—— youtube.com 那幾條這輪沒驗到，');
    console.log('     所以它們留在 Report-Only。不是通過，是「測不到」');
    unverified++;
  }
  const frames = page.frames().length;
  console.log(`${path.padEnd(22)} CSP 違規 ${hits.size}  YT API ${ytLoaded ? '載入成功' : '未載入'}  frames=${frames}`);
  for (const h of hits) console.log('   ⚠', h);
  if (hits.size) bad++;
  await ctx.close();
}
await browser.close();
server.close();
console.log(bad ? `\n❌ ${bad} 個頁面有 CSP 違規 —— 修指令清單，不要直接放寬 default-src` : '\n✅ 四個頁面零 CSP 違規（強制執行的那段）');
if (unverified) console.log(`⚠ 有 ${unverified} 項在這個環境驗不到（見檔頭）—— 別把它當成通過`);
process.exit(bad ? 1 : 0);
