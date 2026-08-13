// ytplayer Worker — Phase 1 只有 ingest：收 ext 送來的字幕，存 R2。
//
// 端點：
//   POST /ingest                       收 payload，驗證後存 subs/{videoId}/source.json
//   GET  /subs/{videoId}/source.json   讀回（驗收與後續 Phase 用）
//   GET  /                             health / 設定狀態
//
// 認證：wrangler secret `INGEST_KEY`，client 帶 `x-ingest-key` header。
// 未設定 secret 時放行但在回應中警告（讓「連結 GitHub 即可用」成立，設了就鎖）。

import { validateIngest } from './validate';
import { runPipeline, translateNextPending, listVideos } from './pipeline';
import { watchPage, indexPage } from './player';

export interface Env {
  SUBS: R2Bucket;
  INGEST_KEY?: string;
  GEMINI_API_KEY?: string;
  GEMINI_MODEL?: string;
}

// ext popup 與（未來的）player 頁都以跨域 fetch 存取，統一開 CORS，安全性由 key 把關
const CORS: Record<string, string> = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET,POST,OPTIONS',
  'access-control-allow-headers': 'content-type,x-ingest-key',
};

const json = (data: unknown, status = 200): Response =>
  new Response(JSON.stringify(data, null, 2), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', ...CORS },
  });

// 背景執行翻譯並把結果寫進 R2 — 客戶端斷線後仍要跑完（waitUntil），
// 否則長影片必定被「同步請求 5 分鐘斷線 → Worker 被砍」殺掉（實測 686 cues 的日文 ASR）
async function runAndRecord(env: Env, videoId: string, force: boolean, allowAnyAsr: boolean): Promise<void> {
  const startedAt = new Date().toISOString();
  let record: Record<string, unknown>;
  try {
    const { status, body } = await runPipeline(env, videoId, force, undefined, allowAnyAsr);
    record = { startedAt, finishedAt: new Date().toISOString(), status, ...body };
  } catch (e) {
    record = {
      startedAt,
      finishedAt: new Date().toISOString(),
      status: 500,
      ok: false,
      error: e instanceof Error ? e.message : String(e),
    };
  }
  await env.SUBS.put(`subs/${videoId}/last-run.json`, JSON.stringify(record, null, 2), {
    httpMetadata: { contentType: 'application/json' },
  });
}

export default {
  async fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(req.url);
    const path = url.pathname.replace(/\/+$/, '') || '/'; // 尾端斜線容錯

    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });

    // 單片字幕（/watch、/subs）維持公開：videoId 本來就是 YouTube 公開資訊，連結才好分享。
    // 但「影片清單」等於觀看紀錄，要 key —— 瀏覽器沒法帶 header，故同時接受 ?key=
    const keyConfigured = typeof env.INGEST_KEY === 'string' && env.INGEST_KEY.length > 0;
    const authorized =
      !keyConfigured ||
      req.headers.get('x-ingest-key') === env.INGEST_KEY ||
      url.searchParams.get('key') === env.INGEST_KEY;
    const warning = keyConfigured ? undefined : '尚未設定 INGEST_KEY secret，任何人都可寫入';

    const html = (body: string) =>
      new Response(body, { headers: { 'content-type': 'text/html; charset=utf-8', ...CORS } });

    if (req.method === 'GET' && path === '/health') {
      return json({ service: 'ytplayer', ok: true, ingestKeyConfigured: keyConfigured });
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

      const p = payload as { videoId: string; cues: unknown[] };
      const key = `subs/${p.videoId}/source.json`;
      await env.SUBS.put(key, JSON.stringify({ ...(payload as object), ingestedAt: new Date().toISOString() }), {
        httpMetadata: { contentType: 'application/json' },
      });
      return json({ ok: true, key, cueCount: p.cues.length, warning });
    }

    // Phase 2：翻譯 pipeline（同步跑完，20 分鐘影片約 1–2 分鐘）
    const t = path.match(/^\/translate\/([A-Za-z0-9_-]{11})$/);
    if (req.method === 'POST' && t) {
      if (!authorized) return json({ ok: false, error: 'unauthorized' }, 403);
      const videoId = t[1];
      const force = url.searchParams.get('force') === '1';
      const allowAnyAsr = url.searchParams.get('allowAnyAsr') === '1';
      // 預設非同步（ack 即回，工作在背景跑完）；短影片想直接看結果可加 ?wait=1
      if (url.searchParams.get('wait') === '1') {
        try {
          const { status, body } = await runPipeline(env, videoId, force, undefined, allowAnyAsr);
          return json(body, status);
        } catch (e) {
          return json({ ok: false, error: e instanceof Error ? e.message : String(e) }, 500);
        }
      }
      // 先落地豁免標記再開工：即使背景執行被中止，cron 仍會接手把它跑完
      if (allowAnyAsr) {
        await env.SUBS.put(`subs/${videoId}/.allow-any-asr`, new Date().toISOString());
      }
      ctx.waitUntil(runAndRecord(env, videoId, force, allowAnyAsr));
      return json(
        {
          ok: true,
          accepted: videoId,
          note: '已在背景開始翻譯，結果請看 /subs/{videoId}/last-run.json（完成後才會出現/更新）',
        },
        202
      );
    }

    const FILES = ['source.json', 'sentences.json', 'glossary.json', 'bilingual.json', 'bilingual.srt', 'info.json', 'last-run.json'];
    const m = path.match(/^\/subs\/([A-Za-z0-9_-]{11})\/([a-z.-]+)$/);
    if (req.method === 'GET' && m && FILES.includes(m[2])) {
      const obj = await env.SUBS.get(`subs/${m[1]}/${m[2]}`);
      if (!obj) return json({ ok: false, error: 'not found' }, 404);
      const contentType = m[2].endsWith('.srt') ? 'text/plain; charset=utf-8' : 'application/json; charset=utf-8';
      return new Response(obj.body, { headers: { 'content-type': contentType, ...CORS } });
    }

    return json({ ok: false, error: 'not found' }, 404);
  },

  // Cron：自動翻譯佇列。ingest 完什麼都不用做，幾分鐘內自動翻好。
  async scheduled(_ctrl: ScheduledController, env: Env): Promise<void> {
    const r = await translateNextPending(env);
    if (r.translated) console.log(`cron translated ${r.translated} (status ${r.status})`);
  },
} satisfies ExportedHandler<Env>;
