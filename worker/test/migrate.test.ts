// M4 遷移：kvsplayer cues → schema v2 轉換 + 兩 bucket 拷貝。
import { describe, it, expect } from 'vitest';
import { convertKvs, migrateKvs, type KvsCue } from '../src/migrate';
import { FakeR2, readJson } from './fakes';

const kvsCues: KvsCue[] = [
  { id: 0, start: 1.5, end: 4.2, kind: 'speech', ko: '안녕하세요', zh: '大家好' },
  { id: 1, start: 5, end: 8, kind: 'card', ko: '충격', zh: '衝擊' },
  { id: 2, start: 9, end: 12, kind: 'speech', ko: '', en: 'hello', zh: '哈囉' },
];

describe('convertKvs', () => {
  it('ko/en → orig、kind 保留、看片來源 trust=model、durationSec=最大 end', () => {
    const v2 = convertKvs('AAAAAAAAAAA', kvsCues, {
      id: 'AAAAAAAAAAA',
      title: '韓綜第一集',
      created: '2026-07-20T00:00:00Z',
      source: 'gemini-video',
    });
    expect(v2.schema).toBe(2);
    expect(v2.route).toBe('video');
    expect(v2.trust).toBe('model');
    expect(v2.generatedAt).toBe('2026-07-20T00:00:00Z');
    const cues = v2.cues as Array<Record<string, unknown>>;
    expect(cues[0]).toMatchObject({ orig: '안녕하세요', zh: '大家好', kind: 'speech' });
    expect(cues[1].kind).toBe('card');
    expect(cues[2].orig).toBe('hello'); // ko 空 → 退 en
    expect((v2.meta as { durationSec: number }).durationSec).toBe(12);
  });

  it('字幕軌對齊來源（非看片）→ trust=cc、route=text', () => {
    const v2 = convertKvs('AAAAAAAAAAA', kvsCues, { id: 'AAAAAAAAAAA', source: 'auto(ko,en)' });
    expect(v2.trust).toBe('cc');
    expect(v2.route).toBe('text');
  });
});

describe('migrateKvs', () => {
  it('全量遷移 + 預設跳過已存在 + 譯名表寫入', async () => {
    const KVS = new FakeR2();
    const SUBS = new FakeR2();
    await KVS.put('videos/AAAAAAAAAAA/cues.json', JSON.stringify(kvsCues));
    await KVS.put('videos/AAAAAAAAAAA/meta.json', JSON.stringify({ id: 'AAAAAAAAAAA', title: 'EP1', source: 'gemini-video' }));
    await KVS.put('videos/BBBBBBBBBBB/status.json', JSON.stringify({ stage: 'gemini' })); // 沒跑完：不遷
    await KVS.put('videos/CCCCCCCCCCC/cues.json', JSON.stringify(kvsCues));
    await SUBS.put('subs/CCCCCCCCCCC/bilingual.json', JSON.stringify({ existing: true })); // 已存在：跳過

    const r = await migrateKvs(KVS as never, SUBS as never, false);
    expect(r.migrated).toEqual(['AAAAAAAAAAA']);
    expect(r.skipped).toEqual(['CCCCCCCCCCC']);
    expect(r.empty).toEqual(['BBBBBBBBBBB']);
    expect(r.glossary).toBeGreaterThan(50);

    expect(readJson(SUBS, 'subs/AAAAAAAAAAA/bilingual.json').route).toBe('video');
    expect(readJson(SUBS, 'subs/AAAAAAAAAAA/info.json').cueCount).toBe(3);
    expect(readJson(SUBS, 'subs/CCCCCCCCCCC/bilingual.json').existing).toBe(true); // 沒被蓋
    expect(readJson(SUBS, 'glossary/watch-ko.json').length).toBeGreaterThan(50);

    // overwrite=1 重灌
    const r2 = await migrateKvs(KVS as never, SUBS as never, true);
    expect(r2.migrated.sort()).toEqual(['AAAAAAAAAAA', 'CCCCCCCCCCC']);
    expect(readJson(SUBS, 'subs/CCCCCCCCCCC/bilingual.json').schema).toBe(2);
  });
});
