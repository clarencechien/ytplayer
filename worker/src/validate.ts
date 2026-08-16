// POST /ingest payload 的 deterministic 驗證（開發原則 #1：外部輸入一律清洗檢查）。

export interface Cue {
  start: number;
  dur: number;
  text: string;
  // ASR 逐詞時間：[相對 cue start 的秒數, 詞]。詞級斷句用（docs/subtitle-timing.md）
  segs?: Array<[number, string]>;
}

export interface IngestPayload {
  videoId: string;
  tier: number;
  sourceLang: string;
  availableTracks: Array<Record<string, unknown>>;
  meta: {
    title: string;
    channel: string;
    channelId?: string; // UC… 頻道穩定鍵值（ext 抓得到才帶），glossary channel 疊層用
    description: string;
    durationSec: number;
  };
  track: Record<string, unknown>;
  cues: Cue[];
}

const VIDEO_ID = /^[A-Za-z0-9_-]{11}$/;
const UCID = /^UC[\w-]{22}$/;
const LANG = /^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})*$/;

export function validateIngest(p: unknown): string[] {
  const errors: string[] = [];
  if (typeof p !== 'object' || p === null || Array.isArray(p)) return ['payload 不是物件'];
  const o = p as Record<string, unknown>;

  if (typeof o.videoId !== 'string' || !VIDEO_ID.test(o.videoId)) errors.push('videoId 格式錯誤');
  if (typeof o.tier !== 'number' || !Number.isInteger(o.tier) || o.tier < 1 || o.tier > 4)
    errors.push('tier 必須是 1–4 的整數');
  if (typeof o.sourceLang !== 'string' || !LANG.test(o.sourceLang)) errors.push('sourceLang 格式錯誤');

  const meta = o.meta as Record<string, unknown> | undefined;
  if (typeof meta !== 'object' || meta === null) {
    errors.push('meta 缺失');
  } else {
    if (typeof meta.title !== 'string' || meta.title.length === 0) errors.push('meta.title 缺失');
    if (typeof meta.channel !== 'string') errors.push('meta.channel 缺失');
    // 選填：舊版 ext 沒有這欄（glossary 會退回名稱 slug）。有帶就必須是合法 ucid —
    // 錯的鍵值比沒有更糟（會靜靜地查不到 channel 表）
    if (meta.channelId !== undefined && (typeof meta.channelId !== 'string' || !UCID.test(meta.channelId)))
      errors.push('meta.channelId 格式錯誤（應為 UC 開頭 24 字）');
    if (typeof meta.description !== 'string' || meta.description.length > 4000)
      errors.push('meta.description 缺失或超過 4000 字');
    if (typeof meta.durationSec !== 'number' || !Number.isFinite(meta.durationSec) || meta.durationSec < 0)
      errors.push('meta.durationSec 錯誤');
  }

  const track = o.track as Record<string, unknown> | undefined;
  if (typeof track !== 'object' || track === null) {
    errors.push('track 缺失');
  } else {
    if (typeof track.languageCode !== 'string' || !LANG.test(track.languageCode as string))
      errors.push('track.languageCode 錯誤');
    // 紅線 D：自動翻譯軌永不作為輸入
    if ('tlang' in track) errors.push('track 含 tlang — 自動翻譯軌不可作為輸入');
  }

  if (!Array.isArray(o.availableTracks) || o.availableTracks.length > 100) {
    errors.push('availableTracks 缺失或超過 100 筆');
  } else if (o.availableTracks.some((t) => typeof t === 'object' && t !== null && 'tlang' in (t as object))) {
    errors.push('availableTracks 含 tlang');
  }

  const cues = o.cues;
  if (!Array.isArray(cues) || cues.length === 0 || cues.length > 20000) {
    errors.push('cues 缺失、為空或超過 20000 筆');
  } else {
    let prev = -Infinity;
    for (let i = 0; i < cues.length; i++) {
      const c = cues[i] as Record<string, unknown>;
      if (typeof c !== 'object' || c === null) { errors.push(`cues[${i}] 不是物件`); break; }
      if (typeof c.start !== 'number' || !Number.isFinite(c.start) || c.start < 0) { errors.push(`cues[${i}].start 錯誤`); break; }
      if (typeof c.dur !== 'number' || !Number.isFinite(c.dur) || c.dur < 0) { errors.push(`cues[${i}].dur 錯誤`); break; }
      if (typeof c.text !== 'string' || c.text.length === 0 || c.text.length > 2000) { errors.push(`cues[${i}].text 錯誤`); break; }
      if ((c.start as number) < prev) { errors.push(`cues[${i}] 時間軸未遞增`); break; }
      if (c.segs !== undefined) {
        const segs = c.segs;
        const bad =
          !Array.isArray(segs) ||
          segs.length > 500 ||
          segs.some(
            (s) =>
              !Array.isArray(s) ||
              s.length !== 2 ||
              typeof s[0] !== 'number' ||
              !Number.isFinite(s[0]) ||
              s[0] < 0 ||
              typeof s[1] !== 'string' ||
              (s[1] as string).length === 0 ||
              (s[1] as string).length > 200
          );
        if (bad) { errors.push(`cues[${i}].segs 格式錯誤`); break; }
      }
      prev = c.start as number;
    }
  }

  return errors;
}
