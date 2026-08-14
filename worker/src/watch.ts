// video 路由（Gemini 看片）— 自 kvsplayer（ytpoc）移植並 TS 化。
// 適用：Tier 3 字卡型（韓綜 — 語意在畫面字卡上，ASR 聽不到）與 Tier 4（無任何 CC）。
// 一次呼叫 = 聽寫 + 讀字卡 + 翻譯一個 3 分鐘段；時間戳為模型估算（trust: "model"）。
//
// kvsplayer 實戰驗證過的機制全數保留：
//   - covered_s 接續：輸出被截斷時從最後一句結尾補掃，不漏內容
//   - 失敗階梯：180s 段連炸兩次 → 降 60s 細掃 → 仍炸 → 跳過毒段（或判定片尾）
//   - open 模式：片長未知時掃到「無畫面」為止（CAP 防失控）
//   - No frames to extract = 影片實際結尾，立即收尾
// 移植時新增（migration.md §4「卡卡」修法）：speech 單調不重疊、最短顯示時長、同型重複合併保留。

export interface WatchCue {
  start: number;
  end: number;
  kind: 'speech' | 'card';
  orig: string; // 原文（韓綜=ko）
  zh: string;
}

// 掃描狀態（存在 JobStatus.watch 內，每段更新）
export interface WatchState {
  duration_s: number;
  open: boolean; // 片長是估的 → 掃到片尾偵測為止
  covered_s: number;
  done_segments: number;
  segments: number; // 估計總段數（顯示用，open 模式下浮動）
  try_len?: number; // 失敗降級後的細掃長度（60s）
  fail_count: number;
  fail_key: string;
  total_fails: number;
  skipped: number[];
  last_error?: string;
}

export const WATCH_SEG_S = 180; // 3 分鐘一段：6 分鐘會讓單次呼叫超時
const OPEN_CAP = 60; // open 模式段數上限（3 小時），防失控

export const initWatchState = (duration_s: number, open: boolean): WatchState => ({
  duration_s,
  open,
  covered_s: 0,
  done_segments: 0,
  segments: open ? 1 : Math.ceil(duration_s / WATCH_SEG_S),
  fail_count: 0,
  fail_key: '',
  total_fails: 0,
  skipped: [],
});

// --- Gemini 呼叫 ---

export interface WatchLlmArgs {
  videoId: string;
  startS: number;
  endS: number;
  glossary: string; // 譯名表 JSON 字串（頻道/genre 鎖定表）
}
export type WatchLlmFn = (args: WatchLlmArgs) => Promise<string>; // 回原始 JSON 文字（測試可注入）

