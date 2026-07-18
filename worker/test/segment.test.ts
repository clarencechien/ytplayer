import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { segmentCues } from '../src/segment';
import type { Cue } from '../src/validate';

const fixture = JSON.parse(
  readFileSync(new URL('./fixtures/source--a0ecQMq-rM.json', import.meta.url), 'utf8')
) as { cues: Cue[] };

describe('segmentCues', () => {
  it('真實 fixture（707 cues）：每個 cue 恰好屬於一個句子且順序連續', () => {
    const sentences = segmentCues(fixture.cues);
    const covered = sentences.flatMap((s) => s.cueIds);
    expect(covered).toEqual([...Array(fixture.cues.length).keys()]);
    expect(sentences.length).toBeGreaterThan(50);
    expect(sentences.length).toBeLessThan(fixture.cues.length);
    for (const s of sentences) expect(s.text.length).toBeGreaterThan(0);
    expect(sentences[0].text.startsWith("When you're dealing")).toBe(true);
  });

  it('以句末標點斷句，並保留 cueIds 對應', () => {
    const cues: Cue[] = [
      { start: 0, dur: 2, text: 'Hello world' },
      { start: 2, dur: 2, text: 'this is a test.' },
      { start: 4, dur: 2, text: 'Second sentence!' },
    ];
    const s = segmentCues(cues);
    expect(s).toEqual([
      { id: 0, text: 'Hello world this is a test.', cueIds: [0, 1] },
      { id: 1, text: 'Second sentence!', cueIds: [2] },
    ]);
  });

  it('時間 gap 超過 2 秒硬切（沒有標點也切）', () => {
    const cues: Cue[] = [
      { start: 0, dur: 2, text: 'before gap' },
      { start: 10, dur: 2, text: 'after gap.' },
    ];
    const s = segmentCues(cues);
    expect(s.map((x) => x.text)).toEqual(['before gap', 'after gap.']);
  });

  it('引號/括號跟在句末標點後仍算句尾', () => {
    const cues: Cue[] = [
      { start: 0, dur: 2, text: 'He said "go."' },
      { start: 2, dur: 2, text: 'Then left.' },
    ];
    expect(segmentCues(cues).length).toBe(2);
  });

  it('超過 60 詞硬切防跑飛', () => {
    const word = 'word';
    const cues: Cue[] = Array.from({ length: 10 }, (_, i) => ({
      start: i,
      dur: 1,
      text: Array(10).fill(word).join(' '),
    }));
    const s = segmentCues(cues);
    expect(s.length).toBeGreaterThan(1);
  });
});
