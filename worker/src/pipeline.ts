// Phase 2 翻譯 pipeline：斷句 → glossary → 分塊翻譯 → deterministic 驗證組裝。
// 開發原則 #1：模型輸出視為敵意輸入 — 所有清洗與檢查都在這裡。

import type { Cue } from './validate';
import { segmentCues, type Sentence } from './segment';
import type { LlmFn } from './llm';
import {
  PROMPT_VERSION,
  BANNED_WORDS,
  BANNED_EXCEPTIONS,
  buildGlossaryPrompt,
  buildTranslatePrompt,
  buildRepairPrompt,
  type PromptMeta,
  type TranslateChunkInput,
} from './prompts';

export interface GlossaryEntry {
  term: string;
  zh: string; // 呈現形式：「中文（English）」／保留英文／純中文
  note?: string; // 給非本科觀眾的白話解釋（30 字內）
}

export interface BilingualCue {
  start: number;
  end: number;
  en: string;
  zh: string;
  note?: string;
  untranslated?: boolean;
}

export interface PipelineStats {
  sentences: number;
  chunks: number;
  glossaryTerms: number;
  asrRepaired: number;
  autoNotes: number;
  llmCalls: number;
  retries: number;
  untranslated: number;
  warnings: string[];
  elapsedMs: number;
}

// --- 清洗工具 ---

export function cleanJson(text: string): unknown {
  const candidates = [text, text.replace(/^\s*```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '')];
  const first = text.indexOf('[');
  const last = text.lastIndexOf(']');
  if (first >= 0 && last > first) candidates.push(text.slice(first, last + 1));
  // 輸出中途被截斷（maxOutputTokens 等）：砍到最後一個完整物件再補右括號，救回部分結果
  const lastBrace = text.lastIndexOf('}');
  if (first >= 0 && lastBrace > first) candidates.push(text.slice(first, lastBrace + 1) + ']');
  for (const c of candidates) {
    try {
      return JSON.parse(c);
    } catch {
      /* 換下一個候選 */
    }
  }
  throw new Error(`LLM 輸出無法解析為 JSON（開頭：${text.slice(0, 80).replace(/\s+/g, ' ')}…）`);
}

export function scanBanned(zh: string): string[] {
  return BANNED_WORDS.filter(([bad]) => {
    const cleaned = BANNED_EXCEPTIONS[bad] ? zh.replace(BANNED_EXCEPTIONS[bad], '') : zh;
    return cleaned.includes(bad);
  }).map(([bad]) => bad);
}

// ASR 雜訊的 deterministic 清除（不能靠 LLM 保證）：[music]/[applause] 標記、「>>」換人說話記號
export function cleanAsrText(text: string): string {
  return text
    .replace(/\[[^\]]{1,30}\]/g, ' ')
    .replace(/(^|\s)>>+\s*/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// --- 分塊 ---

export function chunkSentences(sentences: Sentence[], size = 40, overlap = 2): TranslateChunkInput[] {
  const chunks: TranslateChunkInput[] = [];
  for (let i = 0; i < sentences.length; i += size) {
    chunks.push({
      before: sentences.slice(Math.max(0, i - overlap), i),
      target: sentences.slice(i, i + size),
      after: sentences.slice(i + size, i + size + overlap),
    });
  }
  return chunks;
}

// --- 逐句 fail-fast 品質檢查（deterministic，不用 LLM 自我審查）---
// 沒過的句子視同「缺句」，交給既有的重試／切半分治機制救。

// 只收「簡體獨有字形」——繁體也在用的字（行、里、干、据、号…）絕不能放，會誤殺
const SIMPLIFIED_CHARS =
  '们这说时发经过还让现观转边远运连达选问间际东车书学习业专众传势军农决义乐买亚会点为张长' +
  '导语难产严实断继续层岁师带帮开弹当态总恶战户换击敌旧构标欢汉满灭环电监笔类没' +
  '红纪约级纯纳纸线练组终结绝统维绿网罗罚脑脸节药见规觉览训议记许论设访证评识诉词译试话该详误读调谈谁请诺谢谱' +
  '贝负贡财责败货质购贴贵费资赛赞软轻载较辉迁违迟适逊递遗释钱铁银错键门闪闹闻阅阵阶陆陈队隐雾' +
  '须顶项顺顾顿预领题额风飞饭饮马验鱼鸟鸡麦齐';

export function sanityCheckItem(en: string, zh: string): string | null {
  for (const ch of zh) {
    if (SIMPLIFIED_CHARS.includes(ch)) return `疑似簡體字（${ch}）`;
  }
  const enWords = en.trim().split(/\s+/).length;
  if (enWords >= 4) {
    if (!/[぀-ヿ㐀-鿿]/.test(zh)) return '沒有中文（疑似原文照抄）';
    if (zh.trim() === en.trim()) return '原文照抄';
  }
  if (zh.length > en.length * 4 + 30) return '譯文長度異常';
  return null;
}

// --- 翻譯一個 chunk（含重試策略）---

export interface ChunkOutcome {
  byId: Map<number, { zh: string; note?: string }>;
  retries: number;
  problems: string[];
}

function parseChunkOutput(
  raw: string,
  targets: Map<number, string> // id → 原文（fail-fast 檢查用）
): { byId: Map<number, { zh: string; note?: string }>; rejected: string[] } {
  const arr = cleanJson(raw);
  if (!Array.isArray(arr)) throw new Error('輸出不是 JSON 陣列');
  const byId = new Map<number, { zh: string; note?: string }>();
  const rejected: string[] = [];
  for (const it of arr) {
    if (
      it &&
      typeof it.id === 'number' &&
      targets.has(it.id) &&
      typeof it.zh === 'string' &&
      it.zh.trim().length > 0
    ) {
      const zh = it.zh.trim();
      const reason = sanityCheckItem(targets.get(it.id)!, zh);
      if (reason) {
        rejected.push(`#${it.id} ${reason}`);
        continue; // 視同缺句，交給重試/分治
      }
      const note = typeof it.note === 'string' && it.note.trim() ? it.note.trim().slice(0, 60) : undefined;
      byId.set(it.id, { zh, note });
    }
  }
  // 崩塌偵測：同一句譯文（≥6 字）出現 3 次以上，只留第一句
  const dup = new Map<string, number[]>();
  for (const [id, v] of byId) {
    if (v.zh.length >= 6) dup.set(v.zh, [...(dup.get(v.zh) ?? []), id]);
  }
  for (const [zh, ids] of dup) {
    if (ids.length >= 3) {
      for (const id of ids.slice(1)) {
        byId.delete(id);
        rejected.push(`#${id} 重複譯文（${zh.slice(0, 12)}…）`);
      }
    }
  }
  return { byId, rejected };
}