const buildWatchPrompt = (a: WatchLlmArgs): string => `你是韓國綜藝字幕譯者兼轉錄員，處理影片 ${a.startS} 秒到 ${a.endS} 秒這一段。
譯名表（強制鎖定）：${a.glossary}
任務：
1. 聽出所有對話，依語意斷句成 cue（kind="speech"，orig=原文）。
2. 讀出「畫面字卡」（kind="card"）：只算補充性的效果字/吐槽/狀態說明/標題卡/題目卡。
   ⚠ 畫面下方與對白同步的內嵌字幕（常見「說話者名牌 | 對白內容」格式，內容跟講的話相同）
   是節目的對白字幕、不是字卡，**絕對不要輸出** — 同一句話只輸出一次 kind="speech"，名牌直接忽略。
3. 每個 cue 給台灣正體中文 zh：綜藝口語、台灣用詞（禁：視頻/質量/網絡/信息/軟件/屏幕/立馬）；
   zh 內禁止夾雜韓文字母或英文連接詞（and/but）；每行 ≤20 全形字，過長在語意邊界斷行
   （最多兩行，用 JSON 字串換行跳脫，勿輸出反斜線加 n 的字面文字）；沒把握句尾加⚠。
時間戳紀律：start/end 用 "MM:SS" 或 "H:MM:SS" 格式、整部影片的絕對時間
（此段從 ${Math.floor(a.startS / 60)}:${String(a.startS % 60).padStart(2, '0')} 開始）；**end 必須晚於 start**；
單句對白通常 2~8 秒；依出現順序單調遞增。
輸出 JSON 陣列（只輸出 JSON）：
[{"start":"MM:SS","end":"MM:SS","kind":"speech|card","orig":"...","zh":"..."}]
若此時間段已超出影片實際結尾，只輸出空陣列 []。`;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// thinking 刻意不設（＝維持模型預設）：看片是 reasoning-shaped（聽寫 + 讀字卡 + 估時間軸），
// 與 text 路由的機械性 JSON 轉換不同 — 對照 gemini-api-lessons §1 sukemu 的成對反例
//（P1 視覺降 minimal 會「穩定地歪」）。要改先做同片 A/B，別跟著 text 路由一起關。
//
// 真實呼叫：fileData(YouTube URL) + videoMetadata 時間窗。429/5xx/colo-400 小退避重試兩次，
// 其餘錯誤丟給失敗階梯處理（階梯才懂「這段是毒段還是片尾」）。
export function makeGeminiWatch(
  apiKey: string,
  model: string,
  mediaResolution: string,
  onTokens?: (n: number) => void
): WatchLlmFn {
  return async (a) => {
    for (let attempt = 0; ; attempt++) {
      const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-goog-api-key': apiKey },
        body: JSON.stringify({
          contents: [
            {
              parts: [
                {
                  fileData: { fileUri: `https://www.youtube.com/watch?v=${a.videoId}` },
                  videoMetadata: { startOffset: `${a.startS}s`, endOffset: `${a.endS}s` },
                },
                { text: buildWatchPrompt(a) },
              ],
            },
          ],
          generationConfig: {
            responseMimeType: 'application/json',
            temperature: 0.3,
            maxOutputTokens: 32768,
            mediaResolution,
            responseSchema: {
              type: 'ARRAY',
              items: {
                type: 'OBJECT',
                properties: {
                  start: { type: 'STRING' },
                  end: { type: 'STRING' },
                  kind: { type: 'STRING', enum: ['speech', 'card'] },
                  orig: { type: 'STRING' },
                  zh: { type: 'STRING' },
                },
                required: ['start', 'end', 'kind', 'zh'],
              },
            },
          },
        }),
      });
      if (r.ok) {
        const resp = (await r.json()) as {
          usageMetadata?: { totalTokenCount?: number };
          candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
        };
        if (onTokens && resp.usageMetadata?.totalTokenCount) onTokens(resp.usageMetadata.totalTokenCount);
        return (resp.candidates?.[0]?.content?.parts ?? []).map((p) => p.text ?? '').join('');
      }
      const body = (await r.text()).slice(0, 400);
      const retryable = r.status === 429 || r.status >= 500 || (r.status === 400 && body.includes('location is not supported'));
      if (attempt < 2 && retryable) {
        await sleep(1500 * (attempt + 1));
        continue;
      }
      throw new Error(`Gemini ${r.status}: ${body}`);
    }
  };
}

// countTokens 免費探測片長：影片 token 率約 300/秒（預設解析度）
export async function probeDuration(apiKey: string, model: string, videoId: string): Promise<number> {
  const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:countTokens`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-goog-api-key': apiKey },
    body: JSON.stringify({
      contents: [{ parts: [{ fileData: { fileUri: `https://www.youtube.com/watch?v=${videoId}` } }] }],
    }),
  });
  if (!r.ok) throw new Error(`countTokens ${r.status}: ${(await r.text()).slice(0, 200)}`);
  const total = ((await r.json()) as { totalTokens?: number }).totalTokens;
  if (!total || total < 300) throw new Error(`totalTokens=${total} 異常`);
  return Math.ceil(total / 300);
}

// oEmbed 抓標題（不被 bot 檢查擋）
export async function fetchTitle(videoId: string): Promise<string | null> {
  try {
    const r = await fetch(
      `https://www.youtube.com/oembed?url=https%3A%2F%2Fwww.youtube.com%2Fwatch%3Fv%3D${videoId}&format=json`
    );
    if (r.ok) return ((await r.json()) as { title?: string }).title ?? null;
  } catch {
    /* 拿不到就算了 */
  }
  return null;
}

// --- 段落輸出解析（截斷修復同 pipeline.cleanJson 的策略，但針對陣列-of-cue 特化）---

