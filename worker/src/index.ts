// ytplayer Worker — ingest（收 ext 送來的字幕）→ Queues 翻譯 pipeline → R2 → player 頁。
//
// 端點：
//   POST /ingest                        收 payload，存 R2 並 enqueue 翻譯
//   POST /translate/{id}[?force=1]      手動排入翻譯（force 會清掉失敗標記重跑）
//   GET  /watch/{id}                    player 頁（公開 — videoId 是 YouTube 公開資訊）
//   GET  /subs/{id}/{file}              字幕與狀態檔（公開白名單）
//   GET  /videos.json?key=              清單 = 觀看紀錄，要 key
//   POST /inbox                         手機送片：排入「待補字幕」佇列（key）
//   GET  /inbox.json                    待補清單（key）— ext popup 與清單頁共用
//   GET  /health /robots.txt /manifest.webmanifest /sw.js /share   公開
//
// 認證：wrangler secret `INGEST_KEY` — 人用 ?key=、程式用 x-ingest-key header。
// 執行：LLM 工作只在 queue consumer 跑（fetch handler 跑不了長工作 — 實測會被砍，
// 見 asr-language-experiment.md §4）；cron 是零成本看門狗。

import { validateIngest } from './validate';
import { retimeCues, type RetimeCue } from './retime';
import { listVideos, routeSource, toSrt, countCpsOver, LIST_CONCURRENCY } from './pipeline';
import { handleJob, watchdog, readDailyBudget, type JobMsg, type MsgLike, type PatchMode, type WatchRequest } from './jobs';
import { watchPage, indexPage, adminPage, sharePage } from './player';
import {
  turnstileConfigured,
  challengePage,
  siteverify,
  issuePass,
  passValid,
  passCookie,
  readCookie,
  safeNext,
  PASS_COOKIE,
} from './turnstile';
import { accessEmail } from './access';

export interface Env {
  SUBS: R2Bucket;
  JOBS: Queue<JobMsg>;
  INGEST_KEY?: string;
  GEMINI_API_KEY?: string;
  GEMINI_MODEL?: string;
  GEMINI_MEDIA_RES?: string;
  GEMINI_THINKING_BUDGET?: string;
  VIDEO_TOKEN_CAP?: string;
  WATCH_TOKEN_CAP?: string;
  DAILY_TOKEN_CAP?: string;
  COST_IN_NTD_PER_M?: string; // 輸入費率 NT$/M tokens（預設 47 ≈ $1.50×31）
  COST_OUT_NTD_PER_M?: string; // 輸出費率 NT$/M tokens（預設 280 ≈ $9.00×31；thinking 計此價）
  COST_NTD_PER_M?: string; // 舊：單一混合費率，設了就蓋過雙費率
  ALLOWED_EMAIL?: string; // Cloudflare Access 使用者白名單（/admin 的人用認證；程式仍用 key）
  // Access 的 JWT 驗簽材料。兩個都設齊才會採信 Access；缺任一個 = 只認 key。
  // ACCESS_TEAM 是團隊名（<這一段>.cloudflareaccess.com），
  // ACCESS_AUD 是該 Application 的 Audience (AUD) Tag（64 位十六進位）。
  ACCESS_TEAM?: string;
  ACCESS_AUD?: string;
  // Turnstile（隱私第三層）：兩個都設才生效。**site key 也要用 Secret 存** ——
  // dashboard 的明文變數會被 git 部署蓋掉（硬規則 #1 的 var-stomping）
  TURNSTILE_SITE_KEY?: string;
  TURNSTILE_SECRET?: string;
}

// ext popup 與 player 頁都以跨域 fetch 存取，統一開 CORS，安全性由 key 把關。
// x-robots-tag：全站 noindex（清單有 key 擋，但 /watch 與 /subs 公開 — 連結一旦外流
// 就會被搜尋引擎收錄，「我看過哪些影片」變成可搜尋的。artifacts 事件的預防，migration.md §5）
const BASE: Record<string, string> = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET,POST,OPTIONS',
  'access-control-allow-headers': 'content-type,x-ingest-key',
  'x-robots-tag': 'noindex, nofollow, noarchive',
};

