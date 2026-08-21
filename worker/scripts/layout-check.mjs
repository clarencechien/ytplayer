// 字幕排版驗收 harness（docs/adr-001-line-budget.md 的證據來源）。
//
// 為什麼需要它：行數預算是**渲染**行為，字級、螢幕寬、中英混排都會影響 ——
// 靜態測試只能釘住 CSS 字串，量不到「這句實際佔幾行」。
// 這支腳本用真瀏覽器跑真語料，把 7 種情境的行數分布印出來。
// （它抓到過兩個單元測試看不見的 bug：縮字級其實減不了行數、原文會佔到 3 行）
//
// 用法：
//   npm i --no-save playwright        # 刻意不進 package.json —— 只有跑驗收時才需要
//   node scripts/layout-check.mjs                    # 從 production 抓真語料
//   node scripts/layout-check.mjs ./cues.json        # 或用本機檔（[{start,end,zh,en}]）
//
// 需求：環境變數 HTTPS_PROXY（抓 production 語料用）、INGEST_KEY（列表要 key）

import { createServer } from 'node:http';
import { execFileSync } from 'node:child_process';
import { readFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setGlobalDispatcher, ProxyAgent } from 'undici';
import { chromium, devices } from 'playwright';

const proxy = process.env.HTTPS_PROXY || process.env.https_proxy;
if (proxy) setGlobalDispatcher(new ProxyAgent(proxy));

const BASE = process.env.YTPLAYER_BASE || 'https://ytplayer.ai-apps.work';
// 兩支性格相反的片：英文快剪（cue 短、句子碎）＋ 日文導覽（句子長）
const SAMPLE_IDS = ['hK9fypJKHyY', 'kCIvgJklMWQ'];
const PORT = 8788;

async function loadCues(path) {
  if (path) return JSON.parse(readFileSync(path, 'utf8'));
  const out = [];
  let offset = 0;
  for (const id of SAMPLE_IDS) {
    const r = await fetch(`${BASE}/subs/${id}/bilingual.json`);
    if (!r.ok) throw new Error(`抓不到 ${id} 的 bilingual.json（${r.status}）`);
    const d = await r.json();
    // ⚠ 串接多支片一定要位移時間軸 —— player 的 findCue 是二分搜尋，
    // 時間軸不遞增就會找錯句。第一版沒位移，結果 28% 的取樣量到的是別句
    for (const c of d.cues) out.push({ ...c, en: c.orig ?? c.en, start: c.start + offset, end: c.end + offset });
    offset = out[out.length - 1].end + 5;
  }
  return out;
}

// player.ts 是 TS，先 bundle 成 ESM 才能在 node 裡 import
function bundlePlayer() {
  const dir = mkdtempSync(join(tmpdir(), 'layout-'));
  const out = join(dir, 'player.mjs');
  execFileSync('npx', ['esbuild', 'src/player.ts', '--bundle', '--format=esm', '--charset=utf8', `--outfile=${out}`, '--log-level=error']);
  return out;
}

// 假的 YT.Player：iframe API 連不到（也不該連），但 tick() 只需要 getCurrentTime
const STUB = () => {
  window.__t = 0;
  window.YT = {
    Player: function () {
      return {
        getCurrentTime: () => window.__t,
        seekTo(t) { window.__t = t; },
        getPlaybackQuality: () => 'hd1080',
        setPlaybackRate() {}, playVideo() {}, setOption() {}, unloadModule() {}, loadModule() {},
      };
    },
  };
};