export function parseWatchOutput(raw: string, startS: number, endS: number): WatchCue[] {
  let cues: unknown;
  try {
    cues = JSON.parse(raw);
  } catch {
    // 輸出截斷或中途損壞：從尾端往前逐個 } 嘗試，收下壞點之前的所有完整 cue；
    // 壞點之後的內容由 covered_s 接續機制在下一段補掃，不丟內容
    let cut = raw.length;
    for (let i = 0; i < 200 && !Array.isArray(cues); i++) {
      cut = raw.lastIndexOf('}', cut - 1);
      if (cut < 0) break;
      try {
        cues = JSON.parse(raw.slice(0, cut + 1) + ']');
      } catch {
        /* 繼續回退 */
      }
    }
    if (!Array.isArray(cues)) throw new Error('Gemini 回傳無法修復的 JSON: ' + raw.slice(0, 120));
  }
  if (!Array.isArray(cues)) throw new Error('Gemini 回傳非陣列');
  const toSec = (v: unknown): number => {
    if (typeof v === 'number') return v;
    const p = String(v).trim().split(':').map(Number);
    return p.some(isNaN) ? NaN : p.reduce((a, b) => a * 60 + b, 0);
  };
  const out: WatchCue[] = [];
  for (const raw2 of cues as Array<Record<string, unknown>>) {
    if (!raw2 || !raw2.zh) continue;
    const s = toSec(raw2.start);
    const e = toSec(raw2.end);
    if (!isFinite(s) || !isFinite(e)) continue;
    out.push({
      start: Math.max(startS, +s.toFixed(2)),
      end: Math.min(endS + 2, +e.toFixed(2)),
      kind: raw2.kind === 'card' ? 'card' : 'speech',
      // kvsplayer 舊 schema 用 ko 欄位，相容讀取
      orig: String(raw2.orig ?? raw2.ko ?? ''),
      zh: String(raw2.zh).trim(),
    });
  }
  return out;
}

// --- 確定性清洗（合併所有段之後跑一次）---
// 保留 kvsplayer 規則：壞時間戳修正、speech 15s cap、韓文字母洩漏清除、
// card 與同步內嵌字幕判重、同型重複合併（重疊掃描造成）。
// 新增（播放「卡卡」的修法）：speech 排序後強制單調不重疊、最短顯示 0.3s。

const norm = (s: unknown): string =>
  String(s || '')
    .replace(/^[^|]*\|/, '')
    .replace(/[\s\p{P}\p{S}]+/gu, '');

export function sanitizeWatchCues(all: WatchCue[]): WatchCue[] {
  all.sort((a, b) => a.start - b.start);
  const speech = all.filter((c) => c.kind === 'speech');
  const out: WatchCue[] = [];
  for (const c of all) {
    const start = +c.start;
    let end = +c.end;
    if (!(end > start)) end = start + 4;
    if (c.kind === 'speech' && end - start > 15) end = start + 15;
    const zh = String(c.zh || '')
      .replace(/\\n/g, '\n')
      .replace(/\s+and\s+/g, '和')
      .replace(/\s+but\s+/g, '但')
      .replace(/[가-힣]+/g, '')
      .replace(/^[,。、·\s]+/, '')
      .trim();
    if (!zh) continue;
    if (c.kind === 'card') {
      const k = norm(c.orig);
      const dup =
        k &&
        speech.some((s2) => {
          if (Math.abs(+s2.start - start) > 6) return false;
          const ks = norm(s2.orig);
          return Boolean(ks && (k.includes(ks) || ks.includes(k) || (ks.length > 10 && k.includes(ks.slice(0, 10)))));
        });
      if (dup) continue;
    }
    out.push({ ...c, start: +start.toFixed(2), end: +end.toFixed(2), zh });
  }
  // 同型重複合併：重疊掃描（覆蓋接續、重送）會讓同一句話/同一張卡出現兩份
  const merged: WatchCue[] = [];
  for (const c of out) {
    const key = c.kind + '|' + (norm(c.orig) || norm(c.zh));
    let prev: WatchCue | null = null;
    for (let i = merged.length - 1; i >= 0 && merged[i].start > c.start - 30; i--) {
      if (merged[i].kind + '|' + (norm(merged[i].orig) || norm(merged[i].zh)) === key) {
        prev = merged[i];
        break;
      }
    }
    if (prev && c.start < prev.end + 3) {
      prev.end = Math.max(prev.end, c.end);
      continue;
    }
    merged.push({ ...c });
  }
  // speech 單調不重疊（模型估算的時間戳會彼此咬到 → 播放時疊字/閃爍）；card 走獨立圖層不處理
  let prevSpeech: WatchCue | null = null;
  for (const c of merged) {
    if (c.kind !== 'speech') continue;
    if (prevSpeech && c.start < prevSpeech.end) {
      prevSpeech.end = Math.max(prevSpeech.start + 0.3, +c.start.toFixed(2));
    }
    if (c.end - c.start < 0.3) c.end = +(c.start + 0.3).toFixed(2);
    prevSpeech = c;
  }
  return merged;
}