// HTML 頁面的安全標頭，刻意分成**兩段**：
//
// 1. 強制執行的：這幾條**不可能弄壞 YouTube 內嵌播放器** ——
//    它們管的是「別人能不能框我們」「表單往哪送」「有沒有 plugin/base 標籤」，
//    跟載入 iframe API 無關，所以在容器裡驗得完、可以直接上。
// 2. Report-Only 的：default-src/script-src/connect-src… 這幾條才是真正的縱深防禦
//    （connect-src 與 img-src 限制**出口** —— 就算被塞進一段 script，金鑰也送不出去），
//    但它們一旦寫錯就是「播放器靜默壞掉」。
//    ⚠ 這個容器的 proxy 擋掉了瀏覽器對 youtube.com 的連線（curl 可以、Chromium 不行，
//    ERR_CONNECTION_RESET），所以**在這裡驗不了 youtube.com 那幾條**。
//    沒驗過的東西不強制執行 —— 先 Report-Only，人在真瀏覽器開 /watch 看 console
//    沒有 violation 之後，再把它併進上面那段（docs/privacy-hardening.md §5）。
const CSP_ENFORCED = ["object-src 'none'", "base-uri 'none'", "form-action 'none'", "frame-ancestors 'none'"].join('; ');
const CSP_CANDIDATE = [
  "default-src 'self'",
  // 整頁 JS 是內嵌的，所以還需要 'unsafe-inline'；要拿掉得先改 nonce + 拆掉 admin 的 inline onclick
  "script-src 'self' 'unsafe-inline' https://www.youtube.com https://s.ytimg.com",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "font-src 'self'",
  "frame-src https://www.youtube.com https://www.youtube-nocookie.com",
  "connect-src 'self' https://www.youtube.com",
  CSP_ENFORCED,
].join('; ');

export const PAGE_SEC: Record<string, string> = {
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'content-security-policy': CSP_ENFORCED,
  'content-security-policy-report-only': CSP_CANDIDATE,
};

// --- 爬蟲閘門（不需要 Cloudflare dashboard 的那一層）---
//
// 威脅模型：連結外流 → 「我看過哪些影片」變成可搜尋的（migration.md §5）。
// 已有的防線是 noindex；這層擋的是**不理會 noindex 的抓取者**（LLM 語料爬蟲、
// 內容農場、通用 scraper）。UA 可以偽造，所以這是提高成本、不是保證。
//
// ⚠ 關鍵取捨：**正牌搜尋引擎必須放行**。把 Googlebot 擋在門外，它就讀不到
// `X-Robots-Tag: noindex` —— 反而可能只憑外部連結把網址收進索引（這正是
// 「robots.txt 用 Disallow 會害死自己」的同一個陷阱，見 migration.md §5）。
// 所以：正牌搜尋引擎放行讓它看見 noindex，其餘自稱爬蟲的一律擋。
const SEARCH_ENGINES = /googlebot|bingbot|slurp|duckduckbot|baiduspider|yandexbot|applebot/i;
const UNWANTED_BOTS =
  /gptbot|oai-searchbot|chatgpt-user|ccbot|claudebot|anthropic-ai|perplexitybot|bytespider|amazonbot|meta-externalagent|facebookbot|imagesiftbot|dataforseobot|semrushbot|ahrefsbot|mj12bot|dotbot|petalbot|scrapy|python-requests|python-urllib|go-http-client|libwww-perl|httrack|wget\b|node-fetch|axios\/|okhttp|java\/|headlesschrome|phantomjs|puppeteer|playwright/i;

export function botVerdict(ua: string): 'allow' | 'search-engine' | 'block' {
  if (SEARCH_ENGINES.test(ua)) return 'search-engine'; // 放行，讓它讀到 noindex 後自己撤掉
  if (!ua.trim()) return 'block'; // 沒有 UA 的一律擋：瀏覽器不會這樣
  return UNWANTED_BOTS.test(ua) ? 'block' : 'allow';
}

