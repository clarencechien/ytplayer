// ytplayer Worker — ingest（收 ext 送來的字幕）→ Queues 翻譯 pipeline → R2 → player 頁。
//
// 端點：
//   POST /ingest                        收 payload，存 R2 並 enqueue 翻譯
//   POST /translate/{id}[?force=1]      手動排入翻譯（force 會清掉失敗標記重跑）
//   GET  /watch/{id}                    player 頁（公開 — videoId 是 YouTube 公開資訊）
//   GET  /subs/{id}/{file}              字幕與狀態檔（公開白名單）
//   GET  /videos.json?key=              清單 = 觀看紀錄，要 key
//   GET  /health /robots.txt /          公開
//
// 認證：wrangler secret `INGEST_KEY` — 人用 ?key=、程式用 x-ingest-key header。
// 執行：LLM 工作只在 queue consumer 跑（fetch handler 跑不了長工作 — 實測會被砍，
// 見 asr-language-experiment.md §4）；cron 是零成本看門狗。

import { validateIngest } from './validate';
import { listVideos, routeSource } from './pipeline';
import { handleJob, watchdog, type JobMsg, type MsgLike } from './jobs';
import { watchPage, indexPage } from './player';

export interface Env {
  SUBS: R2Bucket;
  JOBS: Queue<JobMsg>;
  INGEST_KEY?: string;
  GEMINI_API_KEY?: string;
  GEMINI_MODEL?: string;
  VIDEO_TOKEN_CAP?: string;
  DAILY_TOKEN_CAP?: string;
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
    const authorized =
      !keyConfigured ||
      req.headers.get('x-ingest-key') === env.INGEST_KEY ||
      url.searchParams.get('key') === env.INGEST_KEY;
    const warning = keyConfigured ? undefined : '尚未設定 INGEST_KEY secret，任何人都可寫入';

    const html = (body: string) =>
      new Response(body, { headers: { 'content-type': 'text/html; charset=utf-8', ...BASE } });

    if (req.method === 'GET' && path === '/health') {
      return json({ service: 'ytplayer', ok: true, ingestKeyConfigured: keyConfigured });
    }
    // 陷阱提醒：robots.txt 不能 Disallow — 擋了爬取，爬蟲就看不到 noindex 標頭，
    // URL 仍會以「無內容連結」形式進索引。正確組合 = 允許抓 + 全站 noindex。
    if (req.method === 'GET' && path === '/robots.txt') {
      return new Response('User-agent: *\nAllow: /\n', {
        headers: { 'content-type': 'text/plain; charset=utf-8', ...BASE },
      });
    }
    if (req.method === 'GET' && path === '/') return html(indexPage());
    // 清單 = 觀看紀錄，不對外
    if (req.method === 'GET' && path === '/videos.json') {
      if (!authorized) return json({ ok: false, error: 'unauthorized' }, 403);
      return json(await listVideos(env));
    }
    const w = path.match(/^\/watch\/([A-Za-z0-9_-]{11})$/);
    if (req.method === 'GET' && w) return html(watchPage(w[1]));

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
      // ingest 完直接排入翻譯（cron 看門狗只是漏接保險）
      const { route, reason } = routeSource(p);
      if (route !== 'reject') await env.JOBS.send({ videoId: p.videoId, step: 'plan' });
      return json({ ok: true, key, cueCount: p.cues.length, route, ...(reason ? { reason } : {}), warning });
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
      await env.JOBS.send({ videoId, step: 'plan', force });
      return json(
        { ok: true, accepted: videoId, force, note: '已排入翻譯佇列，進度請看 /subs/{videoId}/status.json' },
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
      await handleJob(msg as unknown as MsgLike, env);
    }
  },

  // Cron 看門狗：零成本（只掃描 + enqueue），漏接與斷鏈的 run 由這裡重排
  async scheduled(_ctrl: ScheduledController, env: Env): Promise<void> {
    const r = await watchdog(env);
    if (r.enqueued.length > 0) console.log(`watchdog enqueued: ${r.enqueued.join(', ')}`);
  },
} satisfies ExportedHandler<Env>;