// --- 掃一段（成功路徑）：回傳新狀態與該段 cues。失敗階梯由呼叫端（jobs.ts）套用 ---

export interface SegmentPlan {
  n: number; // 段序（parts 檔名用）
  startS: number;
  endS: number;
  pastEnd: boolean; // 非 open 模式且已掃完 → 呼叫端直接進 assemble
}

export function nextSegment(w: WatchState): SegmentPlan {
  const SEG = w.try_len || WATCH_SEG_S;
  const startS = w.covered_s;
  const endS = w.open ? startS + SEG : Math.min(startS + SEG, w.duration_s);
  const pastEnd = !w.open && startS >= w.duration_s - 1;
  return { n: w.done_segments, startS, endS, pastEnd };
}

// 段落成功後推進狀態（截斷接續：從最後結束的句尾繼續，不漏內容）。
// kvsplayer 原版取「陣列最後一句」的 end，仰賴模型輸出按時間排序 — 改取最大 end 對亂序穩健
export function advance(w: WatchState, seg: SegmentPlan, cues: WatchCue[]): { ended: boolean } {
  w.done_segments += 1;
  delete w.try_len;
  w.fail_count = 0;
  const maxEnd = cues.reduce((m, c) => Math.max(m, +c.end), 0);
  w.covered_s = cues.length ? Math.min(seg.endS, Math.max(seg.startS + 10, maxEnd)) : seg.endS;
  const ended = w.open ? cues.length === 0 || w.done_segments >= OPEN_CAP : w.covered_s >= w.duration_s;
  w.segments = ended
    ? w.done_segments
    : w.open
      ? w.done_segments + 1
      : w.done_segments + Math.ceil((w.duration_s - w.covered_s) / (w.try_len || WATCH_SEG_S));
  return { ended };
}

// 段落失敗後套用階梯。回傳 'retry'（重投遞同段）| 'continue'（狀態已推進，直接下一段）| 'fatal'
export function applyFailureLadder(w: WatchState, errMsg: string): 'retry' | 'continue' | 'fatal' {
  const key = String(w.covered_s);
  w.fail_count = w.fail_key === key ? w.fail_count + 1 : 1;
  w.fail_key = key;
  w.last_error = errMsg.slice(0, 300);

  // Gemini 明確回報起點之後無畫面 = 影片實際結尾，立刻收尾
  if (/No frames to extract/i.test(errMsg)) {
    w.duration_s = w.covered_s;
    w.open = false;
    w.fail_count = 0;
    w.last_error = `片尾偵測：影片實際長度約 ${w.duration_s}s，收尾合併中`;
    return 'continue';
  }
  if (w.fail_count >= 2 && !w.try_len) {
    // 180s 段連炸兩次 → 降為 60s 細掃（幾乎都能過）
    w.try_len = 60;
    w.fail_count = 0;
    w.last_error += '（已降為 60 秒細掃）';
    return 'retry';
  }
  if (w.fail_count >= 3 && w.try_len) {
    const tailZone = !w.open && w.duration_s - w.covered_s <= 360;
    if (w.open || tailZone) {
      // 細掃仍炸且已在片尾附近：判定影片實際到此結束，正確收尾
      w.duration_s = w.covered_s;
      w.open = false;
      w.last_error = `片尾偵測：影片實際長度約 ${w.duration_s}s，收尾合併`;
    } else {
      // 中段毒段：只跳 60 秒
      w.skipped.push(w.covered_s);
      w.covered_s += 60;
      w.done_segments += 1;
      w.last_error = `已跳過 ${w.skipped[w.skipped.length - 1]}s 起的 60 秒（連續失敗）`;
    }
    w.fail_count = 0;
    return 'continue';
  }
  w.total_fails += 1;
  if (w.total_fails > 60) return 'fatal'; // kvsplayer 的全域保險絲：防自我續命變無限燒錢
  return 'retry';
}