// Phase 2.5 — 英文 ASR 修稿一個 chunk（缺句/解析失敗重試一次，仍缺的句子保留原文）
export async function repairChunk(
  llm: LlmFn,
  meta: PromptMeta,
  chunk: TranslateChunkInput
): Promise<{ byId: Map<number, string>; retries: number }> {
  const expected = new Set(chunk.target.map((s) => s.id));
  const parse = (raw: string): Map<number, string> => {
    const arr = cleanJson(raw);
    if (!Array.isArray(arr)) throw new Error('輸出不是 JSON 陣列');
    const byId = new Map<number, string>();
    for (const it of arr) {
      if (it && typeof it.id === 'number' && expected.has(it.id) && typeof it.en === 'string' && it.en.trim()) {
        byId.set(it.id, it.en.trim());
      }
    }
    return byId;
  };
  let byId = new Map<number, string>();
  let retries = 0;
  let lastProblem = '';
  for (let attempt = 0; attempt < 2 && byId.size < expected.size; attempt++) {
    if (attempt > 0) retries++;
    const hint = attempt > 0 ? `上一次輸出有問題（${lastProblem}）。務必輸出純 JSON，且涵蓋所有 id。` : undefined;
    try {
      const parsed = parse(await llm(buildRepairPrompt(meta, chunk, hint)));
      if (parsed.size > byId.size) byId = parsed;
      if (byId.size < expected.size) lastProblem = `預期 ${expected.size} 句只得到 ${byId.size} 句`;
    } catch (e) {
      lastProblem = e instanceof Error ? e.message : String(e);
    }
  }
  return { byId, retries };
}

