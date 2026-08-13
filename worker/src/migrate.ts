// M4：kvsplayer（R2 bucket `kvs-krsub`）→ ytplayer schema v2 一次性遷移。
// 純 R2 讀寫、零 LLM。跑法：POST /migrate-kvs（key 認證；預設跳過已存在的，?overwrite=1 重灌）。
// 完成並驗收後（migration.md M5）可移除 KVS 綁定與本檔。

import watchGlossaryKo from './data/watch-glossary-ko.json';

// kvsplayer 的 cues.json 條目
export interface KvsCue {
  id: number;
  start: number;
  end: number;
  kind: 'speech' | 'card';
  ko?: string;
  en?: string;
  zh: string;
}

export interface KvsMeta {
  id: string;
  title?: string;
  url?: string;
  created?: string;
  source?: string;
}

// 轉 schema v2（orig 取代 ko/en；trust 依來源：gemini 看片=model、字幕軌對齊=cc）
export function convertKvs(videoId: string, cues: KvsCue[], meta: KvsMeta | null): Record<string, unknown> {
  const fromWatch = (meta?.source ?? '').includes('gemini');
  const v2cues = cues.map((c) => ({
    start: c.start,
    end: c.end,
    kind: c.kind === 'card' ? 'card' : 'speech',
    orig: c.ko || c.en || '',
    zh: c.zh,
  }));
  const durationSec = Math.ceil(cues.reduce((m, c) => Math.max(m, +c.end || 0), 0));
  return {
    videoId,
    schema: 2,
    meta: { title: meta?.title || videoId, channel: '', description: '', durationSec },
    sourceLang: 'ko',
    tier: 3,
    route: fromWatch ? 'video' : 'text',
    trust: fromWatch ? 'model' : 'cc',
    asrRepaired: 0,
    model: 'kvsplayer-migrated',
    promptVersion: 'kvs',
    generatedAt: meta?.created || new Date(0).toISOString(),
    warnings: [],
    hints: [],
    migratedFrom: 'kvs-krsub',
    cues: v2cues,
  };
}

interface R2Like {
  get(key: string): Promise<{ text(): Promise<string> } | null>;
  put(key: string, value: string, opts?: unknown): Promise<unknown>;
  head(key: string): Promise<unknown | null>;
  list(opts: { prefix: string; delimiter?: string; cursor?: string }): Promise<{
    delimitedPrefixes?: string[];
    truncated: boolean;
    cursor?: string;
  }>;
}

export async function migrateKvs(
  KVS: R2Like,
  SUBS: R2Like,
  overwrite: boolean
): Promise<{ migrated: string[]; skipped: string[]; empty: string[]; glossary: number }> {
  const jsonPut = (bucket: R2Like, key: string, value: unknown) =>
    bucket.put(key, JSON.stringify(value), { httpMetadata: { contentType: 'application/json' } });

  // 1. 看片譯名表（kvsplayer 的 genre 40 詞 + 頻道鎖定表，watch 步驟的 prompt 會讀）
  await jsonPut(SUBS, 'glossary/watch-ko.json', watchGlossaryKo);

  // 2. 影片資料
  const prefixes: string[] = [];
  let cursor: string | undefined;
  do {
    const res = await KVS.list({ prefix: 'videos/', delimiter: '/', cursor });
    prefixes.push(...(res.delimitedPrefixes ?? []));
    cursor = res.truncated ? res.cursor : undefined;
  } while (cursor);

  const migrated: string[] = [];
  const skipped: string[] = [];
  const empty: string[] = [];
  for (const p of prefixes) {
    const videoId = p.slice('videos/'.length).replace(/\/$/, '');
    if (!/^[A-Za-z0-9_-]{11}$/.test(videoId)) continue;
    const cuesObj = await KVS.get(`videos/${videoId}/cues.json`);
    if (!cuesObj) {
      empty.push(videoId); // 只有中間產物、沒跑完的片：不遷（kvsplayer 那邊要重跑請用 /watch-job）
      continue;
    }
    if (!overwrite && (await SUBS.head(`subs/${videoId}/bilingual.json`))) {
      skipped.push(videoId);
      continue;
    }
    const cues = JSON.parse(await cuesObj.text()) as KvsCue[];
    const metaObj = await KVS.get(`videos/${videoId}/meta.json`);
    const meta = metaObj ? (JSON.parse(await metaObj.text()) as KvsMeta) : null;
    const bilingual = convertKvs(videoId, cues, meta);
    await jsonPut(SUBS, `subs/${videoId}/bilingual.json`, bilingual);
    await jsonPut(SUBS, `subs/${videoId}/info.json`, {
      videoId,
      title: (bilingual.meta as { title: string }).title,
      channel: '',
      durationSec: (bilingual.meta as { durationSec: number }).durationSec,
      cueCount: cues.length,
      generatedAt: bilingual.generatedAt,
    });
    migrated.push(videoId);
  }
  return { migrated, skipped, empty, glossary: (watchGlossaryKo as unknown[]).length };
}