const json = (data: unknown, status = 200): Response =>
  new Response(JSON.stringify(data, null, 2), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', ...BASE },
  });

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    const path = url.pathname.replace(/\/+$/, '') || '/'; // 尾端斜線容錯

    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: BASE });

    // 爬蟲閘門只擋「頁面」：/subs 與 API 不擋 —— 它們要嘛需要 key，要嘛需要先知道 videoId，
    // 而且 player 頁與本機工具都得抓得到。擋頁面就足以讓爬蟲爬不到影片清單與字幕內容。
    const isPage = path === '/' || path === '/admin' || path === '/share' || /^\/watch\/[A-Za-z0-9_-]{11}$/.test(path);

    const keyConfigured = typeof env.INGEST_KEY === 'string' && env.INGEST_KEY.length > 0;

    // 兩種認證並存（migration.md §5）：人用 Cloudflare Access、程式用 key。
    //
    // ⚠ 2026-09-04 修正：這裡原本直接比對 `cf-access-authenticated-user-email` header，
    // 而且套用在**所有路徑**上。但 Access application 只蓋 /admin/*，而 Access 沒有蓋到的
    // 路徑，Cloudflare 不會幫你把使用者自己送的同名 header 拿掉 —— 等於任何人送一個
    // header 就拿到 INGEST_KEY 等級的權限（寫入、觸發 LLM、讀瀏覽紀錄），而 owner email
    // 是公開的 git author。現在改成兩道：只在 /admin 路徑採信，而且驗 JWT 簽章。
    const isAdminPath = path === '/admin' || path.startsWith('/admin/');
    const accessUser = isAdminPath ? await accessEmail(req, env) : null;
    const accessOk = !!env.ALLOWED_EMAIL && accessUser === env.ALLOWED_EMAIL;

    // key 認證。`?key=` **只認頁面路由**：瀏覽器設不了 header，清單頁需要它 bootstrap
    //（頁面會立刻把它收進 localStorage 並從網址清掉）。但 API 不該接受網址帶 key ——
    // 那會把金鑰留在瀏覽紀錄、分享出去的連結、Referer 與各層日誌裡。
    //
    // ⚠ 同一輪修正：原本是 `!keyConfigured || ...`，也就是 INGEST_KEY 沒設時**全部放行**，
    // 所有付費端點與瀏覽紀錄對外全開，而 /health 又不再對外顯示這個狀態 —— 掉了 secret
    // 是靜默的。改成 fail-closed：沒設 key 就沒有 key 認證這條路。
    const keyOk =
      keyConfigured &&
      (req.headers.get('x-ingest-key') === env.INGEST_KEY ||
        (isPage && url.searchParams.get('key') === env.INGEST_KEY));

    const authorized = keyOk || accessOk;
    const warning = keyConfigured ? undefined : '尚未設定 INGEST_KEY secret，需要授權的端點一律拒絕';

    const html = (body: string) =>
      new Response(body, { headers: { 'content-type': 'text/html; charset=utf-8', ...PAGE_SEC, ...BASE } });
    const verdict = botVerdict(req.headers.get('user-agent') ?? '');
    if (req.method === 'GET' && isPage && verdict === 'block') {
      return new Response('Not available to automated clients.\n', {
        status: 403,
        headers: { 'content-type': 'text/plain; charset=utf-8', ...BASE },
      });
    }

    // Turnstile 通行證回收端點（頁面上的 widget 過關後打這裡換 cookie）
    if (req.method === 'POST' && path === '/turnstile/verify') {
      if (!turnstileConfigured(env)) return json({ ok: false, error: 'turnstile 未設定' }, 400);
      const body = (await req.json().catch(() => ({}))) as { token?: unknown; next?: unknown };
      const ok =
        typeof body.token === 'string' &&
        (await siteverify(env.TURNSTILE_SECRET!, body.token, req.headers.get('cf-connecting-ip')));
      if (!ok) return json({ ok: false, error: '驗證未通過' }, 403);
      return new Response(JSON.stringify({ ok: true, next: safeNext(body.next) }), {
        headers: {
          'content-type': 'application/json; charset=utf-8',
          'set-cookie': passCookie(await issuePass(env.TURNSTILE_SECRET!)),
          ...BASE,
        },
      });
    }

    // 隱私第三層（docs/privacy-hardening.md §3）：頁面要先過 Turnstile。
    // 四種情況直接放行：沒設定、正牌搜尋引擎（要讓它讀到 noindex）、自己人（key/Access）、已有通行證
    if (req.method === 'GET' && isPage && turnstileConfigured(env) && verdict !== 'search-engine' && !authorized) {
      const pass = readCookie(req.headers.get('cookie'), PASS_COOKIE);
      if (!(await passValid(env.TURNSTILE_SECRET!, pass))) {
        return html(challengePage(env.TURNSTILE_SITE_KEY!, url.pathname + url.search));
      }
    }

    if (req.method === 'GET' && path === '/health') {
      // 今日花費隨時可見（成本事故的教訓：看不見的花費才是危險的花費）
      const budget = await readDailyBudget(env);
      const dailyCap = Number(env.DAILY_TOKEN_CAP) > 0 ? Number(env.DAILY_TOKEN_CAP) : 2_000_000;
      // 公開的只有「這是不是 ytplayer、活著沒」—— ext 的分層診斷只需要這兩個。
      // 用量與設定旗標要 key：今日翻了幾支、花了多少 token 是營運資訊，
      // 而 ingestKeyConfigured=false 更是直接告訴人「這站現在誰都能寫」
      return json({
        service: 'ytplayer',
        ok: true,
        ...(authorized
          ? {
              ingestKeyConfigured: keyConfigured,
              // 兩個都設才會生效 —— 部署後先看這行確認 Secret 有進來（明文變數會被部署蓋掉）
              turnstileConfigured: turnstileConfigured(env),
              today: { tokens: budget.tokens, llmCalls: budget.calls, dailyCapTokens: dailyCap },
            }
          : {}),
      });
    }
    // 陷阱提醒：robots.txt 不能 Disallow — 擋了爬取，爬蟲就看不到 noindex 標頭，
    // URL 仍會以「無內容連結」形式進索引。正確組合 = 允許抓 + 全站 noindex。
    if (req.method === 'GET' && path === '/robots.txt') {
      return new Response('User-agent: *\nAllow: /\n', {
        headers: { 'content-type': 'text/plain; charset=utf-8', ...BASE },
      });
    }
    // kvsplayer 舊連結相容：/?v={id} → /watch/{id}
    const oldV = url.searchParams.get('v');
    if (req.method === 'GET' && path === '/' && oldV && /^[A-Za-z0-9_-]{11}$/.test(oldV)) {
      return Response.redirect(`${url.origin}/watch/${oldV}`, 302);
    }
    if (req.method === 'GET' && path === '/manifest.webmanifest') {
      return new Response(
        JSON.stringify({
          name: 'ytplayer — 雙語字幕',
          short_name: 'ytplayer',
          start_url: '/',
          scope: '/',
          display: 'standalone',
          background_color: '#0f1115',
          theme_color: '#0f1115',
          icons: [192, 512].map((size) => ({ src: `/icon-${size}.png`, sizes: `${size}x${size}`, type: 'image/png', purpose: 'any maskable' })),
          // Android：YouTube app 分享 → 選 ytplayer → 進 /share（iOS PWA 不支援，用貼上框）
          share_target: { action: '/share', method: 'GET', params: { title: 'title', text: 'text', url: 'url' } },
        }),
        { headers: { 'content-type': 'application/manifest+json; charset=utf-8', ...BASE } }
      );
    }
    // 極簡 service worker：只為了取得「可安裝」資格 — 刻意不快取（快取失效的維運成本 > 自用收益）
    if (req.method === 'GET' && path === '/sw.js') {
      return new Response("self.addEventListener('fetch', function () {});\n", {
        headers: { 'content-type': 'application/javascript; charset=utf-8', ...BASE },
      });
    }
    // 單色 PNG 圖示（避免外部依賴；1x1 放大由瀏覽器處理）
    const ico = path.match(/^\/icon-(192|512)\.png$/);
    if (req.method === 'GET' && ico) {
      const png = Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=='), (c) => c.charCodeAt(0));
      return new Response(png, { headers: { 'content-type': 'image/png', 'cache-control': 'public, max-age=86400', ...BASE } });
    }
    if (req.method === 'GET' && path === '/share') return html(sharePage());
    if (req.method === 'GET' && path === '/') return html(indexPage());
    // 看片路線的人用入口（貼連結）。建議再套 Cloudflare Access 蓋 /admin/*
    if (req.method === 'GET' && path === '/admin') return html(adminPage());
    // 清單 = 觀看紀錄，不對外
    if (req.method === 'GET' && path === '/videos.json') {
      if (!authorized) return json({ ok: false, error: 'unauthorized' }, 403);
      return json(await listVideos(env));
    }
    // 營運儀表板資料（admin 頁用）：所有 job 狀態 + 今日花費 + 費用估算。一頁看完，不通靈。
    if (req.method === 'GET' && path === '/jobs.json') {
      if (!authorized) return json({ ok: false, error: 'unauthorized' }, 403);
      // 雙費率估算（NT$/百萬 tokens）：預設對應 gemini-3.5-flash 官方牌價 $1.50/$9.00 × 31 匯率
      //（thinking 計輸出價 — 所以關思考省的都是貴的那種）。對照帳單後可用 vars 調準。
      const inRate = Number(env.COST_IN_NTD_PER_M) > 0 ? Number(env.COST_IN_NTD_PER_M) : 47;
      const outRate = Number(env.COST_OUT_NTD_PER_M) > 0 ? Number(env.COST_OUT_NTD_PER_M) : 280;
      const rate = Number(env.COST_NTD_PER_M) > 0 ? Number(env.COST_NTD_PER_M) : 0; // 舊單費率：設了就蓋過雙費率
      const est = (total: number, prompt?: number): number => {
        const cost =
          rate > 0 || prompt == null
            ? (total / 1e6) * (rate || 140) // 無拆解資料時用混合費率（60/40 in-out ≈ 140）
            : (prompt / 1e6) * inRate + ((total - prompt) / 1e6) * outRate;
        return Math.round(cost * 100) / 100;
      };
      const budget = await readDailyBudget(env);
      const dailyCap = Number(env.DAILY_TOKEN_CAP) > 0 ? Number(env.DAILY_TOKEN_CAP) : 2_000_000;

      const prefixes: string[] = [];
      let cursor: string | undefined;
      do {
        const res = await env.SUBS.list({ prefix: 'subs/', delimiter: '/', cursor });
        prefixes.push(...(res.delimitedPrefixes ?? []));
        cursor = res.truncated ? res.cursor : undefined;
      } while (cursor);

      // 與 listVideos 同一個問題：一支影片至少一次 R2 GET，循序跑就是 N 趟來回。
      // 儀表板還更貴 —— 舊片要回填就得讀 bilingual.json（好幾 MB）。分批並行
      const ids = prefixes
        .map((p) => p.slice('subs/'.length).replace(/\/$/, ''))
        .filter((id) => /^[A-Za-z0-9_-]{11}$/.test(id));
      const one = async (videoId: string): Promise<Record<string, unknown> | null> => {
        const stObj = await env.SUBS.get(`subs/${videoId}/status.json`);
        if (!stObj) return null;
        const st = JSON.parse(await stObj.text()) as Record<string, unknown> & { title?: string; tokensUsed?: number };
        let title = st.title;
        if (!title) {
          const info = await env.SUBS.get(`subs/${videoId}/info.json`);
          if (info) title = (JSON.parse(await info.text()) as { title?: string }).title;
        }
        // 舊片的 status.json 沒有 untranslated／cpsOver 欄位（那時還沒這些功能）→ 從 bilingual.json
        // 回填一次就好，否則儀表板永遠看不到既有影片的問題句
        //（docs/patch-untranslated.md P2、docs/subtitle-readability.md R4b）
        if ((st.untranslated === undefined || st.cpsOver === undefined || st.doneAt === undefined) && st.stage === 'done') {
          const bil = await env.SUBS.get(`subs/${videoId}/bilingual.json`);
          if (bil) {
            const doc = JSON.parse(await bil.text()) as {
              generatedAt?: string;
              cues?: Array<{ start: number; end: number; zh: string; untranslated?: boolean }>;
            };
            st.untranslated = (doc.cues ?? []).filter((c) => c.untranslated).length;
            st.cpsOver = countCpsOver(doc.cues ?? []);
            // bilingual 的 generatedAt 就是「這支片翻完的時刻」，舊片也有 —— 拿它當耗時的終點
            st.doneAt = doc.generatedAt ?? st.updatedAt;
            await env.SUBS.put(`subs/${videoId}/status.json`, JSON.stringify(st), {
              httpMetadata: { contentType: 'application/json' },
            });
          }
        }
        return {
          videoId,
          title: title ?? videoId,
          route: st.route,
          stage: st.stage,
          step: st.step,
          failed: st.failed ?? false,
          failReason: st.failReason,
          tokensUsed: st.tokensUsed ?? 0,
          llmCalls: st.llmCalls ?? 0,
          thoughtTokens: st.thoughtTokens ?? 0,
          estNTD: est((st.tokensUsed as number) ?? 0, st.promptTokens as number | undefined),
          startedAt: st.startedAt,
          updatedAt: st.updatedAt,
          doneAt: st.doneAt, // 耗時要用它，不是 updatedAt（補譯會推進 updatedAt）

          warningCount: Array.isArray(st.warnings) ? st.warnings.length : 0,
          // 未譯句數：使用者不該在看片時才發現（docs/patch-untranslated.md P2）
          untranslated: (st.untranslated as number) ?? 0,
          // 讀不完的句數：舊片也算得出來，所以事後也修得掉（docs/subtitle-readability.md R4b）
          cpsOver: (st.cpsOver as number) ?? 0,
          patchRounds: (st.patchRounds as number) ?? 0,
        };
      };
      const jobs: Array<Record<string, unknown>> = [];
      for (let i = 0; i < ids.length; i += LIST_CONCURRENCY) {
        const batch = await Promise.all(ids.slice(i, i + LIST_CONCURRENCY).map(one));
        for (const j of batch) if (j) jobs.push(j);
      }
      // 進行中在最上、失敗次之、完成的按時間新到舊
      const rank = (j: Record<string, unknown>) => (j.failed ? 1 : j.stage === 'done' ? 2 : 0);
      jobs.sort((a, b) => rank(a) - rank(b) || String(b.updatedAt).localeCompare(String(a.updatedAt)));

      return json({
        ok: true,
        rateNTDPerM: rate > 0 ? rate : `in ${inRate} / out ${outRate}`,
        today: {
          tokens: budget.tokens,
          llmCalls: budget.calls,
          dailyCapTokens: dailyCap,
          estNTD: est(budget.tokens), // 日預算檔沒有 in/out 拆解 → 混合費率

        },
        jobs,
      });
    }
    const w = path.match(/^\/watch\/([A-Za-z0-9_-]{11})$/);
    if (req.method === 'GET' && w) return html(watchPage(w[1]));

    // --- PWA 手機送片：inbox 待補佇列（docs/pwa-plan.md）---
    // 手機沒有 ext（無法攔截字幕），所以只排隊、不抓字幕；桌機 ext 開瀏覽器時補收。
    // inbox = 觀看「意圖」，比觀看紀錄更私密 → 一律 key-gated。
    if (req.method === 'POST' && path === '/inbox') {
      if (!authorized) return json({ ok: false, error: 'unauthorized' }, 403);
      let body: Record<string, unknown> = {};
      try {
        body = (await req.json()) as Record<string, unknown>;
      } catch {
        /* 也允許 ?url= */
      }
      const raw = String(body.url ?? url.searchParams.get('url') ?? '');
      const m2 = raw.match(/(?:v=|youtu\.be\/|shorts\/|embed\/)?([A-Za-z0-9_-]{11})(?:[?&#]|$)/);
      if (!m2) return json({ ok: false, error: '無法從連結解析出影片 ID' }, 400);
      const videoId = m2[1];
      // 已經有字幕/來源了就不用排（避免手機重複送同一支）
      if (await env.SUBS.head(`subs/${videoId}/bilingual.json`)) {
        return json({ ok: true, videoId, already: 'translated', watch: `${url.origin}/watch/${videoId}` });
      }
      if (await env.SUBS.head(`subs/${videoId}/source.json`)) {
        return json({ ok: true, videoId, already: 'ingested', watch: `${url.origin}/watch/${videoId}` });
      }
      await env.SUBS.put(
        `inbox/${videoId}.json`,
        JSON.stringify({
          videoId,
          url: `https://www.youtube.com/watch?v=${videoId}`,
          requestedAt: new Date().toISOString(),
          via: typeof body.via === 'string' ? body.via : 'share',
          ...(typeof body.title === 'string' && body.title ? { title: body.title } : {}),
        }),
        { httpMetadata: { contentType: 'application/json' } }
      );
      return json({ ok: true, videoId, queued: true, watch: `${url.origin}/watch/${videoId}` }, 202);
    }
    if (req.method === 'GET' && path === '/inbox.json') {
      if (!authorized) return json({ ok: false, error: 'unauthorized' }, 403);
      const items: Array<Record<string, unknown>> = [];
      let cursor: string | undefined;
      do {
        const res = await env.SUBS.list({ prefix: 'inbox/', cursor });
        for (const o of res.objects) {
          const obj = await env.SUBS.get(o.key);
          if (obj) items.push(JSON.parse(await obj.text()) as Record<string, unknown>);
        }
        cursor = res.truncated ? res.cursor : undefined;
      } while (cursor);
      items.sort((a, b) => String(b.requestedAt ?? '').localeCompare(String(a.requestedAt ?? '')));
      return json({ ok: true, count: items.length, items });
    }
    const del = path.match(/^\/inbox\/([A-Za-z0-9_-]{11})$/);
    if (req.method === 'DELETE' && del) {
      if (!authorized) return json({ ok: false, error: 'unauthorized' }, 403);
      await env.SUBS.delete(`inbox/${del[1]}.json`);
      return json({ ok: true, removed: del[1] });
    }

    if (req.method === 'POST' && path === '/ingest') {
      if (!authorized) return json({ ok: false, error: 'unauthorized' }, 403);
      const text = await req.text();
      if (text.length > 8_000_000) return json({ ok: false, error: 'payload 超過 8MB' }, 413);
      let payload: unknown;
      try {
        payload = JSON.parse(text);
      } catch {
        return json({ ok: false, error: 'JSON 解析失敗' }, 400);
      }
      const errors = validateIngest(payload);
      if (errors.length > 0) return json({ ok: false, errors }, 400);

      const p = payload as { videoId: string; cues: unknown[]; track: { languageCode: string; kind?: string | null } };
      const key = `subs/${p.videoId}/source.json`;
      await env.SUBS.put(key, JSON.stringify({ ...(payload as object), ingestedAt: new Date().toISOString() }), {
        httpMetadata: { contentType: 'application/json' },
      });
      // 補收閉環：這支若在待補佇列裡，ingest 成功即銷帳（docs/pwa-plan.md §4.1）
      await env.SUBS.delete(`inbox/${p.videoId}.json`);
      // ingest 完直接排入翻譯（cron 看門狗只是漏接保險）
      const { route, reason } = routeSource(p);
      if (route !== 'reject') await env.JOBS.send({ videoId: p.videoId, step: 'plan' });
      return json({ ok: true, key, cueCount: p.cues.length, route, ...(reason ? { reason } : {}), warning });
    }

    // video 路由（Gemini 看片）：Tier 3 字卡型韓綜 / Tier 4 無 CC。成本 ~30 倍，永遠是明示選擇。
    // body（皆可省）：{ url?, durationMin?, lang?, title? }；durationMin 給了就關 open 模式（較可靠）
    const wj = path.match(/^\/watch-job\/([A-Za-z0-9_-]{11})$/);
    if (req.method === 'POST' && wj) {
      if (!authorized) return json({ ok: false, error: 'unauthorized' }, 403);
      const videoId = wj[1];
      let body: Record<string, unknown> = {};
      try {
        body = (await req.json()) as Record<string, unknown>;
      } catch {
        /* body 可省略 */
      }
      const reqDoc: WatchRequest = {
        requestedAt: new Date().toISOString(),
        ...(Number(body.durationMin) > 0 ? { durationMin: Number(body.durationMin) } : {}),
        ...(typeof body.lang === 'string' && body.lang ? { lang: body.lang } : {}),
        ...(typeof body.title === 'string' && body.title ? { title: body.title } : {}),
        // glossary channel 鎖定表鍵值（G1）：看片路線沒有頻道 meta，只能由送件者指定
        ...(typeof body.channel === 'string' && /^[\w-]{1,48}$/.test(body.channel) ? { channel: body.channel } : {}),
      };
      await env.SUBS.put(`subs/${videoId}/watch.json`, JSON.stringify(reqDoc), {
        httpMetadata: { contentType: 'application/json' },
      });
      const force = url.searchParams.get('force') === '1';
      await env.JOBS.send({ videoId, step: 'plan', route: 'video', force });
      return json(
        { ok: true, accepted: videoId, route: 'video', note: '看片任務已排入，進度看 /subs/{videoId}/status.json' },
        202
      );
    }

    // B 修正鈕（docs/subtitle-timing.md）：對已翻好的影片重算顯示時間軸 —
    // 零 LLM、不重跑翻譯，冪等可重按。v1（en）與 v2（orig）皆可修。
    const rt = path.match(/^\/retime\/([A-Za-z0-9_-]{11})$/);
    if (req.method === 'POST' && rt) {
      if (!authorized) return json({ ok: false, error: 'unauthorized' }, 403);
      const videoId = rt[1];
      const obj = await env.SUBS.get(`subs/${videoId}/bilingual.json`);
      if (!obj) return json({ ok: false, error: 'bilingual.json 不存在（還沒翻好）' }, 404);
      const doc = JSON.parse(await obj.text()) as Record<string, unknown> & {
        cues: Array<RetimeCue & { en?: string; orig?: string }>;
      };
      const changed = retimeCues(doc.cues);
      doc.retimedAt = new Date().toISOString();
      await env.SUBS.put(`subs/${videoId}/bilingual.json`, JSON.stringify(doc), {
        httpMetadata: { contentType: 'application/json' },
      });
      await env.SUBS.put(
        `subs/${videoId}/bilingual.srt`,
        toSrt(doc.cues.map((c) => ({ start: c.start, end: c.end, en: c.orig ?? c.en ?? '', zh: (c as { zh?: string }).zh ?? '' }))),
        { httpMetadata: { contentType: 'text/plain; charset=utf-8' } }
      );
      return json({ ok: true, videoId, changed, cueCount: doc.cues.length });
    }

    // 補譯（docs/patch-untranslated.md、docs/subtitle-readability.md R4b）：
    // 只重譯有問題的那幾句，不重跑整片。?mode=untranslated（預設）｜cps｜all
    // 正常情況 assemble 完會自己排 untranslated，這個端點是手動補刀（含舊片）。
    const pt = path.match(/^\/patch\/([A-Za-z0-9_-]{11})$/);
    if (req.method === 'POST' && pt) {
      if (!authorized) return json({ ok: false, error: 'unauthorized' }, 403);
      if (!env.JOBS) return json({ ok: false, error: 'JOBS queue 未綁定' }, 500);
      const videoId = pt[1];
      const modeParam = url.searchParams.get('mode') ?? 'untranslated';
      if (!['untranslated', 'cps', 'all'].includes(modeParam)) {
        return json({ ok: false, error: 'mode 只能是 untranslated｜cps｜all' }, 400);
      }
      const mode = modeParam as PatchMode;
      if (!(await env.SUBS.head(`subs/${videoId}/bilingual.json`))) {
        return json({ ok: false, error: 'bilingual.json 不存在（還沒翻好）' }, 404);
      }
      // 手動觸發時把輪數歸零：這是人為動作，允許再給兩輪機會
      const stObj = await env.SUBS.get(`subs/${videoId}/status.json`);
      if (stObj) {
        const st = JSON.parse(await stObj.text()) as Record<string, unknown>;
        st.patchRounds = 0;
        await env.SUBS.put(`subs/${videoId}/status.json`, JSON.stringify(st), {
          httpMetadata: { contentType: 'application/json' },
        });
      }
      await env.JOBS.send({ videoId, step: 'patch', mode });
      return json({ ok: true, accepted: videoId, mode, note: '補譯已排入，進度看 /subs/{videoId}/status.json' }, 202);
    }

    // 手動排入翻譯：非同步（202 即回），進度看 /subs/{id}/status.json
    const t = path.match(/^\/translate\/([A-Za-z0-9_-]{11})$/);
    if (req.method === 'POST' && t) {
      if (!authorized) return json({ ok: false, error: 'unauthorized' }, 403);
      const videoId = t[1];
      const srcObj = await env.SUBS.get(`subs/${videoId}/source.json`);
      if (!srcObj) return json({ ok: false, error: 'source.json 不存在，請先用 ext ingest' }, 404);
      const src = JSON.parse(await srcObj.text()) as { track: { languageCode: string; kind?: string | null } };
      const { route, reason } = routeSource(src);
      if (route === 'reject') return json({ ok: false, error: `不在範圍：${reason}` }, 422);
      const force = url.searchParams.get('force') === '1';
      // ?model= 本輪模型覆寫（A/B 測試用）：只影響這一輪，不動 wrangler 預設
      const modelParam = url.searchParams.get('model') ?? undefined;
      if (modelParam && !/^[a-z0-9.-]{3,50}$/i.test(modelParam)) {
        return json({ ok: false, error: 'model 參數格式錯誤' }, 400);
      }
      await env.JOBS.send({ videoId, step: 'plan', force, ...(modelParam ? { model: modelParam } : {}) });
      return json(
        {
          ok: true,
          accepted: videoId,
          force,
          ...(modelParam ? { model: modelParam } : {}),
          note: '已排入翻譯佇列，進度請看 /subs/{videoId}/status.json',
        },
        202
      );
    }

    // ⚠ **source.json 刻意不在這裡**：它是原始字幕軌加影片描述前 2000 字，
    // player 頁一個欄位都沒用到，卻是公開資料量最大的一份。要拿請帶 key
    //（本機 ab-runner 就是這樣抓的）。docs/privacy-hardening.md §5.5
    const FILES = [
      'sentences.json',
      'glossary.json',
      'bilingual.json',
      'bilingual.srt',
      'info.json',
      'status.json',
      'watch.json',
      'last-run.json', // 舊資料仍可讀（新系統不再寫）
    ];
    const m = path.match(/^\/subs\/([A-Za-z0-9_-]{11})\/([a-z.-]+)$/);
    // 帶 key 的話 source.json 也給（ab-runner 要抓真實語料）
    if (req.method === 'GET' && m && (FILES.includes(m[2]) || (authorized && m[2] === 'source.json'))) {
      const obj = await env.SUBS.get(`subs/${m[1]}/${m[2]}`);
      if (!obj) return json({ ok: false, error: 'not found' }, 404);
      // status.json 要公開（player 頁靠它顯示「翻譯中／失敗」），但它同時帶著
      // 模型名稱、token 用量、以及 **failReason —— 那會帶模型輸出的開頭**。
      // 沒有 key 的人只給進度三欄；自己人（localStorage 有 key）拿得到完整版
      if (m[2] === 'status.json' && !authorized) {
        const st = JSON.parse(await obj.text()) as Record<string, unknown>;
        return json({ videoId: st.videoId, stage: st.stage, step: st.step, failed: st.failed ?? false });
      }
      const contentType = m[2].endsWith('.srt') ? 'text/plain; charset=utf-8' : 'application/json; charset=utf-8';
      return new Response(obj.body, { headers: { 'content-type': contentType, ...BASE } });
    }

    return json({ ok: false, error: 'not found' }, 404);
  },

  // Queue consumer：唯一會花 LLM 錢的地方。保險絲（每片/每日 token 上限、3 次重試
  // 後永久失敗）都在 handleJob 內。
  async queue(batch: MessageBatch, env: Env): Promise<void> {
    for (const msg of batch.messages) {
      const m = msg as unknown as MsgLike;
      // 每訊息頭尾都 log（observability 已開）：步驟死在中途時，「有 start 沒 end」就是證據
      console.log(`job start: ${m.body.videoId} ${m.body.step}${m.body.batch != null ? ':' + m.body.batch : ''} (attempt ${m.attempts})`);
      const t0 = Date.now();
      await handleJob(m, env);
      console.log(`job end: ${m.body.videoId} ${m.body.step} in ${Date.now() - t0}ms`);
    }
  },

  // Cron 看門狗：零成本（只掃描 + enqueue），漏接與斷鏈的 run 由這裡重排
  async scheduled(_ctrl: ScheduledController, env: Env): Promise<void> {
    const r = await watchdog(env);
    if (r.enqueued.length > 0) console.log(`watchdog enqueued: ${r.enqueued.join(', ')}`);
  },
} satisfies ExportedHandler<Env>;
