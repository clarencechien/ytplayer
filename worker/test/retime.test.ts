// B 治標：顯示鏈接 + 最短顯示時長（docs/subtitle-timing.md §2B）+ 詞級斷句整合。
import { describe, it, expect } from 'vitest';
import { retimeCues, type RetimeCue } from '../src/retime';
import { segmentCues } from '../src/segment';
import type { Cue } from '../src/validate';

describe('retimeCues', () => {
  it('句間空隙 → 鏈接到下一句（上限 +3s）；末句 +1.5s', () => {
    const cues: RetimeCue[] = [
      { start: 0, end: 2, zh: '短句' }, // 與下句空隙 1s → 補到 2.95
      { start: 3, end: 5, zh: '第二句' }, // 空隙 10s → 只延 3s 到 8
      { start: 15, end: 17, zh: '末句' }, // 末句 → 18.5
    ];
    retimeCues(cues);
    expect(cues[0].end).toBe(2.95);
    expect(cues[1].end).toBe(8);
    expect(cues[2].end).toBe(18.5);
    expect(cues[0].end0).toBe(2); // 原始值錨定
  });

  it('最短顯示時長：超短句依中文字數補到下限，但永不越過下一句', () => {
    const cues: RetimeCue[] = [
      { start: 0, end: 0.3, zh: '這句中文有十個字喔' }, // min ≈ 1.35 → 但下一句 1.0 開始 → 0.95
      { start: 1.0, end: 4, zh: '下一句' },
    ];
    retimeCues(cues);
    expect(cues[0].end).toBe(0.95);
    expect(cues[0].end).toBeLessThan(cues[1].start);
  });

  it('冪等：重按結果不變（end0 錨點）', () => {
    const cues: RetimeCue[] = [
      { start: 0, end: 2, zh: 'a' },
      { start: 10, end: 12, zh: 'b' },
    ];
    retimeCues(cues);
    const after1 = JSON.stringify(cues);
    const changed2 = retimeCues(cues);
    expect(JSON.stringify(cues)).toBe(after1);
    expect(changed2).toBe(0);
  });

  it('字卡（kind=card）不動 — 短促是刻意的', () => {
    const cues: RetimeCue[] = [
      { start: 0, end: 2, zh: '對白', kind: 'speech' },
      { start: 1, end: 1.8, zh: '字卡', kind: 'card' },
      { start: 6, end: 8, zh: '對白2', kind: 'speech' },
    ];
    retimeCues(cues);
    expect(cues[1].end).toBe(1.8);
    expect(cues[0].end).toBe(5); // 鏈接只看 speech 序列（2 + 3s cap）
  });
});

describe('詞級斷句（segs → 句子自帶精準起訖）', () => {
  it('一個 cue 內含句界 → 句子邊界落在詞 offset 上，不再量化到 cue 邊界', () => {
    // cue1 前半是句 A 的尾、後半是句 B 的頭（ASR 常態）
    const cues: Cue[] = [
      {
        start: 0,
        dur: 4,
        text: 'first sentence ends. Second one',
        segs: [
          [0, 'first'],
          [0.5, 'sentence'],
          [1.0, 'ends.'],
          [2.2, 'Second'],
          [2.6, 'one'],
        ],
      },
      {
        start: 4,
        dur: 2,
        text: 'keeps going here.',
        segs: [
          [0, 'keeps'],
          [0.5, 'going'],
          [1.0, 'here.'],
        ],
      },
    ];
    const ss = segmentCues(cues);
    expect(ss.length).toBe(2);
    expect(ss[0].text).toBe('first sentence ends.');
    expect(ss[0].start).toBe(0);
    expect(ss[0].end).toBeCloseTo(2.2, 1); // 句 A 結束在「Second」開始處，不是 cue 結束的 4
    expect(ss[1].text).toBe('Second one keeps going here.');
    expect(ss[1].start).toBe(2.2); // 句 B 從詞 offset 開始，不是 cue2 的 4
    expect(ss[1].cueIds).toEqual([0, 1]);
  });

  it('CJK 詞流不插空白；無 segs 的軌走原路（cue 級）', () => {
    const ja: Cue[] = [
      {
        start: 0,
        dur: 3,
        text: 'こんにちは。今日は',
        segs: [
          [0, 'こんにち'],
          [0.4, 'は。'],
          [1.5, '今日'],
          [1.9, 'は'],
        ],
      },
      { start: 3, dur: 2, text: 'いい天気です。', segs: [[0, 'いい'], [0.5, '天気です。']] },
    ];
    const ss = segmentCues(ja);
    expect(ss[0].text).toBe('こんにちは。');
    expect(ss[1].text).toBe('今日はいい天気です。');

    const plain: Cue[] = [
      { start: 0, dur: 2, text: 'No segs here.' },
      { start: 2, dur: 2, text: 'Old path works.' },
    ];
    const ss2 = segmentCues(plain);
    expect(ss2.length).toBe(2);
    expect(ss2[0].start).toBeUndefined(); // 舊路徑不帶自 timing，由 assemble 從 cue 推
  });
});
