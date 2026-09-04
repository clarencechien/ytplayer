// fetch handler 的端到端測試（在此之前完全沒有）。
// 起因：2026-09-04 使用者回報 ext 送片「Failed to fetch」，而「Failed to fetch」是
// **沒有狀態碼可看**的那種錯 —— 瀏覽器只在兩種情況這樣報：
//   (a) CORS 預檢沒過（回應沒有 access-control-allow-origin）
//   (b) 連線／Worker 例外，根本沒有 HTTP 回應
// 要把「Worker 端壞了」從「網路層壞了」切開，就得有這層測試。
import { describe, it, expect } from 'vitest';
import worker from '../src/index';
import { FakeR2, FakeQueue } from './fakes';

const envOf = () => ({
  SUBS: new FakeR2() as unknown as R2Bucket,
  JOBS: new FakeQueue() as unknown as Queue,
  INGEST_KEY: 'test-key',
});

const payload = {
  videoId: 'ksfm6jeTg3Q',
  tier: 2,
  sourceLang: 'en',
  availableTracks: [],
  meta: { title: 'T', channel: 'C', description: '', durationSec: 100 },
  track: { languageCode: 'en', kind: null },
  cues: [{ start: 0, dur: 2, text: 'Hello everyone.' }],
};

const post = (env: ReturnType<typeof envOf>, body: unknown, headers: Record<string, string> = {}) =>
  worker.fetch(
    new Request('https://ytplayer.ai-apps.work/ingest', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-ingest-key': 'test-key', ...headers },
      body: JSON.stringify(body),
    }),
    env as never
  );

describe('/ingest（ext 送片的那條路）', () => {
  it('帶 header 的正常 payload → 200，且真的排進佇列', async () => {
    const env = envOf();
    const res = await post(env, payload);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, key: 'subs/ksfm6jeTg3Q/source.json', cueCount: 1 });
    expect((env.JOBS as unknown as FakeQueue).pending).toHaveLength(1);
  });

  // 「Failed to fetch」的第一嫌疑犯：預檢沒過。ext 送 content-type + x-ingest-key
  // 兩個非簡單標頭，瀏覽器一定會先打一發 OPTIONS —— 那一發沒有 CORS 標頭就整個失敗
  it('CORS 預檢：OPTIONS 要回 2xx 且帶齊 allow-origin/methods/headers', async () => {
    const res = await worker.fetch(
      new Request('https://ytplayer.ai-apps.work/ingest', {
        method: 'OPTIONS',
        headers: {
          origin: 'chrome-extension://abcdefghijklmnopabcdefghijklmnop',
          'access-control-request-method': 'POST',
          'access-control-request-headers': 'content-type,x-ingest-key',
        },
      }),
      envOf() as never
    );
    expect(res.status).toBeLessThan(300);
    expect(res.headers.get('access-control-allow-origin')).toBe('*');
    expect(res.headers.get('access-control-allow-methods')).toContain('POST');
    expect(res.headers.get('access-control-allow-headers')).toContain('x-ingest-key');
  });

  // 失敗的回應同樣要帶 CORS —— 不然 ext 讀不到錯誤內容，只會看到 Failed to fetch，
  // 使用者就分不清「被拒絕」與「連不上」
  it('未授權與格式錯誤的回應也要帶 CORS 標頭', async () => {
    const bad = await post(envOf(), payload, { 'x-ingest-key': 'wrong' });
    expect(bad.status).toBe(403);
    expect(bad.headers.get('access-control-allow-origin')).toBe('*');

    const invalid = await post(envOf(), { videoId: 'x' });
    expect(invalid.status).toBe(400);
    expect(invalid.headers.get('access-control-allow-origin')).toBe('*');
  });

  // 2026-08-21 把 ?key= 限制成只認頁面路由。ext 用 header，所以不受影響 ——
  // 這條測試釘住「API 的 header 認證沒被那次改動波及」
  it('API 認 header、不認 ?key=；頁面路由才認 ?key=', async () => {
    const viaQuery = await worker.fetch(
      new Request('https://ytplayer.ai-apps.work/ingest?key=test-key', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      }),
      envOf() as never
    );
    expect(viaQuery.status).toBe(403); // API 不吃網址帶 key

    const page = await worker.fetch(
      new Request('https://ytplayer.ai-apps.work/videos.json', { headers: { 'x-ingest-key': 'test-key' } }),
      envOf() as never
    );
    expect(page.status).toBe(200);
  });

  it('/health 是簡單請求（不觸發預檢），而且帶 CORS —— 診斷靠它分層', async () => {
    const res = await worker.fetch(new Request('https://ytplayer.ai-apps.work/health'), envOf() as never);
    expect(res.status).toBe(200);
    expect(res.headers.get('access-control-allow-origin')).toBe('*');
    expect(await res.json()).toMatchObject({ service: 'ytplayer' });
  });
});

