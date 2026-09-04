// 清單頁資料來源。起因：2026-09-04 使用者回報「第一次開站一直 loading」——
// 實測 production 的 /videos.json 要 5–8 秒，因為 31 支影片是**一支一支循序讀** R2。
// 這裡釘住「並行」這件事：純看結果的測試看不出循序與並行的差別，
// 所以 FakeR2 要能記錄「同時在飛的讀取數」。
import { describe, it, expect } from 'vitest';
import { listVideos, LIST_CONCURRENCY } from '../src/pipeline';
import { FakeR2 } from './fakes';

// 會統計並行度的 R2：每次 get 都停一個 tick，才量得到重疊
class CountingR2 extends FakeR2 {
  inFlight = 0;
  maxInFlight = 0;
  gets = 0;
  async get(key: string) {
    this.gets++;
    this.inFlight++;
    this.maxInFlight = Math.max(this.maxInFlight, this.inFlight);
    await new Promise((r) => setTimeout(r, 1));
    try {
      return await super.get(key);
    } finally {
      this.inFlight--;
    }
  }
}

const seed = async (r2: FakeR2, n: number) => {
  for (let i = 0; i < n; i++) {
    const id = `vid${String(i).padStart(8, '0')}`.slice(0, 11);
    await r2.put(
      `subs/${id}/info.json`,
      JSON.stringify({ videoId: id, title: `影片 ${i}`, cueCount: 10, generatedAt: `2026-08-${String((i % 28) + 1).padStart(2, '0')}` })
    );
  }
};

describe('listVideos（清單頁的資料）', () => {
  it('多支影片是並行讀取，不是一支一支等', async () => {
    const r2 = new CountingR2();
    await seed(r2, 30);
    const out = await listVideos({ SUBS: r2 as unknown as R2Bucket });
    expect(out).toHaveLength(30);
    // 循序的話 maxInFlight 永遠是 1 —— 那正是「開站一直 loading」的成因
    expect(r2.maxInFlight).toBeGreaterThan(1);
    expect(r2.maxInFlight).toBeLessThanOrEqual(LIST_CONCURRENCY);
  });

  it('有 info.json 的影片一支只讀一次（別退回去讀 bilingual.json，那是好幾 MB）', async () => {
    const r2 = new CountingR2();
    await seed(r2, 12);
    await listVideos({ SUBS: r2 as unknown as R2Bucket });
    expect(r2.gets).toBe(12);
  });

  it('照 generatedAt 由新到舊排序', async () => {
    const r2 = new FakeR2();
    await seed(r2, 5);
    const out = await listVideos({ SUBS: r2 as unknown as R2Bucket });
    const dates = out.map((v) => String(v.generatedAt));
    expect(dates).toEqual([...dates].sort().reverse());
  });

  it('沒有 info.json 時從 bilingual.json 回填，而且真的寫回去（下次就走快路）', async () => {
    const r2 = new CountingR2();
    await r2.put(
      'subs/aaaaaaaaaaa/bilingual.json',
      JSON.stringify({ meta: { title: '舊片', channel: 'C', durationSec: 60 }, generatedAt: '2026-07-01', cues: [1, 2, 3] })
    );
    const out = await listVideos({ SUBS: r2 as unknown as R2Bucket });
    expect(out[0]).toMatchObject({ videoId: 'aaaaaaaaaaa', title: '舊片', cueCount: 3, translated: true });
    expect(r2.store.has('subs/aaaaaaaaaaa/info.json')).toBe(true);
  });
});
