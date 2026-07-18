import { describe, it, expect } from 'vitest';
import { validateIngest } from '../src/validate';

const valid = () => ({
  videoId: 'ksfm6jeTg3Q',
  tier: 2,
  sourceLang: 'en',
  availableTracks: [
    { vssId: '.en', languageCode: 'en', kind: null, name: '英文' },
    { vssId: 'a.en', languageCode: 'en', kind: 'asr', name: '英文 (自動產生)' },
  ],
  meta: { title: 'Building the future', channel: 'Claude', description: 'desc', durationSec: 993 },
  track: { languageCode: 'en', kind: null, name: '英文', vssId: '.en', capturedFmt: 'json3' },
  cues: [
    { start: 3.48, dur: 3.04, text: 'When' },
    { start: 4.8, dur: 3.8, text: 'something' },
  ],
});

describe('validateIngest', () => {
  it('合法 payload 通過', () => {
    expect(validateIngest(valid())).toEqual([]);
  });

  it('紅線 D：track 帶 tlang 一律拒收', () => {
    const p = valid();
    (p.track as Record<string, unknown>).tlang = 'zh-Hant';
    expect(validateIngest(p)).toContain('track 含 tlang — 自動翻譯軌不可作為輸入');
  });

  it('availableTracks 帶 tlang 拒收', () => {
    const p = valid();
    (p.availableTracks[0] as Record<string, unknown>).tlang = 'zh-Hant';
    expect(validateIngest(p).some((e) => e.includes('tlang'))).toBe(true);
  });

  it('videoId 格式錯誤', () => {
    expect(validateIngest({ ...valid(), videoId: 'short' }).some((e) => e.includes('videoId'))).toBe(true);
    expect(validateIngest({ ...valid(), videoId: 'a'.repeat(12) }).some((e) => e.includes('videoId'))).toBe(true);
  });

  it('cues 為空 / 時間軸倒退 / start 為負都拒收', () => {
    expect(validateIngest({ ...valid(), cues: [] }).length).toBeGreaterThan(0);
    const back = valid();
    back.cues = [
      { start: 5, dur: 1, text: 'a' },
      { start: 3, dur: 1, text: 'b' },
    ];
    expect(validateIngest(back).some((e) => e.includes('遞增'))).toBe(true);
    const neg = valid();
    neg.cues = [{ start: -1, dur: 1, text: 'a' }];
    expect(validateIngest(neg).some((e) => e.includes('start'))).toBe(true);
  });

  it('tier 超界拒收', () => {
    expect(validateIngest({ ...valid(), tier: 5 }).some((e) => e.includes('tier'))).toBe(true);
    expect(validateIngest({ ...valid(), tier: 1.5 }).some((e) => e.includes('tier'))).toBe(true);
  });

  it('非物件 payload 拒收', () => {
    expect(validateIngest(null).length).toBe(1);
    expect(validateIngest([]).length).toBe(1);
    expect(validateIngest('x').length).toBe(1);
  });
});
