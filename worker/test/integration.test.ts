// runPipeline 端到端：fake R2 + fake LLM，驗證輸出檔、fallback、cache。
import { describe, it, expect } from 'vitest';
import { runPipeline } from '../src/pipeline';

class FakeR2 {
  store = new Map<string, string>();
  async get(key: string) {
    const v = this.store.get(key);
    return v === undefined ? null : { text: async () => v, body: v };
  }
  async put(key: string, value: string) {
    this.store.set(key, String(value));
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

    const bilingual = JSON.parse(SUBS.store.get('subs/ksfm6jeTg3Q/bilingual.json')!);
    expect(bilingual.promptVersion).toBeTruthy();
    expect(bilingual.model).toBe('fake-model');
    expect(bilingual.cues.length).toBe(3);
    expect(bilingual.cues[1]).toMatchObject({ start: 2, end: 6, en: 'Agents are moving to production today.', zh: '中文1。' });
    expect(SUBS.store.get('subs/ksfm6jeTg3Q/bilingual.srt')).toContain('中文0。\nHello everyone.');
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
