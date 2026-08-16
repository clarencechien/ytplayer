// Glossary 疊層（docs/glossary-layers.md G1）
import { describe, it, expect } from 'vitest';
import {
  parseGlossaryDoc,
  mergeGlossary,
  channelKeys,
  channelSlug,
  langKey,
  loadGenreLayer,
  loadChannelLayer,
  GLOSSARY_CAP,
} from '../src/glossary';
import { FakeR2 } from './fakes';

const store = (r: FakeR2) => r as unknown as { get(key: string): Promise<{ text(): Promise<string> } | null> };

describe('parseGlossaryDoc', () => {
  it('吃新格式（term）與 {entries:[…]} 包裝', () => {
    expect(parseGlossaryDoc([{ term: 'a', zh: '甲' }])).toEqual([{ term: 'a', zh: '甲' }]);
    expect(parseGlossaryDoc({ channel: 'x', entries: [{ term: 'b', zh: '乙', note: '註' }] })).toEqual([
      { term: 'b', zh: '乙', note: '註' },
    ]);
  });

  it('吃 kvsplayer 舊格式（語言碼欄位當 term）', () => {
    expect(parseGlossaryDoc([{ ko: '막내', zh: '忙內' }])).toEqual([{ term: '막내', zh: '忙內' }]);
  });

  it('缺 term 或 zh 的條目直接丟掉（人工檔案同樣視為敵意輸入）', () => {
    expect(parseGlossaryDoc([{ term: 'a' }, { zh: '甲' }, { term: ' ', zh: '乙' }, 'x', null])).toEqual([]);
  });
});

describe('mergeGlossary', () => {
  it('同 term 上層贏，且標記層來源', () => {
    const merged = mergeGlossary({
      channel: [{ term: 'Fold', zh: 'Fold（頻道固定譯法）' }],
      genre: [{ term: 'fold', zh: '摺疊' }],
      auto: [{ term: 'FOLD', zh: '對折' }, { term: 'hinge', zh: '轉軸' }],
    });
    expect(merged.map((e) => [e.zh, e.layer])).toEqual([
      ['Fold（頻道固定譯法）', 'channel'],
      ['轉軸', 'auto'],
    ]);
  });

  it('大小寫/全半形正規化後才比對', () => {
    const merged = mergeGlossary({ channel: [{ term: 'ＡＰＩ', zh: 'API' }], auto: [{ term: 'api', zh: '介面' }] });
    expect(merged).toHaveLength(1);
    expect(merged[0].zh).toBe('API');
  });

  it('超過上限先砍 auto（人工表不可再生，自動抽可以）', () => {
    const many = (n: number, p: string) => Array.from({ length: n }, (_, i) => ({ term: `${p}${i}`, zh: `${p}${i}譯` }));
    const merged = mergeGlossary({ channel: many(10, 'c'), genre: many(20, 'g'), auto: many(60, 'a') });
    expect(merged).toHaveLength(GLOSSARY_CAP);
    expect(merged.filter((e) => e.layer === 'channel')).toHaveLength(10);
    expect(merged.filter((e) => e.layer === 'genre')).toHaveLength(20);
    expect(merged.filter((e) => e.layer === 'auto')).toHaveLength(GLOSSARY_CAP - 30);
  });
});

describe('channel key', () => {
  it('ucid 優先、名稱 slug 後備（舊 source 沒有 ucid）', () => {
    expect(channelKeys({ channel: 'トバログ', channelId: 'UCabcdefghijklmnopqrstuv' })).toEqual([
      'UCabcdefghijklmnopqrstuv',
      'トバログ',
    ]);
    expect(channelKeys({ channel: 'Two Minute Papers' })).toEqual(['two-minute-papers']);
    expect(channelKeys({ channel: 'x', channelId: 'not-a-ucid' })).toEqual(['x']);
    expect(channelKeys(undefined)).toEqual([]);
  });

  it('slug 去掉會壞掉檔名的字元', () => {
    expect(channelSlug(' A/B?C#D ')).toBe('a-b-c-d');
  });

  it('langKey 取主要子標籤', () => {
    expect(langKey('ja-JP')).toBe('ja');
    expect(langKey(undefined)).toBe('xx');
  });
});

describe('疊層讀取', () => {
  it('genre：R2 新檔 > R2 舊檔 > repo 內建', async () => {
    const r2 = new FakeR2();
    expect((await loadGenreLayer(store(r2), 'ko')).length).toBeGreaterThan(30); // 內建韓綜通用表
    expect(await loadGenreLayer(store(r2), 'ja')).toEqual([]);

    await r2.put('glossary/watch-ko.json', JSON.stringify([{ ko: '막내', zh: '老么' }]));
    expect(await loadGenreLayer(store(r2), 'ko')).toEqual([{ term: '막내', zh: '老么' }]);

    await r2.put('glossary/genre-ko.json', JSON.stringify([{ term: '막내', zh: '忙內' }]));
    expect(await loadGenreLayer(store(r2), 'ko')).toEqual([{ term: '막내', zh: '忙內' }]);
  });

  it('壞掉的 glossary 檔不擋翻譯（退回下一層）', async () => {
    const r2 = new FakeR2();
    await r2.put('glossary/genre-ko.json', '{壞掉的 JSON');
    expect((await loadGenreLayer(store(r2), 'ko')).length).toBeGreaterThan(30);
  });

  it('channel：依 keys 順序找第一個有內容的，含 repo 內建鍵值', async () => {
    const r2 = new FakeR2();
    expect(await loadChannelLayer(store(r2), [])).toEqual({ entries: [] });

    const builtin = await loadChannelLayer(store(r2), ['15ya']);
    expect(builtin.key).toBe('15ya');
    expect(builtin.entries.some((e) => e.term === '나영석')).toBe(true);

    await r2.put(
      'glossary/channel-UCabcdefghijklmnopqrstuv.json',
      JSON.stringify({ channel: 'x', entries: [{ term: 'a', zh: '甲' }] })
    );
    const found = await loadChannelLayer(store(r2), ['UCabcdefghijklmnopqrstuv', 'name-slug']);
    expect(found.key).toBe('UCabcdefghijklmnopqrstuv');
    expect(found.entries).toEqual([{ term: 'a', zh: '甲' }]);
  });

  it('ucid 沒有對應檔案時退回名稱 slug（頻道改名前的舊表仍命中）', async () => {
    const r2 = new FakeR2();
    await r2.put('glossary/channel-old-name.json', JSON.stringify([{ term: 'a', zh: '甲' }]));
    const found = await loadChannelLayer(store(r2), ['UCabcdefghijklmnopqrstuv', 'old-name']);
    expect(found.key).toBe('old-name');
  });
});
