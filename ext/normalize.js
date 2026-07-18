// 將 YouTube timedtext fmt=json3 回應正規化為 cues 陣列（deterministic，開發原則 #1）。
// 格式依據：phase0/out/phase0b--a0ecQMq-rM.json 的真實 capture。
//
// json3 事件規則：
//   - 無 segs 的事件是視窗定義（wpWinPosId/wsWinStyleId），跳過
//   - aAppend === 1 的事件是 roll-up 捲動列（內容只有 "\n"），跳過
//   - 其餘每個事件是一列字幕；segs[].utf8 串接即為文字（ASR 為逐詞 seg，帶 tOffsetMs）

export function normalizeJson3(body) {
  const data = typeof body === 'string' ? JSON.parse(body) : body;
  if (!data || !Array.isArray(data.events)) throw new Error('json3 格式不符：缺 events');
  const cues = [];
  for (const ev of data.events) {
    if (!ev || ev.aAppend === 1 || !Array.isArray(ev.segs)) continue;
    if (!Number.isFinite(ev.tStartMs) || !Number.isFinite(ev.dDurationMs)) continue;
    const text = ev.segs
      .map((s) => (typeof s?.utf8 === 'string' ? s.utf8 : ''))
      .join('')
      .replace(/\s+/g, ' ')
      .trim();
    if (!text) continue;
    cues.push({ start: Math.round(ev.tStartMs) / 1000, dur: Math.round(ev.dDurationMs) / 1000, text });
  }
  cues.sort((a, b) => a.start - b.start || a.dur - b.dur);
  return cues;
}
