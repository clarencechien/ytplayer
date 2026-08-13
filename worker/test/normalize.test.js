// fixture 來自 phase0b 真實 capture（SpaceX -a0ecQMq-rM，Gemini ASR、fmt=json3）
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { normalizeJson3 } from '../../ext/normalize.js';

const fixture = readFileSync(new URL('./fixtures/json3-asr.json', import.meta.url), 'utf8');

describe('normalizeJson3', () => {
  it('真實 ASR capture：跳過視窗定義與 aAppend 捲動列，逐詞 seg 串接', () => {
    const cues = normalizeJson3(fixture);
    expect(cues.map(({ start, dur, text }) => ({ start, dur, text }))).toEqual([
      { start: 3.48, dur: 3.04, text: "When you're dealing [music] with" },
      { start: 4.8, dur: 3.8, text: 'something as complex as building a' },
      { start: 6.52, dur: 3.8, text: 'rocket or as building a launchpad, being' },
      { start: 8.6, dur: 3.96, text: 'extremely mindful of the critical path' },
    ]);
  });

  it('ASR 逐詞時間保留為 segs（[offsetSec, word]，遞增）— 詞級斷句的原料', () => {
    const cues = normalizeJson3(fixture);
    const first = cues[0];
    expect(Array.isArray(first.segs)).toBe(true);
    expect(first.segs[0]).toEqual([0, 'When']);
    expect(first.segs[1][1]).toBe("you're");
    for (let i = 1; i < first.segs.length; i++) {
      expect(first.segs[i][0]).toBeGreaterThanOrEqual(first.segs[i - 1][0]);
    }
    // 單 seg 的（人工軌型態）不帶 segs
    const single = normalizeJson3({ events: [{ tStartMs: 0, dDurationMs: 1000, segs: [{ utf8: 'hello' }] }] });
    expect(single[0].segs).toBeUndefined();
  });

  it('接受已 parse 的物件，且輸出依時間排序', () => {
    const cues = normalizeJson3({
      events: [
        { tStartMs: 5000, dDurationMs: 1000, segs: [{ utf8: 'second' }] },
        { tStartMs: 1000, dDurationMs: 1000, segs: [{ utf8: 'first' }] },
      ],
    });
    expect(cues.map((c) => c.text)).toEqual(['first', 'second']);
  });

  it('空白/壞 seg 清洗：多重空白摺疊、純空白事件剔除', () => {
    const cues = normalizeJson3({
      events: [
        { tStartMs: 0, dDurationMs: 1000, segs: [{ utf8: '  a  ' }, { utf8: '\n b' }, {}] },
        { tStartMs: 1000, dDurationMs: 1000, segs: [{ utf8: '   ' }] },
        { tStartMs: 2000, dDurationMs: 1000 },
      ],
    });
    expect(cues.map(({ start, dur, text }) => ({ start, dur, text }))).toEqual([{ start: 0, dur: 1, text: 'a b' }]);
    expect(cues[0].segs).toEqual([[0, 'a'], [0, 'b']]); // 多 seg 保留逐詞資訊（offset 缺省為 0）
  });

  it('缺 events 直接丟錯（不吞格式異常）', () => {
    expect(() => normalizeJson3('{}')).toThrow();
    expect(() => normalizeJson3('not json')).toThrow();
  });
});
