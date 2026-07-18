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

export interface Env {
  SUBS: R2Bucket;
  INGEST_KEY?: string;
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

    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });

    const keyConfigured = typeof env.INGEST_KEY === 'string' && env.INGEST_KEY.length > 0;
    if (keyConfigured && req.headers.get('x-ingest-key') !== env.INGEST_KEY) {
      return json({ ok: false, error: 'unauthorized' }, 403);
    }
    const warning = keyConfigured ? undefined : '尚未設定 INGEST_KEY secret，任何人都可寫入';

    if (req.method === 'GET' && url.pathname === '/') {
      return json({ service: 'ytplayer', ok: true, ingestKeyConfigured: keyConfigured });
    }

    if (req.method === 'POST' && url.pathname === '/ingest') {
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

    const m = url.pathname.match(/^\/subs\/([A-Za-z0-9_-]{11})\/source\.json$/);
    if (req.method === 'GET' && m) {
      const obj = await env.SUBS.get(`subs/${m[1]}/source.json`);
      if (!obj) return json({ ok: false, error: 'not found' }, 404);
      return new Response(obj.body, {
        headers: { 'content-type': 'application/json; charset=utf-8', ...CORS },
      });
    }

    return json({ ok: false, error: 'not found' }, 404);
  },
} satisfies ExportedHandler<Env>;