export async function translateChunk(
  llm: LlmFn,
  meta: PromptMeta,
  glossary: GlossaryEntry[],
  chunk: TranslateChunkInput,
  sourceLang = 'en',
  depth = 0
): Promise<ChunkOutcome> {
  const targets = new Map(chunk.target.map((s) => [s.id, s.text]));
  const expected = targets.size;
  let byId = new Map<number, { zh: string; note?: string }>();
  let retries = 0;
  const problems: string[] = [];
  let lastProblem = '';

  // 最多兩輪：第一輪正常打，缺句/解析失敗/品質檢查未過再打一輪
  for (let attempt = 0; attempt < 2 && byId.size < expected; attempt++) {
    if (attempt > 0) retries++;
    const hint = attempt > 0 ? `上一次輸出有問題（${lastProblem}）。務必輸出純 JSON、繁體中文，且涵蓋所有 id。` : undefined;
    try {
      const { byId: parsed, rejected } = parseChunkOutput(
        await llm(buildTranslatePrompt(meta, glossary, chunk, hint, sourceLang)),
        targets
      );
      // 保留較完整的一輪
      if (parsed.size > byId.size) byId = parsed;
      if (byId.size < expected) {
        lastProblem = rejected.length
          ? `${rejected.length} 句未過品質檢查：${rejected.slice(0, 3).join('、')}`
          : `預期 ${expected} 句只得到 ${byId.size} 句`;
      }
    } catch (e) {
      lastProblem = e instanceof Error ? e.message : String(e);
    }
  }

  // 兩輪仍缺句：切半分治一次（對付輸出截斷與單點毒句 — 整包重打救不了這兩種）
  if (byId.size < expected && depth === 0 && chunk.target.length > 10) {
    const mid = Math.ceil(chunk.target.length / 2);
    const firstHalf: TranslateChunkInput = {
      before: chunk.before,
      target: chunk.target.slice(0, mid),
      after: chunk.target.slice(mid, mid + 2),
    };
    const secondHalf: TranslateChunkInput = {
      before: chunk.target.slice(Math.max(0, mid - 2), mid),
      target: chunk.target.slice(mid),
      after: chunk.after,
    };
    const [a, b] = await Promise.all([
      translateChunk(llm, meta, glossary, firstHalf, sourceLang, 1),
      translateChunk(llm, meta, glossary, secondHalf, sourceLang, 1),
    ]);
    retries += a.retries + b.retries + 1;
    problems.push(...a.problems, ...b.problems);
    for (const m of [a.byId, b.byId]) {
      for (const [id, v] of m) if (!byId.has(id)) byId.set(id, v);
    }
  }
  if (byId.size < expected) problems.push(`缺 ${expected - byId.size} 句：${lastProblem}`);

  // 禁用詞：命中則整個 chunk 帶提示重打一次，取「覆蓋不變差且命中較少」的結果
  const hits = [...byId.values()].flatMap((v) => scanBanned(v.zh));
  if (hits.length > 0) {
    retries++;
    try {
      const { byId: again } = parseChunkOutput(
        await llm(
          buildTranslatePrompt(meta, glossary, chunk, `上一次譯文出現禁用的中國用語：${[...new Set(hits)].join('、')}。全部改為台灣慣用詞。`, sourceLang)
        ),
        targets
      );
      const againHits = [...again.values()].flatMap((v) => scanBanned(v.zh));
      if (again.size >= byId.size && againHits.length < hits.length) byId = again;
    } catch {
      /* 保留原結果，讓禁用詞掃描在組裝階段記 warning */
    }
  }

  return { byId, retries, problems };
}

// --- 組裝 ---

