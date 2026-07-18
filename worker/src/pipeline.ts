// Phase 2 翻譯 pipeline：斷句 → glossary → 分塊翻譯 → deterministic 驗證組裝。
// 開發原則 #1：模型輸出視為敵意輸入 — 所有清洗與檢查都在這裡。

import type { Cue } from './validate';
import { segmentCues, type Sentence } from './segment';
import type { LlmFn } from './llm';
import {
  PROMPT_VERSION,
  BANNED_WORDS,
  buildGlossaryPrompt,
  buildTranslatePrompt,
  type PromptMeta,
  type TranslateChunkInput,
} from './prompts';

export interface GlossaryEntry {
  term: string;
  suggested_zh: string;
  note?: string;
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
  for (const c of candidates) {
    try {
      return JSON.parse(c);
    } catch {
      /* 換下一個候選 */
    }
  }
  throw new Error('LLM 輸出無法解析為 JSON');
}

export function scanBanned(zh: string): string[] {
  return BANNED_WORDS.filter(([bad]) => zh.includes(bad)).map(([bad]) => bad);
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

// --- 翻譯一個 chunk（含重試策略）---

export interface ChunkOutcome {
  byId: Map<number, { zh: string; note?: string }>;
  retries: number;
}

function parseChunkOutput(raw: string, expected: Set<number>): Map<number, { zh: string; note?: string }> {
  const arr = cleanJson(raw);
  if (!Array.isArray(arr)) throw new Error('輸出不是 JSON 陣列');
  const byId = new Map<number, { zh: string; note?: string }>();
  for (const it of arr) {
    if (
      it &&
      typeof it.id === 'number' &&
      expected.has(it.id) &&
      typeof it.zh === 'string' &&
      it.zh.trim().length > 0
    ) {
      const note = typeof it.note === 'string' && it.note.trim() ? it.note.trim().slice(0, 40) : undefined;
      byId.set(it.id, { zh: it.zh.trim(), note });
    }
  }
  return byId;
}

export async function translateChunk(
  llm: LlmFn,
  meta: PromptMeta,
  glossary: GlossaryEntry[],
  chunk: TranslateChunkInput
): Promise<ChunkOutcome> {
  const expected = new Set(chunk.target.map((s) => s.id));
  let byId = new Map<number, { zh: string; note?: string }>();
  let retries = 0;
  let lastProblem = '';

  // 最多兩輪：第一輪正常打，缺句/解析失敗再打一輪
  for (let attempt = 0; attempt < 2 && byId.size < expected.size; attempt++) {
    if (attempt > 0) retries++;
    const hint = attempt > 0 ? `上一次輸出有問題（${lastProblem}）。務必輸出純 JSON，且涵蓋所有 id。` : undefined;
    try {
      const parsed = parseChunkOutput(await llm(buildTranslatePrompt(meta, glossary, chunk, hint)), expected);
      // 保留較完整的一輪
      if (parsed.size > byId.size) byId = parsed;
      if (byId.size < expected.size) lastProblem = `預期 ${expected.size} 句只得到 ${byId.size} 句`;
    } catch (e) {
      lastProblem = e instanceof Error ? e.message : String(e);
    }
  }

  // 禁用詞：命中則整個 chunk 帶提示重打一次，取「覆蓋不變差且命中較少」的結果
  const hits = [...byId.values()].flatMap((v) => scanBanned(v.zh));
  if (hits.length > 0) {
    retries++;
    try {
      const again = parseChunkOutput(
        await llm(
          buildTranslatePrompt(meta, glossary, chunk, `上一次譯文出現禁用的中國用語：${[...new Set(hits)].join('、')}。全部改為台灣慣用詞。`)
        ),
        expected
      );
      const againHits = [...again.values()].flatMap((v) => scanBanned(v.zh));
      if (again.size >= byId.size && againHits.length < hits.length) byId = again;
    } catch {
      /* 保留原結果，讓禁用詞掃描在組裝階段記 warning */
    }
  }

  return { byId, retries };
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
  track: { languageCode: string };
  cues: Cue[];
}

export interface PipelineEnv {
  SUBS: R2Bucket;
  GEMINI_API_KEY?: string;
  GEMINI_MODEL?: string;
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
  if (src.tier !== 2) {
    return { status: 422, body: { ok: false, error: `tier ${src.tier} 不在 POC 範圍（append-01 §E：只處理 Tier 2）` } };
  }
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
  const sentences = segmentCues(src.cues);
  const chunks = chunkSentences(sentences);
  const maxCalls = 4 + chunks.length * 3;
  const llm: LlmFn = (prompt) => {
    if (++llmCalls > maxCalls) throw new Error(`LLM 呼叫超過上限 ${maxCalls} 次，中止（防重試失控）`);
    return baseLlm(prompt);
  };

  await env.SUBS.put(`subs/${videoId}/sentences.json`, JSON.stringify({ videoId, sentences }), {
    httpMetadata: { contentType: 'application/json' },
  });

  // Step B — glossary（失敗重試一次，仍失敗就空表繼續並記 warning）
  let glossary: GlossaryEntry[] = [];
  const warnings: string[] = [];
  let retries = 0;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const parsed = cleanJson(await llm(buildGlossaryPrompt(src.meta, sentences)));
      if (!Array.isArray(parsed)) throw new Error('glossary 不是陣列');
      glossary = parsed
        .filter((g): g is GlossaryEntry => !!g && typeof g.term === 'string' && typeof g.suggested_zh === 'string')
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
      outcomes[idx] = await translateChunk(llm, src.meta, glossary, chunks[idx]);
    }
  });
  await Promise.all(workers);

  const byId = new Map<number, { zh: string; note?: string }>();
  for (const o of outcomes) {
    retries += o.retries;
    for (const [id, v] of o.byId) byId.set(id, v);
  }

  // Step D — 組裝與驗證
  const { cues, untranslated, bannedHits } = assembleBilingual(sentences, src.cues, byId);
  if (untranslated > 0) warnings.push(`${untranslated} 句翻譯失敗，以英文原文代替（標 untranslated）`);
  if (bannedHits.length > 0) warnings.push(`禁用詞殘留：${bannedHits.join('、')}`);

  const bilingual = {
    videoId,
    meta: src.meta,
    sourceLang: src.track.languageCode,
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

  const stats: PipelineStats = {
    sentences: sentences.length,
    chunks: chunks.length,
    glossaryTerms: glossary.length,
    llmCalls,
    retries,
    untranslated,
    warnings,
    elapsedMs: Date.now() - t0,
  };
  return { status: 200, body: { ok: true, stats } };
}