// /admin 的資料來源。它比清單頁更貴：舊片要回填就得讀 bilingual.json（好幾 MB），
// 循序跑就是 N 趟來回 —— 與 /videos.json 同一個病（2026-09-04 實測 5–8 秒）
describe('/jobs.json（儀表板的資料）', () => {
  it('多支影片並行讀取，不是一支一支等', async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const r2 = new FakeR2();
    for (let i = 0; i < 25; i++) {
      const id = `job${String(i).padStart(8, '0')}`.slice(0, 11);
      await r2.put(`subs/${id}/status.json`, JSON.stringify({ videoId: id, stage: 'done', title: 'T', updatedAt: '2026-08-01', doneAt: '2026-08-01', untranslated: 0, cpsOver: 0 }));
    }
    const origGet = r2.get.bind(r2);
    r2.get = async (key: string) => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((r) => setTimeout(r, 1));
      try {
        return await origGet(key);
      } finally {
        inFlight--;
      }
    };
    const res = await worker.fetch(
      new Request('https://ytplayer.ai-apps.work/jobs.json', { headers: { 'x-ingest-key': 'test-key' } }),
      { SUBS: r2 as unknown as R2Bucket, JOBS: new FakeQueue() as unknown as Queue, INGEST_KEY: 'test-key' } as never
    );
    expect(res.status).toBe(200);
    expect((await res.json()).jobs).toHaveLength(25);
    expect(maxInFlight).toBeGreaterThan(1); // 循序的話永遠是 1
  });
});