export function assembleBilingual(
  sentences: Sentence[],
  cues: Cue[],
  byId: Map<number, { zh: string; note?: string }>
): { cues: BilingualCue[]; untranslated: number; bannedHits: string[] } {
  const out: BilingualCue[] = [];
  let untranslated = 0;
  const bannedHits: string[] = [];
  for (const s of sentences) {
    const first = cues[s.cueIds[0]];
    const last = cues[s.cueIds[s.cueIds.length - 1]];
    const tr = byId.get(s.id);
    if (!tr) untranslated++;
    else bannedHits.push(...scanBanned(tr.zh));
    out.push({
      start: Math.round(first.start * 1000) / 1000,
      end: Math.round((last.start + last.dur) * 1000) / 1000,
      en: s.text,
      zh: tr?.zh ?? s.text,
      ...(tr?.note ? { note: tr.note } : {}),
      ...(tr ? {} : { untranslated: true }),
    });
  }
  return { cues: out, untranslated, bannedHits: [...new Set(bannedHits)] };
}

// 術語第一次出現時，把 glossary 的白話註解附到該句（deterministic — chunk 平行翻譯，
// 模型不知道全片第一次出現在哪，這件事只能程式做。原則 #2：程式碼管品質地板）。
// 註格式「呈現形式：解釋」；一句最多 3 條註（含譯者的雙關註，多條以換行相疊）；
// 該句滿了才退到下一句含該術語處。三條都不夠解釋的內容屬跨領域，超出字幕範圍。
const MAX_NOTES_PER_CUE = 3;
const noteCount = (c: BilingualCue): number => (c.note ? c.note.split('\n').length : 0);

