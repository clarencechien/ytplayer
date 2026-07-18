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
import { runPipeline } from './pipeline';

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

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    const path = url.pathname.replace(/\/+$/, '') || '/'; // 尾端斜線容錯

    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });

    // 讀取公開（字幕非敏感資料，player 頁也要直接讀）；寫入／翻譯才要 key
    const keyConfigured = typeof env.INGEST_KEY === 'string' && env.INGEST_KEY.length > 0;
    const authorized = !keyConfigured || req.headers.get('x-ingest-key') === env.INGEST_KEY;
    const warning = keyConfigured ? undefined : '尚未設定 INGEST_KEY secret，任何人都可寫入';

    if (req.method === 'GET' && path === '/') {
      return json({ service: 'ytplayer', ok: true, ingestKeyConfigured: keyConfigured });
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
      try {
        const { status, body } = await runPipeline(env, t[1], url.searchParams.get('force') === '1');
        return json(body, status);
      } catch (e) {
        return json({ ok: false, error: e instanceof Error ? e.message : String(e) }, 500);
      }
    }

    const FILES = ['source.json', 'sentences.json', 'glossary.json', 'bilingual.json', 'bilingual.srt'];
    const m = path.match(/^\/subs\/([A-Za-z0-9_-]{11})\/([a-z.]+)$/);
    if (req.method === 'GET' && m && FILES.includes(m[2])) {
      const obj = await env.SUBS.get(`subs/${m[1]}/${m[2]}`);
      if (!obj) return json({ ok: false, error: 'not found' }, 404);
      const contentType = m[2].endsWith('.srt') ? 'text/plain; charset=utf-8' : 'application/json; charset=utf-8';
      return new Response(obj.body, { headers: { 'content-type': contentType, ...CORS } });
    }

    return json({ ok: false, error: 'not found' }, 404);
  },
} satisfies ExportedHandler<Env>;
