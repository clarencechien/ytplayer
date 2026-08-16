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
import { listVideos, routeSource, toSrt } from './pipeline';
import { handleJob, watchdog, readDailyBudget, type JobMsg, type MsgLike, type WatchRequest } from './jobs';
import { watchPage, indexPage, adminPage, sharePage } from './player';

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

    const keyConfigured = typeof env.INGEST_KEY === 'string' && env.INGEST_KEY.length > 0;
    // 兩種認證並存（migration.md §5）：人用 Cloudflare Access（SSO 後注入 email header）、程式用 key
    const accessEmail = req.headers.get('cf-access-authenticated-user-email');
    const accessOk = !!env.ALLOWED_EMAIL && accessEmail === env.ALLOWED_EMAIL;
    const authorized =
      !keyConfigured ||
      req.headers.get('x-ingest-key') === env.INGEST_KEY ||
      url.searchParams.get('key') === env.INGEST_KEY ||
      accessOk;
    const warning = keyConfigured ? undefined : '尚未設定 INGEST_KEY secret，任何人都可寫入';

    const html = (body: string) =>
      new Response(body, { headers: { 'content-type': 'text/html; charset=utf-8', ...BASE } });

    if (req.method === 'GET' && path === '/health') {
      // 今日花費隨時可見（成本事故的教訓：看不見的花費才是危險的花費）
      const budget = await readDailyBudget(env);
      const dailyCap = Number(env.DAILY_TOKEN_CAP) > 0 ? Number(env.DAILY_TOKEN_CAP) : 2_000_000;
      return json({
        service: 'ytplayer',
        ok: true,
        ingestKeyConfigured: keyConfigured,
        today: { tokens: budget.tokens, llmCalls: budget.calls, dailyCapTokens: dailyCap },
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

      const jobs: Array<Record<string, unknown>> = [];
      for (const p of prefixes) {
        const videoId = p.slice('subs/'.length).replace(/\/$/, '');
        if (!/^[A-Za-z0-9_-]{11}$/.test(videoId)) continue;
        const stObj = await env.SUBS.get(`subs/${videoId}/status.json`);
        if (!stObj) continue;
        const st = JSON.parse(await stObj.text()) as Record<string, unknown> & { title?: string; tokensUsed?: number };
        let title = st.title;
        if (!title) {
          const info = await env.SUBS.get(`subs/${videoId}/info.json`);
          if (info) title = (JSON.parse(await info.text()) as { title?: string }).title;
        }
        jobs.push({
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
          warningCount: Array.isArray(st.warnings) ? st.warnings.length : 0,
          // 未譯句數：使用者不該在看片時才發現（docs/patch-untranslated.md P2）
          untranslated: (st.untranslated as number) ?? 0,
          patchRounds: (st.patchRounds as number) ?? 0,
        });
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

    // 補譯（docs/patch-untranslated.md）：只重譯未譯／原文照抄的那幾句，不重跑整片。
    // 正常情況 assemble 完會自己排，這個端點是手動補刀（含舊片）。
    const pt = path.match(/^\/patch\/([A-Za-z0-9_-]{11})$/);
    if (req.method === 'POST' && pt) {
      if (!authorized) return json({ ok: false, error: 'unauthorized' }, 403);
      if (!env.JOBS) return json({ ok: false, error: 'JOBS queue 未綁定' }, 500);
      const videoId = pt[1];
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
      await env.JOBS.send({ videoId, step: 'patch' });
      return json({ ok: true, accepted: videoId, note: '補譯已排入，進度看 /subs/{videoId}/status.json' }, 202);
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

    const FILES = [
      'source.json',
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
    if (req.method === 'GET' && m && FILES.includes(m[2])) {
      const obj = await env.SUBS.get(`subs/${m[1]}/${m[2]}`);
      if (!obj) return json({ ok: false, error: 'not found' }, 404);
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