export function attachGlossaryNotes(cues: BilingualCue[], glossary: GlossaryEntry[]): number {
  let added = 0;
  for (const g of glossary) {
    if (!g.note || !/[A-Za-z]/.test(g.zh)) continue;
    // term 可能是 "harness / harness layer" 這種多形式，逐一嘗試
    const variants = g.term.split('/').map((v) => v.trim()).filter(Boolean);
    let target: BilingualCue | undefined;
    for (const v of variants) {
      const re = new RegExp(`\\b${v.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i');
      target = cues.find((c) => !c.untranslated && noteCount(c) < MAX_NOTES_PER_CUE && re.test(c.en));
      if (target) break;
    }
    if (target) {
      const line = `${g.zh}：${g.note}`.slice(0, 90);
      target.note = target.note ? `${target.note}\n${line}` : line;
      added++;
    }
  }
  return added;
}

const srtTime = (sec: number): string => {
  const ms = Math.max(0, Math.round(sec * 1000));
  const h = String(Math.floor(ms / 3600000)).padStart(2, '0');
  const m = String(Math.floor((ms % 3600000) / 60000)).padStart(2, '0');
  const s = String(Math.floor((ms % 60000) / 1000)).padStart(2, '0');
  const mmm = String(ms % 1000).padStart(3, '0');
  return `${h}:${m}:${s},${mmm}`;
};

export function toSrt(cues: BilingualCue[]): string {
  return cues
    .map((c, i) => `${i + 1}\n${srtTime(c.start)} --> ${srtTime(c.end)}\n${c.zh}\n${c.en}\n`)
    .join('\n');
}

// --- 主流程 ---

interface SourceDoc {
  videoId: string;
  tier: number;
  sourceLang: string;
  meta: PromptMeta & { durationSec: number };
  track: { languageCode: string; kind?: string | null };
  cues: Cue[];
}

// 可否翻譯改成看「被 ingest 的那條軌」而不是 tier：
// - 中文軌不用翻（拒收）
// - 人工原文軌 → 可翻，不分語言、不分 tier（Tier 1 使用者主動 ingest 原文軌 = 明示要重做）
// - ASR 軌 → 僅限英文（Phase 2.5 修稿路線）
export const canTranslate = (src: { track: { languageCode: string; kind?: string | null } }): boolean => {
  const lang = src.track.languageCode || '';
  if (/^zh/i.test(lang)) return false;
  if (src.track.kind !== 'asr') return true;
  return /^en(-|$)/i.test(lang);
};

export const untranslatableReason = (src: { track: { languageCode: string; kind?: string | null } }): string =>
  /^zh/i.test(src.track.languageCode || '') ? '中文軌不需要翻譯' : `非英文 ASR（${src.track.languageCode}）不支援`;

export interface PipelineEnv {
  SUBS: R2Bucket;
  GEMINI_API_KEY?: string;
  GEMINI_MODEL?: string;
}

// 清單頁資料：翻好的（有 info.json，缺的話從 bilingual.json 回填）+ 已 ingest 未翻的
export async function listVideos(
  env: PipelineEnv
): Promise<Array<Record<string, unknown>>> {
  const prefixes: string[] = [];
  let cursor: string | undefined;
  do {
    const res = await env.SUBS.list({ prefix: 'subs/', delimiter: '/', cursor });
    prefixes.push(...(res.delimitedPrefixes ?? []));
    cursor = res.truncated ? res.cursor : undefined;
  } while (cursor);

  const out: Array<Record<string, unknown>> = [];
  for (const p of prefixes) {
    const videoId = p.slice('subs/'.length).replace(/\/$/, '');
    if (!/^[A-Za-z0-9_-]{11}$/.test(videoId)) continue;
    const info = await env.SUBS.get(`subs/${videoId}/info.json`);
    if (info) {
      out.push({ ...(JSON.parse(await info.text()) as Record<string, unknown>), translated: true });
      continue;
    }
    const bil = await env.SUBS.get(`subs/${videoId}/bilingual.json`);
    if (bil) {
      // 舊資料回填 info.json
      const doc = JSON.parse(await bil.text()) as {
        meta?: { title?: string; channel?: string; durationSec?: number };
        generatedAt?: string;
        cues?: unknown[];
      };
      const entry = {
        videoId,
        title: doc.meta?.title ?? videoId,
        channel: doc.meta?.channel ?? '',
        durationSec: doc.meta?.durationSec ?? 0,
        cueCount: doc.cues?.length ?? 0,
        generatedAt: doc.generatedAt ?? '',
      };
      await env.SUBS.put(`subs/${videoId}/info.json`, JSON.stringify(entry), {
        httpMetadata: { contentType: 'application/json' },
      });
      out.push({ ...entry, translated: true });
      continue;
    }
    const srcObj = await env.SUBS.get(`subs/${videoId}/source.json`);
    if (srcObj) {
      const doc = JSON.parse(await srcObj.text()) as {
        meta?: { title?: string };
        track: { languageCode: string; kind?: string | null };
      };
      const queued = canTranslate(doc);
      out.push({
        videoId,
        title: doc.meta?.title ?? videoId,
        translated: false,
        queued,
        ...(queued ? {} : { reason: untranslatableReason(doc) }),
      });
    }
  }
  out.sort((a, b) => String(b.generatedAt ?? '').localeCompare(String(a.generatedAt ?? '')));
  return out;
}

// Cron 佇列：掃 R2 找「有 source.json 但 bilingual.json 缺少或過期」的 Tier 2 影片，
// 一次 cron 只翻一支（單支約 1–2 分鐘，避免 scheduled 事件跑太長）。
// 併發保護：.translating 鎖檔，10 分鐘視為 stale。
export async function translateNextPending(
  env: PipelineEnv,
  llmOverride?: LlmFn
): Promise<{ translated?: string; status?: number; scanned: number }> {
  const prefixes: string[] = [];
  let cursor: string | undefined;
  do {
    const res = await env.SUBS.list({ prefix: 'subs/', delimiter: '/', cursor });
    prefixes.push(...(res.delimitedPrefixes ?? []));
    cursor = res.truncated ? res.cursor : undefined;
  } while (cursor);

  let scanned = 0;
  for (const p of prefixes) {
    const videoId = p.slice('subs/'.length).replace(/\/$/, '');
    if (!/^[A-Za-z0-9_-]{11}$/.test(videoId)) continue;
    scanned++;

    const srcHead = await env.SUBS.head(`subs/${videoId}/source.json`);
    if (!srcHead) continue;
    const bilHead = await env.SUBS.head(`subs/${videoId}/bilingual.json`);
    if (bilHead && bilHead.uploaded >= srcHead.uploaded) continue; // 已是最新

    // 範圍先讀出來判斷，不符合直接跳過（不佔鎖、不進 pipeline）
    const srcObj = await env.SUBS.get(`subs/${videoId}/source.json`);
    if (!srcObj) continue;
    const srcDoc = JSON.parse(await srcObj.text()) as { track: { languageCode: string; kind?: string | null } };
    if (!canTranslate(srcDoc)) continue;

    const lock = await env.SUBS.head(`subs/${videoId}/.translating`);
    if (lock && Date.now() - lock.uploaded.getTime() < 10 * 60 * 1000) continue; // 有人在翻

    await env.SUBS.put(`subs/${videoId}/.translating`, new Date().toISOString());
    try {
      const r = await runPipeline(env, videoId, true, llmOverride);
      return { translated: videoId, status: r.status, scanned };
    } finally {
      await env.SUBS.delete(`subs/${videoId}/.translating`);
    }
  }
  return { scanned };
}

export async function runPipeline(
  env: PipelineEnv,
  videoId: string,
  force: boolean,
  llmOverride?: LlmFn
): Promise<{ status: number; body: Record<string, unknown> }> {
  const t0 = Date.now();
  const model = env.GEMINI_MODEL || 'gemini-3.5-flash';

  const srcObj = await env.SUBS.get(`subs/${videoId}/source.json`);
  if (!srcObj) return { status: 404, body: { ok: false, error: 'source.json 不存在，請先用 ext ingest' } };
  const src = JSON.parse(await srcObj.text()) as SourceDoc;
  if (!canTranslate(src)) {
    return { status: 422, body: { ok: false, error: `不在範圍：${untranslatableReason(src)}` } };
  }
  const needRepair = src.track.kind === 'asr';
  if (!llmOverride && !env.GEMINI_API_KEY) {
    return { status: 500, body: { ok: false, error: '未設定 GEMINI_API_KEY secret' } };
  }

  // cache：同 (videoId, lang, model, promptVersion) 直接回舊結果
  if (!force) {
    const cached = await env.SUBS.get(`subs/${videoId}/bilingual.json`);
    if (cached) {
      const doc = JSON.parse(await cached.text()) as Record<string, unknown>;
      if (doc.promptVersion === PROMPT_VERSION && doc.model === model && doc.sourceLang === src.track.languageCode) {
        return { status: 200, body: { ok: true, cached: true, cueCount: (doc.cues as unknown[]).length } };
      }
    }
  }

  // 防重試失控（原則 §8）：呼叫數硬上限
  let llmCalls = 0;
  const baseLlm = llmOverride ?? (await import('./llm')).geminiGenerate.bind(null, env.GEMINI_API_KEY!, model);
  let sentences = segmentCues(src.cues);
  const chunkCount = chunkSentences(sentences).length;
  const maxCalls = 6 + chunkCount * (needRepair ? 9 : 7); // 含切半分治的預算
  const llm: LlmFn = (prompt) => {
    if (++llmCalls > maxCalls) throw new Error(`LLM 呼叫超過上限 ${maxCalls} 次，中止（防重試失控）`);
    return baseLlm(prompt);
  };

  let retries = 0;
  let asrRepaired = 0;

  // Phase 2.5 — Step A'：英文 ASR 修稿（在斷句之後、glossary 之前）
  if (needRepair) {
    const rChunks = chunkSentences(sentences);
    const rOutcomes: Array<{ byId: Map<number, string>; retries: number }> = new Array(rChunks.length);
    let rNext = 0;
    await Promise.all(
      Array.from({ length: Math.min(4, rChunks.length) }, async () => {
        while (rNext < rChunks.length) {
          const idx = rNext++;
          rOutcomes[idx] = await repairChunk(llm, src.meta, rChunks[idx]);
        }
      })
    );
    const fixedById = new Map<number, string>();
    for (const o of rOutcomes) {
      retries += o.retries;
      for (const [id, en] of o.byId) fixedById.set(id, en);
    }
    // 套用修稿 + deterministic 清洗；清完是空的（純 [music]/>> 雜訊句）整句移除
    sentences = sentences.flatMap((s) => {
      const cleaned = cleanAsrText(fixedById.get(s.id) ?? s.text);
      if (!cleaned) {
        asrRepaired++;
        return [];
      }
      if (cleaned !== s.text) asrRepaired++;
      return [{ ...s, text: cleaned }];
    });
  }

  const chunks = chunkSentences(sentences);
  await env.SUBS.put(`subs/${videoId}/sentences.json`, JSON.stringify({ videoId, asrRepaired, sentences }), {
    httpMetadata: { contentType: 'application/json' },
  });

  // Step B — glossary（失敗重試一次，仍失敗就空表繼續並記 warning）
  let glossary: GlossaryEntry[] = [];
  const warnings: string[] = [];
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const parsed = cleanJson(await llm(buildGlossaryPrompt(src.meta, sentences, src.track.languageCode)));
      if (!Array.isArray(parsed)) throw new Error('glossary 不是陣列');
      glossary = parsed
        .map(
          (g): Partial<GlossaryEntry> => ({
            term: g?.term,
            zh: g?.zh ?? g?.suggested_zh, // 舊 schema 相容
            note: typeof g?.note === 'string' && g.note.trim() ? g.note.trim().slice(0, 60) : undefined,
          })
        )
        .filter((g): g is GlossaryEntry => typeof g.term === 'string' && typeof g.zh === 'string')
        .slice(0, 60);
      break;
    } catch (e) {
      if (attempt === 0) retries++;
      else warnings.push(`glossary 失敗，以空表續跑：${e instanceof Error ? e.message : e}`);
    }
  }
  await env.SUBS.put(`subs/${videoId}/glossary.json`, JSON.stringify({ videoId, model, glossary }), {
    httpMetadata: { contentType: 'application/json' },
  });

  // Step C — 分塊翻譯，並發 4
  const outcomes: ChunkOutcome[] = new Array(chunks.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(4, chunks.length) }, async () => {
    while (next < chunks.length) {
      const idx = next++;
      outcomes[idx] = await translateChunk(llm, src.meta, glossary, chunks[idx], src.track.languageCode);
    }
  });
  await Promise.all(workers);

  const byId = new Map<number, { zh: string; note?: string }>();
  for (let i = 0; i < outcomes.length; i++) {
    const o = outcomes[i];
    retries += o.retries;
    if (o.problems.length > 0) warnings.push(`chunk ${i + 1}/${outcomes.length}：${o.problems.join('；')}`);
    for (const [id, v] of o.byId) byId.set(id, v);
  }

  // Step D — 組裝與驗證
  const { cues, untranslated, bannedHits } = assembleBilingual(sentences, src.cues, byId);
  if (untranslated > 0) warnings.push(`${untranslated} 句翻譯失敗，以英文原文代替（標 untranslated）`);
  if (bannedHits.length > 0) warnings.push(`禁用詞殘留：${bannedHits.join('、')}`);
  const autoNotes = attachGlossaryNotes(cues, glossary);

  const bilingual = {
    videoId,
    meta: src.meta,
    sourceLang: src.track.languageCode,
    tier: src.tier,
    asrRepaired,
    model,
    promptVersion: PROMPT_VERSION,
    generatedAt: new Date().toISOString(),
    warnings,
    cues,
  };
  await env.SUBS.put(`subs/${videoId}/bilingual.json`, JSON.stringify(bilingual), {
    httpMetadata: { contentType: 'application/json' },
  });
  await env.SUBS.put(`subs/${videoId}/bilingual.srt`, toSrt(cues), {
    httpMetadata: { contentType: 'text/plain; charset=utf-8' },
  });
  // 小的 info.json 給清單頁用（避免列清單時整包 bilingual 讀出來）
  await env.SUBS.put(
    `subs/${videoId}/info.json`,
    JSON.stringify({
      videoId,
      title: src.meta.title,
      channel: src.meta.channel,
      durationSec: src.meta.durationSec,
      cueCount: cues.length,
      generatedAt: bilingual.generatedAt,
    }),
    { httpMetadata: { contentType: 'application/json' } }
  );

  const stats: PipelineStats = {
    sentences: sentences.length,
    chunks: chunks.length,
    glossaryTerms: glossary.length,
    asrRepaired,
    autoNotes,
    llmCalls,
    retries,
    untranslated,
    warnings,
    elapsedMs: Date.now() - t0,
  };
  return { status: 200, body: { ok: true, stats } };
}
