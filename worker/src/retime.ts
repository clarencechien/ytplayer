// B 治標 — 顯示鏈接（chaining）＋最短顯示時長（docs/subtitle-timing.md §2B）。
// 業界常規：句尾延伸到下一句開始（有上限）＋依譯文長度的最短顯示時間。
// 純函式、deterministic、**冪等**：原始結束時間存進 end0，重算永遠從 end0 出發 —
// 修正鈕重按、assemble 內建與鈕疊加，結果都不會漂移。

export interface RetimeCue {
  start: number;
  end: number;
  end0?: number; // 原始（語音）結束時間 — retime 的計算錨點，套用時自動補上
  zh?: string;
  kind?: string; // 'card' 不動 — 字卡的短促是刻意的
}

const GAP = 0.05; // 句與句之間保留的最小縫（避免疊顯）
const MAX_EXTEND = 3; // 鏈接延伸上限（秒）— 長靜默不拖著字幕不放
const LAST_EXTEND = 1.5; // 末句加映
const MIN_DUR_CAP = 6;

const minDurFor = (zh: string | undefined): number =>
  Math.min(MIN_DUR_CAP, Math.max(1.0, 0.9 + 0.05 * (zh?.length ?? 0)));

// 就地修改 cues 的 end（原值錨定在 end0），回傳被調整的句數
export function retimeCues(cues: RetimeCue[]): number {
  const speech = cues.filter((c) => c.kind !== 'card');
  let changed = 0;
  for (let i = 0; i < speech.length; i++) {
    const c = speech[i];
    const next = speech[i + 1];
    const base = c.end0 ?? c.end;
    let end = Math.max(base, c.start + minDurFor(c.zh)); // 最短顯示時長
    if (next) {
      if (next.start - end > 0) end = Math.min(next.start - GAP, end + MAX_EXTEND); // 鏈接
      end = Math.min(end, Math.max(next.start - GAP, c.start + 0.3)); // 永不越過下一句
    } else {
      end = end + LAST_EXTEND; // 末句加映
    }
    end = Math.round(end * 1000) / 1000;
    if (end !== c.end && end > c.start) {
      c.end0 = Math.round(base * 1000) / 1000;
      c.end = end;
      changed++;
    }
  }
  return changed;
}
