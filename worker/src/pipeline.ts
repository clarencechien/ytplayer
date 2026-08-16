// Phase 2 翻譯 pipeline：斷句 → glossary → 分塊翻譯 → deterministic 驗證組裝。
// 開發原則 #1：模型輸出視為敵意輸入 — 所有清洗與檢查都在這裡。

import type { Cue } from './validate';
import { segmentCues, type Sentence } from './segment';
import type { LlmFn } from './llm';
import { CORE_EXTRA, EXTENDED } from './twlexicon';
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
  hints: string[];
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

// 執法層（prompt 16 條 + speak-human-tw 策展追加）：命中觸發重譯
const CORE_BANNED: Array<[string, string]> = [...BANNED_WORDS, ...CORE_EXTRA];

export function scanBanned(zh: string): string[] {
  return CORE_BANNED.filter(([bad]) => {
    const cleaned = BANNED_EXCEPTIONS[bad] ? zh.replace(BANNED_EXCEPTIONS[bad], '') : zh;
    return cleaned.includes(bad);
  }).map(([bad]) => bad);
}

// 報告層（OpenCC TWPhrases 680 條）：命中只提示（hints），不觸發重譯、不影響驗收
// — 批量詞表允許少量誤報換覆蓋率，所以只能是建議不能是執法
export function scanExtended(zh: string): string[] {
  const hits: string[] = [];
  for (const [bad, good] of EXTENDED) {
    const cleaned = BANNED_EXCEPTIONS[bad] ? zh.replace(BANNED_EXCEPTIONS[bad], '') : zh;
    if (cleaned.includes(bad)) hits.push(`${bad}→${good}`);
  }
  return hits;
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

// id 連號檢查（gemini-api-lessons §6：index-keyed batch JSON 要驗 id）—
// 「id 對滑」會讓譯文通順卻對到錯句，自動品質指標測不到；重複與亂序是對滑的可偵測徵兆，
// 一律整包丟掉觸發重試（3.6-flash 實測踩過，這是它重新上場的前提檢查）
function assertIdSanity(arr: unknown[]): void {
  const seen = new Set<number>();
  let prev = -Infinity;
  for (const it of arr as Array<{ id?: unknown }>) {
    if (typeof it?.id !== 'number') continue;
    if (seen.has(it.id)) throw new Error(`輸出 id 重複（#${it.id}）— 疑似批次對滑`);
    seen.add(it.id);
    if (it.id < prev) throw new Error(`輸出 id 亂序（#${it.id} 出現在 #${prev} 之後）— 疑似批次對滑`);
    prev = it.id;
  }
}

function parseChunkOutput(
  raw: string,
  targets: Map<number, string> // id → 原文（fail-fast 檢查用）
): { byId: Map<number, { zh: string; note?: string }>; rejected: string[] } {
  const arr = cleanJson(raw);
  if (!Array.isArray(arr)) throw new Error('輸出不是 JSON 陣列');
  assertIdSanity(arr);
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
  chunk: TranslateChunkInput,
  sourceLang = 'en'
): Promise<{ byId: Map<number, string>; retries: number }> {
  const expected = new Set(chunk.target.map((s) => s.id));
  const parse = (raw: string): Map<number, string> => {
    const arr = cleanJson(raw);
    if (!Array.isArray(arr)) throw new Error('輸出不是 JSON 陣列');
    assertIdSanity(arr); // 修稿同樣是 index-keyed batch，同樣要防 id 對滑
    const byId = new Map<number, string>();
    for (const it of arr) {
      if (it && typeof it.id === 'number' && expected.has(it.id) && typeof it.en === 'string' && it.en.trim()) {
        byId.set(it.id, it.en.trim());
      }
    }
    return byId;
  };
  // 協定：模型只回「有修改的句子」（cost-optimization.md L2）— 所以「回傳筆數 < 句數」
  // 是正常結果，不是缺句。只有「解析失敗」才值得重試；空陣列 = 全部都不用改。
  let byId = new Map<number, string>();
  let retries = 0;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      byId = parse(await llm(buildRepairPrompt(meta, chunk, attempt > 0 ? '上一次輸出無法解析。務必輸出純 JSON 陣列（只放有修改的句子，全部都不用改就給 []）。' : undefined, sourceLang)));
      break;
    } catch {
      if (attempt === 0) retries++; // 解析失敗才重打；第二次仍失敗就當「無修改」放行
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
  const byId = new Map<number, { zh: string; note?: string }>();
  let retries = 0;
  const problems: string[] = [];
  let lastProblem = '';

  const missingIds = (): number[] => chunk.target.filter((s) => !byId.has(s.id)).map((s) => s.id);
  // 補丁只補「少數缺句」：大量缺句通常是輸出截斷，補丁救不了 → 留給整包重打/切半分治
  const patchable = (n: number): boolean => n > 0 && n <= Math.max(3, Math.ceil(expected * 0.25));

  // 只翻某幾句的小請求：語境仍給（前後各取 2 句），但只要求輸出這幾句 —
  // 「缺 1 句就重吐整包 40 句譯文」是帳單的大宗（cost-optimization.md L1）
  const subChunk = (ids: number[]): TranslateChunkInput => {
    const idx = new Map(chunk.target.map((s, i) => [s.id, i]));
    const first = idx.get(ids[0]) ?? 0;
    const last = idx.get(ids[ids.length - 1]) ?? chunk.target.length - 1;
    return {
      before: [...chunk.before, ...chunk.target.slice(Math.max(0, first - 2), first)].slice(-2),
      target: chunk.target.filter((s) => ids.includes(s.id)),
      after: [...chunk.target.slice(last + 1, last + 3), ...chunk.after].slice(0, 2),
    };
  };

  const runOnce = async (
    input: TranslateChunkInput,
    hint?: string
  ): Promise<{ accepted: number; rejected: string[] }> => {
    const want = new Map(input.target.map((s) => [s.id, s.text]));
    const { byId: parsed, rejected } = parseChunkOutput(
      await llm(buildTranslatePrompt(meta, glossary, input, hint, sourceLang)),
      want
    );
    let accepted = 0;
    for (const [id, v] of parsed) {
      if (!byId.has(id)) accepted++;
      byId.set(id, v);
    }
    return { accepted, rejected };
  };

  // 第一輪：整包
  try {
    const { rejected } = await runOnce(chunk);
    if (byId.size < expected) {
      lastProblem = rejected.length
        ? `${rejected.length} 句未過品質檢查：${rejected.slice(0, 3).join('、')}`
        : `預期 ${expected} 句只得到 ${byId.size} 句`;
    }
  } catch (e) {
    lastProblem = e instanceof Error ? e.message : String(e);
  }

  // 第二輪：少數缺句 → 只補那幾句（省輸出）；大量缺句 → 整包重打（可能是截斷）
  if (byId.size < expected) {
    retries++;
    const miss = missingIds();
    const hint = `上一次輸出有問題（${lastProblem}）。務必輸出純 JSON、繁體中文，且涵蓋所有 id。`;
    try {
      const { rejected } = patchable(miss.length) ? await runOnce(subChunk(miss), hint) : await runOnce(chunk, hint);
      if (byId.size < expected) {
        lastProblem = rejected.length
          ? `${rejected.length} 句未過品質檢查：${rejected.slice(0, 3).join('、')}`
          : `預期 ${expected} 句只得到 ${byId.size} 句`;
      }
    } catch (e) {
      lastProblem = e instanceof Error ? e.message : String(e);
    }
  }

  // 仍缺句且量大：切半分治一次（對付輸出截斷與單點毒句 — 整包重打救不了這兩種）
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

  // 崩塌偵測放在「合併之後」：補丁與分治會把結果拆成多次呼叫，
  // 單次呼叫內的重複檢查會漏掉跨呼叫的崩塌（同一句譯文 ≥3 次只留第一句）
  const dup = new Map<string, number[]>();
  for (const [id, v] of byId) {
    if (v.zh.length >= 6) dup.set(v.zh, [...(dup.get(v.zh) ?? []), id]);
  }
  for (const [zh, ids] of dup) {
    if (ids.length >= 3) {
      for (const id of ids.slice(1)) byId.delete(id);
      problems.push(`${ids.length - 1} 句重複譯文已丟棄（${zh.slice(0, 12)}…）`);
    }
  }
  if (byId.size < expected) problems.push(`缺 ${expected - byId.size} 句：${lastProblem}`);

  // 禁用詞：只重譯命中的那幾句（同樣不重吐整包），乾淨版本才採用
  const offenders = [...byId.entries()].filter(([, v]) => scanBanned(v.zh).length > 0);
  if (offenders.length > 0) {
    retries++;
    const hits = [...new Set(offenders.flatMap(([, v]) => scanBanned(v.zh)))];
    try {
      const ids = offenders.map(([id]) => id);
      const want = new Map(ids.map((id) => [id, targets.get(id)!]));
      const { byId: again } = parseChunkOutput(
        await llm(
          buildTranslatePrompt(meta, glossary, subChunk(ids), `上一次譯文出現禁用的中國用語：${hits.join('、')}。全部改為台灣慣用詞。`, sourceLang)
        ),
        want
      );
      for (const [id, v] of again) {
        if (scanBanned(v.zh).length === 0) byId.set(id, v); // 改乾淨了才換掉
      }
    } catch {
      /* 保留原結果，讓禁用詞掃描在組裝階段記 warning */
    }
  }

  return { byId, retries, problems };
}

// --- 組裝 ---

// 子句邊界漂移的偵測（deterministic，零成本）：ASR 句子是碎片，模型有時把子句邊界
// 跨 cue 重新分配 —— 語意總和沒錯，但單句會對不上（長原文卻只有兩三個字的譯文）。
// 這是既有現象（新舊版都有），列為 hints 讓它可見；不當執法條件（短譯文也可能是合理的）
const driftSuspect = (en: string, zh: string): boolean =>
  en.trim().split(/\s+/).length >= 6 && zh.trim().length <= 4;

export function assembleBilingual(
  sentences: Sentence[],
  cues: Cue[],
  byId: Map<number, { zh: string; note?: string }>
): { cues: BilingualCue[]; untranslated: number; bannedHits: string[]; extendedHits: string[]; driftCount: number } {
  const out: BilingualCue[] = [];
  let untranslated = 0;
  let driftCount = 0;
  const bannedHits: string[] = [];
  const extendedHits: string[] = [];
  for (const s of sentences) {
    const first = cues[s.cueIds[0]];
    const last = cues[s.cueIds[s.cueIds.length - 1]];
    const tr = byId.get(s.id);
    if (!tr) untranslated++;
    else {
      bannedHits.push(...scanBanned(tr.zh));
      extendedHits.push(...scanExtended(tr.zh));
      if (driftSuspect(s.text, tr.zh)) driftCount++;
    }
    out.push({
      // 詞級斷句的句子自帶精準起訖（docs/subtitle-timing.md A）；否則退回 cue 邊界
      start: Math.round((s.start ?? first.start) * 1000) / 1000,
      end: Math.round((s.end ?? last.start + last.dur) * 1000) / 1000,
      en: s.text,
      zh: tr?.zh ?? s.text,
      ...(tr?.note ? { note: tr.note } : {}),
      ...(tr ? {} : { untranslated: true }),
    });
  }
  return { cues: out, untranslated, bannedHits: [...new Set(bannedHits)], extendedHits: [...new Set(extendedHits)], driftCount };
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

// --- 路由表（migration.md §1）---

export interface SourceDoc {
  videoId: string;
  tier: number;
  sourceLang: string;
  meta: PromptMeta & { durationSec: number };
  track: { languageCode: string; kind?: string | null };
  cues: Cue[];
}

// 每支被 ingest 的軌走 text（純文字翻譯）或被拒。判準看「軌」不看 tier：
// - 中文軌拒收（Tier 1 使用者不滿意時 ingest「原文」軌 = 明示重做，走 text）
// - 人工原文軌 → text，不分語言
// - ASR 軌 → text，各語言開放（asr-language-experiment 決策）——除了：
//   - 韓文 ASR：未量測維持保守；字卡型韓綜本來就該走 video 路線（M3）
// - video 路線（Gemini 看片，Tier 3 字卡型 / Tier 4）於 M3 移植後加入
// 紅線不變：tlang 自動翻譯軌永不作為輸入（ext 端就不會送）。
export type Route = 'text' | 'reject';

export function routeSource(src: { track: { languageCode: string; kind?: string | null } }): {
  route: Route;
  reason?: string;
} {
  const lang = src.track.languageCode || '';
  if (/^zh/i.test(lang)) return { route: 'reject', reason: '中文軌不需要翻譯' };
  if (src.track.kind !== 'asr') return { route: 'text' };
  if (/^ko(-|$)/i.test(lang)) return { route: 'reject', reason: '韓文 ASR 未驗證；字卡型韓綜請走看片路線（M3 開放）' };
  return { route: 'text' };
}

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
      const { route, reason } = routeSource(doc);
      // 進行中/失敗的 job 狀態一併帶出，清單頁才看得到「卡在哪」
      const stObj = await env.SUBS.get(`subs/${videoId}/status.json`);
      const st = stObj
        ? (JSON.parse(await stObj.text()) as { stage?: string; step?: string; failed?: boolean; failReason?: string })
        : undefined;
      out.push({
        videoId,
        title: doc.meta?.title ?? videoId,
        translated: false,
        queued: route !== 'reject',
        ...(reason ? { reason } : {}),
        ...(st ? { stage: st.stage, step: st.step, ...(st.failed ? { failed: true, failReason: st.failReason } : {}) } : {}),
      });
    }
  }
  out.sort((a, b) => String(b.generatedAt ?? '').localeCompare(String(a.generatedAt ?? '')));
  return out;
}