async function scenario(browser, name, ctxOpts, mode, prev, budget, step) {
  const ctx = await browser.newContext(ctxOpts);
  const page = await ctx.newPage();
  await page.route('**/iframe_api*', (r) => r.abort());
  await page.addInitScript(STUB);
  await page.addInitScript(
    ([m, p]) => localStorage.setItem('ytplayer-settings', JSON.stringify({ mode: m, prev: p, notes: true })),
    [mode, prev]
  );
  await page.goto(`http://127.0.0.1:${PORT}/watch/ksfm6jeTg3Q`, { waitUntil: 'load' });
  await page.evaluate(() => window.onYouTubeIframeAPIReady && window.onYouTubeIframeAPIReady());
  await page.waitForTimeout(400);

  const res = await page.evaluate(
    async ([budget, step]) => {
      // ⚠ 不是數 rects 的個數 —— 一行裡夾英文會切成好幾個文字框（見 player.ts 的同名函式）
      const L = (s) => {
        const el = document.querySelector(s);
        if (!el || !el.textContent || !el.offsetHeight) return 0;
        const r = document.createRange();
        r.selectNodeContents(el);
        const lh = parseFloat(getComputedStyle(el).lineHeight) || 16;
        const tops = [];
        for (const rect of r.getClientRects()) {
          if (!tops.some((t) => Math.abs(t - rect.top) < lh * 0.5)) tops.push(rect.top);
        }
        return Math.max(1, tops.length);
      };
      const cues = await (await fetch('/subs/x/bilingual.json')).json().then((d) => d.cues);
      const out = { n: 0, over: 0, prevShown: 0, tight: 0, maxLines: 0, missed: 0, hist: {} };
      for (let i = 0; i < cues.length; i += step) {
        window.__t = cues[i].start + 0.1;
        // tick 每 150ms 才跑一次 —— **一定要等畫面真的換成這一句再量**，
        // 否則量到的是上一句：第一版 harness 就是這樣，同一份程式跑出 22% 和 38% 兩種結果
        // 認「中文 + 原文」兩個欄位都吻合才算換到位 —— 只認中文會被重複的短句
        // （「是。」這種）騙過去，量到的其實是上一句
        let ok = false;
        for (let w = 0; w < 40 && !ok; w++) {
          await new Promise((r) => setTimeout(r, 20));
          ok = document.querySelector('#subZh').textContent === cues[i].zh &&
               document.querySelector('#subEn').textContent === (cues[i].en || '');
        }
        if (!ok) { out.missed++; continue; }
        const used = L('#subPrev') + L('#subEn') + L('#subZh') + L('#subNote');
        if (!used) continue;
        out.n++;
        if (used > budget) {
          out.over++;
          (out.samples ||= []).push({ prev: L('#subPrev'), en: L('#subEn'), zh: L('#subZh'), note: L('#subNote'),
            tight: document.body.classList.contains('tight'),
            zhText: cues[i].zh.slice(0, 30), noteText: (cues[i].note || '').slice(0, 30) });
        }
        if (L('#subPrev')) out.prevShown++;
        if (document.body.classList.contains('tight')) out.tight++;
        out.maxLines = Math.max(out.maxLines, used);
        out.hist[used] = (out.hist[used] || 0) + 1;
      }
      return out;
    },
    [budget, step]
  );
  const pct = (x) => `${((x / res.n) * 100).toFixed(0)}%`;
  console.log(
    `${name.padEnd(24)} 預算${budget}  n=${res.n}  超支 ${pct(res.over)}  最多${res.maxLines}行  ` +
      `前一句 ${pct(res.prevShown)}  縮字級 ${pct(res.tight)}  分布 ${JSON.stringify(res.hist)}` +
      (res.missed ? `  （${res.missed} 句沒等到，未計入）` : '')
  );
  if (process.env.DEBUG_OVER && res.samples) for (const x of res.samples) console.log('    超支樣本', JSON.stringify(x));
  await ctx.close();
  return res;
}

async function main() {
  const cues = await loadCues(process.argv[2]);
  const { watchPage } = await import(bundlePlayer());
  const server = createServer((req, res) => {
    if (req.url.includes('bilingual.json')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ videoId: 'ksfm6jeTg3Q', schema: 2, route: 'text', meta: { title: 'layout-check' }, cues, warnings: [], hints: [] }));
    }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(watchPage('ksfm6jeTg3Q'));
  });
  await new Promise((r) => server.listen(PORT, r));

  // 每 N 句取樣一次：每句都要等 tick 換頁，全掃太慢而分布不會變
  const step = Number(process.env.STEP || 6);
  console.log(`真實語料 ${cues.length} 句，每 ${step} 句取樣一次\n`);
  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM || '/opt/pw-browsers/chromium' });
  const DESK = { viewport: { width: 1440, height: 900 } };
  const rows = [
    ['桌機・雙語', DESK, 0, 'auto', 4],
    ['桌機・只中文', DESK, 1, 'auto', 4],
    ['桌機・雙語・前一句常開', DESK, 0, 'on', 4],
    ['桌機・雙語・前一句關', DESK, 0, 'off', 4],
    ['手機直向・雙語', devices['iPhone 13'], 0, 'auto', 3],
    ['手機直向・只中文', devices['iPhone 13'], 1, 'auto', 3],
    ['手機橫向・雙語', devices['iPhone 13 landscape'], 0, 'auto', 2],
    ['手機橫向・只中文', devices['iPhone 13 landscape'], 1, 'auto', 2],
  ];
  for (const [name, ctxOpts, mode, prev, budget] of rows) {
    await scenario(browser, name, ctxOpts, mode, prev, budget, step);
  }
  await browser.close();
  server.close();
}

main().catch((e) => {
  console.error('FAILED:', e.message);
  process.exit(1);
});
