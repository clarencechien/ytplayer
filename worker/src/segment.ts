// Step A — 重新斷句（deterministic）。cue 合併成語意完整的句子，保留 cue 對應。
// Tier 2 輸入為人工 CC（有標點），以句末標點為主要邊界；時間 gap 與長度上限防呆。

import type { Cue } from './validate';

export interface Sentence {
  id: number;
  text: string;
  cueIds: number[];
  // 詞級斷句（cue 帶 segs）時句子自帶精準起訖；無則由 assemble 從 cueIds 推
  start?: number;
  end?: number;
}

// 句尾標點含 CJK（。！？、日文引號）；歌詞這類「整片無標點」的輸入
// 靠時間 gap 與長度上限兜底 — CJK 沒有空白可數詞，改數 CJK 字元
// （只數 CJK 字，英文照舊走 60 詞上限，不會被誤切）
const SENTENCE_END = /[.!?…。！？]["')\]」』]*$/;
const HARD_GAP_SEC = 2;
const MAX_WORDS = 60;
const MAX_CJK_CHARS = 60;
const cjkCount = (s: string): number => (s.match(/[぀-ヿ㐀-鿿가-힯]/g) ?? []).length;

// CJK 詞之間不插空白（json3 的 ja/ko seg 是無空白碎片），英文詞之間補回空白
const CJK_EDGE = /[぀-ヿ㐀-鿿가-힯][）」』】。！？、]*$|^[（「『【]*[぀-ヿ㐀-鿿가-힯]/;
const smartJoin = (words: string[]): string => {
  let out = '';
  for (const w of words) {
    if (!out) out = w;
    else if (CJK_EDGE.test(out) && CJK_EDGE.test(w)) out += w;
    else out += ' ' + w;
  }
  return out.replace(/\s+/g, ' ').trim();
};

// 詞級斷句（docs/subtitle-timing.md A）：cue 的 segs 攤平成詞流，句界落在「詞」上 —
// 消除「句界只能落在 cue 邊界」的量化誤差（ASR cue 常是跨句碎片）
function segmentByWords(cues: Cue[]): Sentence[] {
  interface Word { t: number; text: string; cueId: number; cueEnd: number }
  const words: Word[] = [];
  for (let i = 0; i < cues.length; i++) {
    const c = cues[i];
    const cueEnd = c.start + c.dur;
    if (c.segs && c.segs.length > 1) {
      for (const [off, w] of c.segs) words.push({ t: c.start + off, text: w, cueId: i, cueEnd });
    } else {
      const t = c.text.replace(/\s+/g, ' ').trim();
      if (t) words.push({ t: c.start, text: t, cueId: i, cueEnd });
    }
  }
  words.sort((a, b) => a.t - b.t);
  // 詞的結束時間：下一詞開始（上限 2 秒），末詞用該 cue 結束
  const wordEnd = (i: number): number => {
    const w = words[i];
    const next = words[i + 1];
    return next ? Math.min(Math.max(next.t, w.t + 0.15), w.t + 2) : Math.min(w.cueEnd, w.t + 2);
  };

  const sentences: Sentence[] = [];
  let buf: Word[] = [];
  const flush = (endIdx: number) => {
    if (!buf.length) return;
    const text = smartJoin(buf.map((w) => w.text));
    if (text) {
      sentences.push({
        id: sentences.length,
        text,
        cueIds: [...new Set(buf.map((w) => w.cueId))],
        start: Math.round(buf[0].t * 1000) / 1000,
        end: Math.round(wordEnd(endIdx) * 1000) / 1000,
      });
    }
    buf = [];
  };
  for (let i = 0; i < words.length; i++) {
    buf.push(words[i]);
    const next = words[i + 1];
    const joined = smartJoin(buf.map((w) => w.text));
    if (
      SENTENCE_END.test(words[i].text.trim()) ||
      (next && next.t - words[i].t > HARD_GAP_SEC) ||
      joined.split(/\s+/).length >= MAX_WORDS ||
      cjkCount(joined) >= MAX_CJK_CHARS ||
      !next
    ) {
      flush(i);
    }
  }
  flush(words.length - 1);
  return sentences;
}

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

  // 過半 cue 帶逐詞時間 → 詞級斷句（精準句界）
  if (cues.filter((c) => c.segs && c.segs.length > 1).length / Math.max(1, cues.length) > 0.5) {
    return segmentByWords(cues);
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
