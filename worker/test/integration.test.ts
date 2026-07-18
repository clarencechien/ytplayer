// runPipeline / translateNextPending 端到端：fake R2 + fake LLM。
import { describe, it, expect } from 'vitest';
import { runPipeline, translateNextPending } from '../src/pipeline';

class FakeR2 {
  store = new Map<string, { value: string; uploaded: Date }>();
  private seq = 0;
  async get(key: string) {
    const e = this.store.get(key);
    return e === undefined ? null : { text: async () => e.value, body: e.value };
  }
  async put(key: string, value: string) {
    // uploaded 單調遞增（貼近 now，讓鎖的新鮮度判斷成立）
    this.store.set(key, { value: String(value), uploaded: new Date(Date.now() + this.seq++) });
  }
  async head(key: string) {
    const e = this.store.get(key);
    return e === undefined ? null : { uploaded: e.uploaded };
  }
  async delete(key: string) {
    this.store.delete(key);
  }
  async list({ prefix, delimiter }: { prefix: string; delimiter?: string }) {
    const delimitedPrefixes = new Set<string>();
    for (const key of this.store.keys()) {
      if (!key.startsWith(prefix)) continue;
      if (delimiter) {
        const rest = key.slice(prefix.length);
        const i = rest.indexOf(delimiter);
        if (i >= 0) delimitedPrefixes.add(prefix + rest.slice(0, i + 1));
      }
    }
    return { delimitedPrefixes: [...delimitedPrefixes], objects: [], truncated: false as const };
  }
}

const makeSource = () => ({
  videoId: 'ksfm6jeTg3Q',
  tier: 2,
  sourceLang: 'en',
  availableTracks: [],
  meta: { title: 'Agentic infra', channel: 'Claude', description: 'desc', durationSec: 100 },
  track: { languageCode: 'en' },
  cues: [
    { start: 0, dur: 2, text: 'Hello everyone.' },
    { start: 2, dur: 2, text: 'Agents are moving to' },
    { start: 4, dur: 2, text: 'production today.' },
    { start: 6, dur: 2, text: 'Thanks for watching.' },
  ],
});

// glossary 呼叫回術語表；翻譯呼叫依 prompt 中的「id: 句子」回中文
const fakeLlm = async (prompt: string): Promise<string> => {
  if (prompt.includes('術語編輯')) {
    return '[{"term":"Agents","suggested_zh":"agent","note":"保留英文"}]';
  }
  const ids = [...prompt.matchAll(/^(\d+): /gm)].map((m) => Number(m[1]));
  return JSON.stringify(ids.map((id) => ({ id, zh: `中文${id}。` })));
};

describe('runPipeline（整合）', () => {
  it('Tier 2 全流程：sentences/glossary/bilingual/srt 都寫入，第二次命中 cache', async () => {
    const SUBS = new FakeR2();
    await SUBS.put('subs/ksfm6jeTg3Q/source.json', JSON.stringify(makeSource()));
    const env = { SUBS: SUBS as unknown as R2Bucket, GEMINI_MODEL: 'fake-model' };

    const r1 = await runPipeline(env, 'ksfm6jeTg3Q', false, fakeLlm);
    expect(r1.status).toBe(200);
    const stats = (r1.body as { stats: Record<string, unknown> }).stats;
    expect(stats.sentences).toBe(3); // 兩個 cue 併成一句 + 另兩句
    expect(stats.glossaryTerms).toBe(1);
    expect(stats.untranslated).toBe(0);
    expect(stats.warnings).toEqual([]);

    const bilingual = JSON.parse(SUBS.store.get('subs/ksfm6jeTg3Q/bilingual.json')!.value);
    expect(bilingual.promptVersion).toBeTruthy();
    expect(bilingual.model).toBe('fake-model');
    expect(bilingual.cues.length).toBe(3);
    expect(bilingual.cues[1]).toMatchObject({ start: 2, end: 6, en: 'Agents are moving to production today.', zh: '中文1。' });
    expect(SUBS.store.get('subs/ksfm6jeTg3Q/bilingual.srt')!.value).toContain('中文0。\nHello everyone.');
    expect(SUBS.store.has('subs/ksfm6jeTg3Q/sentences.json')).toBe(true);
    expect(SUBS.store.has('subs/ksfm6jeTg3Q/glossary.json')).toBe(true);

    const r2 = await runPipeline(env, 'ksfm6jeTg3Q', false, fakeLlm);
    expect(r2.body).toMatchObject({ ok: true, cached: true });
  });

  it('翻譯持續缺句 → fallback 英文 + warnings 非空（驗收會擋）', async () => {
    const SUBS = new FakeR2();
    await SUBS.put('subs/ksfm6jeTg3Q/source.json', JSON.stringify(makeSource()));
    const env = { SUBS: SUBS as unknown as R2Bucket, GEMINI_MODEL: 'fake-model' };
    const partialLlm = async (prompt: string): Promise<string> => {
      if (prompt.includes('術語編輯')) return '[]';
      return '[{"id":0,"zh":"只有第一句。"}]';
    };
    const r = await runPipeline(env, 'ksfm6jeTg3Q', false, partialLlm);
    expect(r.status).toBe(200);
    const stats = (r.body as { stats: { untranslated: number; warnings: string[] } }).stats;
    expect(stats.untranslated).toBe(2);
    expect(stats.warnings.some((w) => w.includes('翻譯失敗'))).toBe(true);
  });

  it('tier 3 被拒（紅線）', async () => {
    const SUBS = new FakeR2();
    const src = makeSource();
    src.tier = 3;
    await SUBS.put('subs/ksfm6jeTg3Q/source.json', JSON.stringify(src));
    const r = await runPipeline({ SUBS: SUBS as unknown as R2Bucket }, 'ksfm6jeTg3Q', false, fakeLlm);
    expect(r.status).toBe(422);
  });
});