// 讀取面的收斂（docs/privacy-hardening.md §5.5）：拿到一條 /watch 連結的人
// 本來就看得到那支片的字幕 —— 但不該連「花了多少錢、模型吐了什麼」一起看到
describe('公開資料的邊界', () => {
  const seed = async (env: ReturnType<typeof envOf>) => {
    const r2 = env.SUBS as unknown as FakeR2;
    await r2.put('subs/ksfm6jeTg3Q/status.json', JSON.stringify({
      videoId: 'ksfm6jeTg3Q', stage: 'failed', step: '3/7', failed: true,
      failReason: 'translate 步驟連續失敗：LLM 輸出無法解析為 JSON（開頭：<img src=x onerror=…>）',
      tokensUsed: 84405, llmCalls: 34, model: 'gemini-3.5-flash', promptTokens: 47289,
    }));
    await r2.put('subs/ksfm6jeTg3Q/source.json', JSON.stringify({ meta: { description: '一大段影片描述' }, cues: [] }));
    await r2.put('subs/ksfm6jeTg3Q/bilingual.json', JSON.stringify({ cues: [] }));
    return r2;
  };
  const get = (env: ReturnType<typeof envOf>, path: string, key?: string) =>
    worker.fetch(new Request(`https://ytplayer.ai-apps.work${path}`, key ? { headers: { 'x-ingest-key': key } } : undefined), env as never);

  it('路人拿到的 status.json 只有進度，沒有花費也沒有模型輸出', async () => {
    const env = envOf();
    await seed(env);
    const body = await (await get(env, '/subs/ksfm6jeTg3Q/status.json')).json();
    expect(body).toEqual({ videoId: 'ksfm6jeTg3Q', stage: 'failed', step: '3/7', failed: true });
    const raw = JSON.stringify(body);
    expect(raw).not.toContain('failReason');
    expect(raw).not.toContain('onerror'); // 模型輸出一個字都不該外流
    expect(raw).not.toContain('84405');
  });

  it('自己人（帶 key）拿得到完整 status —— player 頁才顯示得出失敗原因', async () => {
    const env = envOf();
    await seed(env);
    const body = await (await get(env, '/subs/ksfm6jeTg3Q/status.json', 'test-key')).json();
    expect(body).toMatchObject({ failReason: expect.stringContaining('translate'), tokensUsed: 84405 });
  });

  it('source.json 不在公開白名單，但帶 key 拿得到（ab-runner 要抓真實語料）', async () => {
    const env = envOf();
    await seed(env);
    expect((await get(env, '/subs/ksfm6jeTg3Q/source.json')).status).toBe(404);
    expect((await get(env, '/subs/ksfm6jeTg3Q/source.json', 'test-key')).status).toBe(200);
  });

  it('字幕本體維持公開 —— 那是「有連結就看得到」的既有取捨，這次不動它', async () => {
    const env = envOf();
    await seed(env);
    expect((await get(env, '/subs/ksfm6jeTg3Q/bilingual.json')).status).toBe(200);
  });

  it('/health 公開版不含用量與設定旗標，帶 key 才有', async () => {
    const env = envOf();
    const open = await (await get(env, '/health')).json();
    expect(open).toEqual({ service: 'ytplayer', ok: true }); // ext 診斷只看這兩個
    const mine = await (await get(env, '/health', 'test-key')).json();
    expect(mine).toMatchObject({ ingestKeyConfigured: true, today: { tokens: 0 } });
  });
});

describe('POST 的 content-type 閘門（CSRF 面）', () => {
  // 跨站 <form> 只送得出這三種 content-type，其他一律先過 preflight。
  // 所以「拒收這三種」= 拒收瀏覽器發起的跨站寫入。目前不可利用（授權要靠
  // x-ingest-key 或 Access JWT），但 Access 範圍一變大就會變成 CSRF 面。
  const simple = ['application/x-www-form-urlencoded', 'multipart/form-data; boundary=x', 'text/plain'];

  for (const ct of simple) {
    it(`拒收 ${ct.split(';')[0]} → 415`, async () => {
      const res = await post(envOf(), payload, { 'content-type': ct });
      expect(res.status).toBe(415);
    });
  }

  it('application/json 照常放行', async () => {
    expect((await post(envOf(), payload)).status).toBe(200);
  });

  it('沒有 content-type 也放行 —— README 教的 curl 沒有 body 也沒有標頭', async () => {
    const res = await worker.fetch(
      new Request('https://ytplayer.ai-apps.work/translate/ksfm6jeTg3Q?force=1', {
        method: 'POST',
        headers: { 'x-ingest-key': 'test-key' },
      }),
      envOf() as never
    );
    // 這支片不存在，所以會是 404 而不是 200 —— 重點是它沒有被 415 擋在門外
    expect(res.status).not.toBe(415);
  });

  it('未授權時 415 一樣先擋下 —— 不因為它未授權就洩漏路由存在與否', async () => {
    const env = envOf();
    const res = await worker.fetch(
      new Request('https://ytplayer.ai-apps.work/ingest', {
        method: 'POST',
        headers: { 'content-type': 'text/plain' },
        body: 'x',
      }),
      env as never
    );
    expect(res.status).toBe(415);
    expect((env.JOBS as unknown as FakeQueue).pending).toHaveLength(0);
  });
});
