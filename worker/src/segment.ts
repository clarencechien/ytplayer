// Step A — 重新斷句（deterministic）。cue 合併成語意完整的句子，保留 cue 對應。
// Tier 2 輸入為人工 CC（有標點），以句末標點為主要邊界；時間 gap 與長度上限防呆。

import type { Cue } from './validate';

export interface Sentence {
  id: number;
  text: string;
  cueIds: number[];
}

// 句尾標點含 CJK（。！？、日文引號）；歌詞這類「整片無標點」的輸入
// 靠時間 gap 與長度上限兜底 — CJK 沒有空白可數詞，改數 CJK 字元
// （只數 CJK 字，英文照舊走 60 詞上限，不會被誤切）
const SENTENCE_END = /[.!?…。！？]["')\]」』]*$/;
const HARD_GAP_SEC = 2;
const MAX_WORDS = 60;
const MAX_CJK_CHARS = 60;
const cjkCount = (s: string): number => (s.match(/[぀-ヿ㐀-鿿가-힯]/g) ?? []).length;

export function segmentCues(cues: Cue[]): Sentence[] {
  // 軌型態偵測：整條軌幾乎沒有句尾標點（歌詞、逐行字幕）→ 合併沒有依據，
  // 尊重原始斷行與時間軸，一 cue 一句（原始 cue 邊界本身就是創作者的斷句資訊）
  const punctRatio = cues.filter((c) => SENTENCE_END.test(c.text.trim())).length / Math.max(1, cues.length);
  if (punctRatio < 0.1) {
    return cues
      .map((c, i) => ({ id: i, text: c.text.replace(/\s+/g, ' ').trim(), cueIds: [i] }))
      .filter((s) => s.text.length > 0)
      .map((s, id) => ({ ...s, id }));
  }

  const sentences: Sentence[] = [];
  let buf: string[] = [];
  let ids: number[] = [];

  const flush = () => {
    const text = buf.join(' ').replace(/\s+/g, ' ').trim();
    if (text && ids.length) sentences.push({ id: sentences.length, text, cueIds: ids });
    buf = [];
    ids = [];
  };

  for (let i = 0; i < cues.length; i++) {
    const cue = cues[i];
    buf.push(cue.text);
    ids.push(i);
    const next = cues[i + 1];
    const gap = next ? next.start - (cue.start + cue.dur) : Infinity;
    const joined = buf.join(' ');
    const words = joined.split(/\s+/).length;
    if (
      SENTENCE_END.test(cue.text.trim()) ||
      gap > HARD_GAP_SEC ||
      words >= MAX_WORDS ||
      cjkCount(joined) >= MAX_CJK_CHARS ||
      !next
    ) {
      flush();
    }
  }
  flush();
  return sentences;
}