describe('translateNextPending（cron 佇列）', () => {
  const envOf = (SUBS: FakeR2) => ({ SUBS: SUBS as unknown as R2Bucket, GEMINI_MODEL: 'fake-model' });

  it('翻第一支待處理的 Tier 2，鎖檔會清掉', async () => {
    const SUBS = new FakeR2();
    await SUBS.put('subs/ksfm6jeTg3Q/source.json', JSON.stringify(makeSource()));
    const r = await translateNextPending(envOf(SUBS), fakeLlm);
    expect(r.translated).toBe('ksfm6jeTg3Q');
    expect(r.status).toBe(200);
    expect(SUBS.store.has('subs/ksfm6jeTg3Q/bilingual.json')).toBe(true);
    expect(SUBS.store.has('subs/ksfm6jeTg3Q/.translating')).toBe(false);
  });

  it('Tier 3 跳過、不佔佇列，後面的 Tier 2 照翻', async () => {
    const SUBS = new FakeR2();
    const t3 = makeSource();
    t3.videoId = 'AAAAAAAAAAA';
    t3.tier = 3;
    await SUBS.put('subs/AAAAAAAAAAA/source.json', JSON.stringify(t3));
    await SUBS.put('subs/ksfm6jeTg3Q/source.json', JSON.stringify(makeSource()));
    const r = await translateNextPending(envOf(SUBS), fakeLlm);
    expect(r.translated).toBe('ksfm6jeTg3Q');
    expect(SUBS.store.has('subs/AAAAAAAAAAA/bilingual.json')).toBe(false);
  });

  it('bilingual 比 source 新 → 無事可做；重新 ingest（source 較新）→ 重翻', async () => {
    const SUBS = new FakeR2();
    await SUBS.put('subs/ksfm6jeTg3Q/source.json', JSON.stringify(makeSource()));
    await translateNextPending(envOf(SUBS), fakeLlm);
    expect((await translateNextPending(envOf(SUBS), fakeLlm)).translated).toBeUndefined();
    await SUBS.put('subs/ksfm6jeTg3Q/source.json', JSON.stringify(makeSource())); // re-ingest
    expect((await translateNextPending(envOf(SUBS), fakeLlm)).translated).toBe('ksfm6jeTg3Q');
  });

  it('新鮮的 .translating 鎖 → 跳過（防 cron 重疊）', async () => {
    const SUBS = new FakeR2();
    await SUBS.put('subs/ksfm6jeTg3Q/source.json', JSON.stringify(makeSource()));
    await SUBS.put('subs/ksfm6jeTg3Q/.translating', new Date().toISOString());
    const r = await translateNextPending(envOf(SUBS), fakeLlm);
    expect(r.translated).toBeUndefined();
  });
});
