// Queues 任務系統（migration.md §2–§3）：pipeline 拆成有界小步，每步做完即落地 checkpoint。
//
// 設計原則（成本事故的直接教訓，見 asr-language-experiment.md §4.2）：
//   1. 無人看管的組件（cron、queue retry）單次決策成本為零 — 花錢步驟一律過保險絲
//   2. 先存檔後花更多錢：每步 1–2 分鐘內完成並寫 R2，被砍只損失一步
//   3. 失敗必須可見：status.json 開工即寫、每步更新
//   4. 重試必須有界：每步 3 次（Queues max_retries）→ 永久標記失敗，只有 ?force=1 能重啟
//
// 步驟鏈：plan → [repair:0..R-1] → glossary → translate:0..T-1 → assemble
// 每步冪等：輸出已存在（且對應同一版 source）就跳過工作直接接鏈，斷鏈由 cron 看門狗補。

import { segmentCues, type Sentence } from './segment';
import type { LlmFn } from './llm';
import { PROMPT_VERSION, buildGlossaryPrompt } from './prompts';
import {
  chunkSentences,
  repairChunk,
  translateChunk,
  cleanAsrText,
  cleanJson,
  assembleBilingual,
  attachGlossaryNotes,
  toSrt,
  routeSource,
  scanBanned,
  type SourceDoc,
  type GlossaryEntry,
  type BilingualCue,
  type PipelineStats,
} from './pipeline';
import { retimeCues } from './retime';
import {
  initWatchState,
  nextSegment,
  advance,
  applyFailureLadder,
  parseWatchOutput,
  sanitizeWatchCues,
  makeGeminiWatch,
  probeDuration,
  fetchTitle,
  WATCH_SEG_S,
  type WatchState,
  type WatchCue,
  type WatchLlmFn,
} from './watch';

export type JobStep = 'plan' | 'repair' | 'glossary' | 'translate' | 'watch' | 'assemble';
export interface JobMsg {
  videoId: string;
  step: JobStep;
  batch?: number;
  force?: boolean;
  route?: 'video'; // plan 專用：走看片路線（無此欄位 = text）
  model?: string; // plan 專用：本輪模型覆寫（A/B 測試用；整輪固定，記在 status.modelOverride）
}

// 一個 queue 批次步驟最多帶幾個 chunk（chunk=40 句）：4×40=160 句、併發 4，約 1–2 分鐘
const CHUNKS_PER_BATCH = 4;
// status.updatedAt 超過此值視為斷鏈（run 死了），看門狗才會重新 enqueue plan
export const STALE_MS = 10 * 60 * 1000;

export interface JobStatus {
  videoId: string;
  stage: JobStep | 'done' | 'failed' | 'paused';
  step?: string; // 例 "3/7"
  startedAt: string;
  updatedAt: string;
  // 本輪對應的輸入版本（text=source.json、video=watch.json 的 uploaded ISO）— 一切冪等判斷的錨點
  sourceUploaded: string;
  route: 'text' | 'video';
  repairBatches: number;
  translateBatches: number | null; // 修稿後才知道（空句會被移除）
  tokensUsed: number;
  llmCalls: number;
  retries: number;
  asrRepaired: number;
  warnings: string[];
  // token 流向拆解（帳單事故的診斷欄）：thinking 以輸出價計費，是成本大宗嫌疑犯
  promptTokens?: number;
  thoughtTokens?: number;
  modelOverride?: string; // /translate?model= 指定的本輪模型（A/B 測試）
  failed?: boolean;
  failReason?: string;
  // video 路由專用：分段掃描狀態（kvsplayer 的失敗階梯/覆蓋接續都在這）
  watch?: WatchState;
  title?: string;
}

export interface QueueLike {
  send(msg: JobMsg, opts?: { delaySeconds?: number }): Promise<unknown>;
}

export interface JobEnv {
  SUBS: R2Bucket;
  JOBS?: QueueLike;
  GEMINI_API_KEY?: string;
  GEMINI_MODEL?: string;
  GEMINI_MEDIA_RES?: string; // 看片解析度，預設 MEDIA_RESOLUTION_MEDIUM（LOW 省 4 倍但字卡辨識差）
  GEMINI_THINKING_BUDGET?: string; // text 路由 thinking 上限，預設 0（翻譯不需要推理；thinking 以輸出價計費）
  VIDEO_TOKEN_CAP?: string; // text 路由每片 token 上限（保險絲第 3 層），預設 500k
  WATCH_TOKEN_CAP?: string; // video 路由每片上限，預設 3M（看片 ≈ 300 tok/秒，30 分鐘 ≈ 54 萬 + 重試餘裕）
  DAILY_TOKEN_CAP?: string; // 每日全域 token 上限（第 4 層），預設 2M
}

// video 路由的 ingest 請求檔（admin 貼連結 / API 建立）
export interface WatchRequest {
  requestedAt: string;
  durationMin?: number; // 使用者提供片長 → 關閉 open 模式（countTokens 估算會低估）
  lang?: string; // 原文語言標籤，預設 ko
  title?: string;
}

// 本輪模型解析：status 覆寫 > env 預設。fallback 與 wrangler.jsonc 一致
export const modelOf = (env: JobEnv, st?: JobStatus | null): string =>
  st?.modelOverride || env.GEMINI_MODEL || 'gemini-3.6-flash';

const num = (v: string | undefined, dflt: number): number => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : dflt;
};

const jsonPut = (env: JobEnv, key: string, value: unknown): Promise<unknown> =>
  env.SUBS.put(key, JSON.stringify(value), { httpMetadata: { contentType: 'application/json' } });

const jsonGet = async <T>(env: JobEnv, key: string): Promise<T | null> => {
  const obj = await env.SUBS.get(key);
  return obj ? (JSON.parse(await obj.text()) as T) : null;
};

// --- 全域日預算（保險絲第 4 層）---
// R2 read-modify-write 沒有原子性，併發下會少算 — 保險絲是近似值可接受（寧可少算被
// Google 端配額接住，也不引入 DO/KV 依賴）。
const budgetKey = (): string => `budget/${new Date().toISOString().slice(0, 10)}.json`;

export async function readDailyBudget(env: JobEnv): Promise<{ tokens: number; calls: number }> {
  return (await jsonGet<{ tokens: number; calls: number }>(env, budgetKey())) ?? { tokens: 0, calls: 0 };
}

async function addDailyBudget(env: JobEnv, tokens: number, calls: number): Promise<void> {
  if (tokens === 0 && calls === 0) return;
  const b = await readDailyBudget(env);
  await jsonPut(env, budgetKey(), { tokens: b.tokens + tokens, calls: b.calls + calls, updatedAt: new Date().toISOString() });
}

// --- status ---

const statusKey = (id: string): string => `subs/${id}/status.json`;

async function writeStatus(env: JobEnv, st: JobStatus): Promise<void> {
  st.updatedAt = new Date().toISOString();
  await jsonPut(env, statusKey(st.videoId), st);
}

async function failStatus(env: JobEnv, videoId: string, reason: string): Promise<void> {
  const st = await jsonGet<JobStatus>(env, statusKey(videoId));
  if (!st) return;
  st.stage = 'failed';
  st.failed = true;
  st.failReason = reason;
  await writeStatus(env, st);
}

// --- 每步的 LLM 包裝：呼叫上限（防單步失控）+ token/call 計數（餵保險絲）---

interface StepMeter {
  tokens: number;
  calls: number;
  prompt: number;
  thoughts: number;
}

export const newMeter = (): StepMeter => ({ tokens: 0, calls: 0, prompt: 0, thoughts: 0 });

function makeStepLlm(
  env: JobEnv,
  meter: StepMeter,
  maxCalls: number,
  llmOverride?: LlmFn,
  model?: string
): LlmFn {
  model = model || env.GEMINI_MODEL || 'gemini-3.6-flash';
  // 翻譯/修稿是機械性 JSON 轉換，thinking 預設關（0）— 它以輸出價計費，實測是帳單大宗
  const thinkingBudget = env.GEMINI_THINKING_BUDGET != null ? Number(env.GEMINI_THINKING_BUDGET) : 128;
  return async (prompt) => {
    if (++meter.calls > maxCalls) throw new Error(`單步 LLM 呼叫超過上限 ${maxCalls} 次，中止（防重試失控）`);
    if (llmOverride) return llmOverride(prompt);
    const { geminiGenerate } = await import('./llm');
    return geminiGenerate(
      env.GEMINI_API_KEY!,
      model,
      prompt,
      (u) => {
        meter.tokens += u.total;
        meter.prompt += u.prompt;
        meter.thoughts += u.thoughts;
      },
      Number.isFinite(thinkingBudget) ? thinkingBudget : 128
    );
  };
}

// 步驟收尾：把本步的計量寫進 status 與日預算
async function settle(env: JobEnv, st: JobStatus, meter: StepMeter, retries = 0, asrRepaired = 0): Promise<void> {
  st.tokensUsed += meter.tokens;
  st.llmCalls += meter.calls;
  st.promptTokens = (st.promptTokens ?? 0) + meter.prompt;
  st.thoughtTokens = (st.thoughtTokens ?? 0) + meter.thoughts;
  st.retries += retries;
  st.asrRepaired += asrRepaired;
  await writeStatus(env, st);
  await addDailyBudget(env, meter.tokens, meter.calls);
}

// --- 各步驟 ---

export interface StepResult {
  status: number;
  body: Record<string, unknown>;
  next?: JobMsg;
  delaySeconds?: number; // next 的延遲投遞（看片失敗階梯的 30s 退避用）
}

interface PreDoc {
  sourceUploaded: string;
  sentences: Sentence[];
}

async function loadRun(
  env: JobEnv,
  videoId: string
): Promise<{ st: JobStatus; src: SourceDoc } | { restart: JobMsg } | { drop: string }> {
  const st = await jsonGet<JobStatus>(env, statusKey(videoId));
  const head = await env.SUBS.head(`subs/${videoId}/source.json`);
  if (!head) return { drop: 'source.json 不存在' };
  if (!st || st.failed) return { drop: st ? '已標記失敗，需 ?force=1 重啟' : '無 status，等看門狗重排' };
  // source 在跑到一半時被重新 ingest → 這輪作廢，重新計畫
  if (st.sourceUploaded !== head.uploaded.toISOString()) return { restart: { videoId, step: 'plan' } };
  const src = await jsonGet<SourceDoc>(env, `subs/${videoId}/source.json`);
  if (!src) return { drop: 'source.json 消失' };
  return { st, src };
}

// --- video 路由（Gemini 看片）---

async function loadVideoRun(
  env: JobEnv,
  videoId: string
): Promise<{ st: JobStatus } | { restart: JobMsg } | { drop: string }> {
  const st = await jsonGet<JobStatus>(env, statusKey(videoId));
  const head = await env.SUBS.head(`subs/${videoId}/watch.json`);
  if (!head) return { drop: 'watch.json 不存在' };
  if (!st || st.failed) return { drop: st ? '已標記失敗，需 ?force=1 重啟' : '無 status，等看門狗重排' };
  if (st.sourceUploaded !== head.uploaded.toISOString()) return { restart: { videoId, step: 'plan', route: 'video' } };
  if (!st.watch) return { restart: { videoId, step: 'plan', route: 'video' } };
  return { st };
}

async function planVideoStep(env: JobEnv, videoId: string, force: boolean): Promise<StepResult> {
  const reqHead = await env.SUBS.head(`subs/${videoId}/watch.json`);
  if (!reqHead) return { status: 404, body: { ok: false, error: 'watch.json 不存在，請先 POST /watch-job/{id}' } };
  const req = (await jsonGet<WatchRequest>(env, `subs/${videoId}/watch.json`))!;
  const sourceUploaded = reqHead.uploaded.toISOString();

  if (!force) {
    const bilHead = await env.SUBS.head(`subs/${videoId}/bilingual.json`);
    if (bilHead && bilHead.uploaded >= reqHead.uploaded) {
      const doc = await jsonGet<Record<string, unknown>>(env, `subs/${videoId}/bilingual.json`);
      if (doc && doc.route === 'video') {
        return { status: 200, body: { ok: true, cached: true, cueCount: (doc.cues as unknown[]).length } };
      }
    }
    const st0 = await jsonGet<JobStatus>(env, statusKey(videoId));
    if (
      st0 &&
      st0.sourceUploaded === sourceUploaded &&
      !st0.failed &&
      st0.stage !== 'done' &&
      Date.now() - new Date(st0.updatedAt).getTime() < STALE_MS
    ) {
      return { status: 202, body: { ok: true, alreadyRunning: true, stage: st0.stage, step: st0.step } };
    }
  }

  // token 計數跨輪累計（同 planStep：只有人為動作允許歸零）— 看片路線更貴，這層更要緊
  const prev = await jsonGet<JobStatus>(env, statusKey(videoId));
  const carry = prev && !force && prev.stage !== 'done' ? prev : undefined;
  const resume = !!carry && carry.sourceUploaded === sourceUploaded && !!carry.watch;
  if (!resume) {
    const parts = await env.SUBS.list({ prefix: `subs/${videoId}/parts/` });
    for (const o of parts.objects) await env.SUBS.delete(o.key);
  }

  // 片長：使用者提供優先（可靠）；否則 countTokens 探測 + open 模式（掃到片尾偵測為止）
  let duration_s: number;
  let open: boolean;
  if (req.durationMin && req.durationMin > 0) {
    duration_s = Math.round(req.durationMin * 60);
    open = false;
  } else if (resume) {
    duration_s = carry!.watch!.duration_s;
    open = carry!.watch!.open;
  } else {
    if (!env.GEMINI_API_KEY) return { status: 500, body: { ok: false, error: '未設定 GEMINI_API_KEY secret' } };
    duration_s = await probeDuration(env.GEMINI_API_KEY, env.GEMINI_MODEL || 'gemini-3.5-flash', videoId);
    open = true; // countTokens 會低估 → 開放式掃描
  }

  const title = req.title || (await fetchTitle(videoId)) || videoId;
  const st: JobStatus = {
    videoId,
    stage: 'watch',
    startedAt: new Date().toISOString(),
    updatedAt: '',
    sourceUploaded,
    route: 'video',
    repairBatches: 0,
    translateBatches: null,
    tokensUsed: carry?.tokensUsed ?? 0,
    llmCalls: carry?.llmCalls ?? 0,
    retries: carry?.retries ?? 0,
    promptTokens: carry?.promptTokens ?? 0,
    thoughtTokens: carry?.thoughtTokens ?? 0,
    asrRepaired: 0,
    warnings: [],
    // resume 時掃描進度接續（parts 保留、covered_s 續掃，已看過的段不重付）
    watch: resume ? carry!.watch! : initWatchState(duration_s, open),
    title,
  };
  await writeStatus(env, st);
  return {
    status: 202,
    body: { ok: true, planned: videoId, route: 'video', duration_s, segments: st.watch!.segments, open },
    next: { videoId, step: 'watch' },
  };
}

async function watchStep(env: JobEnv, videoId: string, watchOverride?: WatchLlmFn): Promise<StepResult> {
  const run = await loadVideoRun(env, videoId);
  if ('drop' in run) return { status: 200, body: { ok: false, dropped: run.drop } };
  if ('restart' in run) return { status: 202, body: { ok: true, restarted: true }, next: run.restart };
  const { st } = run;
  const w = st.watch!;

  const seg = nextSegment(w);
  if (seg.pastEnd) return { status: 202, body: { ok: true }, next: { videoId, step: 'assemble' } };

  const meter: StepMeter = newMeter();
  const watchLlm =
    watchOverride ??
    makeGeminiWatch(
      env.GEMINI_API_KEY!,
      modelOf(env, st),
      env.GEMINI_MEDIA_RES || 'MEDIA_RESOLUTION_MEDIUM',
      (n) => {
        meter.tokens += n;
      }
    );
  // 譯名表（頻道/genre 鎖定，跨片沿用 — kvsplayer 資產，M4 遷移時匯入 R2）
  const glossaryObj = await env.SUBS.get(`glossary/watch-${(await jsonGet<WatchRequest>(env, `subs/${videoId}/watch.json`))?.lang || 'ko'}.json`);
  const glossary = glossaryObj ? await glossaryObj.text() : '[]';

  try {
    meter.calls += 1;
    const raw = await watchLlm({ videoId, startS: seg.startS, endS: seg.endS, glossary });
    const cues = parseWatchOutput(raw, seg.startS, seg.endS);
    await jsonPut(env, `subs/${videoId}/parts/watch_${String(seg.n).padStart(2, '0')}.json`, {
      sourceUploaded: st.sourceUploaded,
      cues,
    });
    const { ended } = advance(w, seg, cues);
    st.stage = 'watch';
    st.step = `${w.done_segments}/${w.segments}`;
    await settle(env, st, meter);
    return {
      status: 202,
      body: { ok: true, segment: seg.n, cues: cues.length, covered_s: w.covered_s },
      next: ended ? { videoId, step: 'assemble' } : { videoId, step: 'watch' },
    };
  } catch (e) {
    // 失敗階梯自己管重試（縮段/跳毒段/片尾偵測需要超過 3 次投遞的壽命），
    // 一律 ack + 發新訊息；燒錢上限由 total_fails(60) 與 token 保險絲把守
    const msg = e instanceof Error ? e.message : String(e);
    const action = applyFailureLadder(w, msg);
    st.stage = 'watch';
    st.step = `${w.done_segments}/${w.segments}`;
    await settle(env, st, meter);
    if (action === 'fatal') {
      await failStatus(env, videoId, `看片累計失敗超過 60 次：${msg}`);
      return { status: 500, body: { ok: false, error: msg } };
    }
    return {
      status: 202,
      body: { ok: true, ladder: action, error: msg.slice(0, 120) },
      next: { videoId, step: 'watch' },
      delaySeconds: action === 'retry' ? 30 : 0,
    };
  }
}

async function assembleVideoStep(env: JobEnv, videoId: string, st: JobStatus): Promise<StepResult> {
  const w = st.watch!;
  const req = (await jsonGet<WatchRequest>(env, `subs/${videoId}/watch.json`))!;
  const all: WatchCue[] = [];
  for (let n = 0; n < w.done_segments; n++) {
    const part = await jsonGet<{ sourceUploaded: string; cues: WatchCue[] }>(
      env,
      `subs/${videoId}/parts/watch_${String(n).padStart(2, '0')}.json`
    );
    // 被跳過的毒段沒有 part（容忍）；版本不符的略過
    if (part && part.sourceUploaded === st.sourceUploaded) all.push(...part.cues);
  }
  const cues = sanitizeWatchCues(all);
  if (cues.length === 0) throw new Error('看片結果 0 cues，無法組裝');
  retimeCues(cues); // 顯示鏈接（speech only，字卡不動）

  const warnings = [...st.warnings];
  if (w.skipped.length > 0) warnings.push(`跳過 ${w.skipped.length} 個毒段（起點秒數：${w.skipped.join(', ')}）`);
  const banned = [...new Set(cues.flatMap((c) => scanBanned(c.zh)))];
  if (banned.length > 0) warnings.push(`禁用詞殘留：${banned.join('、')}`); // 看片重跑太貴，僅記錄不重試

  const model = modelOf(env, st);
  const bilingual = {
    videoId,
    schema: 2,
    meta: { title: st.title || videoId, channel: '', description: '', durationSec: w.duration_s },
    sourceLang: req.lang || 'ko',
    tier: 3,
    route: 'video',
    trust: 'model', // 時間軸為模型估算 — player 會提示
    asrRepaired: 0,
    model,
    promptVersion: PROMPT_VERSION,
    generatedAt: new Date().toISOString(),
    warnings,
    hints: [],
    cues,
  };
  await jsonPut(env, `subs/${videoId}/bilingual.json`, bilingual);
  await env.SUBS.put(
    `subs/${videoId}/bilingual.srt`,
    toSrt(cues.map((c) => ({ start: c.start, end: c.end, en: c.orig, zh: c.zh }))),
    { httpMetadata: { contentType: 'text/plain; charset=utf-8' } }
  );
  await jsonPut(env, `subs/${videoId}/info.json`, {
    videoId,
    title: st.title || videoId,
    channel: '',
    durationSec: w.duration_s,
    cueCount: cues.length,
    generatedAt: bilingual.generatedAt,
  });
  const parts = await env.SUBS.list({ prefix: `subs/${videoId}/parts/` });
  for (const o of parts.objects) await env.SUBS.delete(o.key);

  st.stage = 'done';
  st.step = undefined;
  st.warnings = warnings;
  await writeStatus(env, st);
  return {
    status: 200,
    body: {
      ok: true,
      stats: {
        cues: cues.length,
        cards: cues.filter((c) => c.kind === 'card').length,
        segments: w.done_segments,
        skipped: w.skipped,
        tokensUsed: st.tokensUsed,
        warnings,
      },
    },
  };
}

// --- text 路由 ---

async function planStep(env: JobEnv, videoId: string, force: boolean, modelOverride?: string): Promise<StepResult> {
  const srcHead = await env.SUBS.head(`subs/${videoId}/source.json`);
  if (!srcHead) return { status: 404, body: { ok: false, error: 'source.json 不存在，請先用 ext ingest' } };
  const src = await jsonGet<SourceDoc>(env, `subs/${videoId}/source.json`);
  if (!src) return { status: 404, body: { ok: false, error: 'source.json 不存在' } };

  const { route, reason } = routeSource(src);
  if (route === 'reject') return { status: 422, body: { ok: false, error: `不在範圍：${reason}` } };

  const sourceUploaded = srcHead.uploaded.toISOString();

  // cache：同 (source 版本, lang, model, promptVersion) 直接視為完成
  if (!force) {
    const bilHead = await env.SUBS.head(`subs/${videoId}/bilingual.json`);
    if (bilHead && bilHead.uploaded >= srcHead.uploaded) {
      const doc = await jsonGet<Record<string, unknown>>(env, `subs/${videoId}/bilingual.json`);
      const wantModel = modelOverride || env.GEMINI_MODEL || 'gemini-3.6-flash';
      if (doc && doc.promptVersion === PROMPT_VERSION && doc.model === wantModel && doc.sourceLang === src.track.languageCode) {
        return { status: 200, body: { ok: true, cached: true, cueCount: (doc.cues as unknown[]).length } };
      }
    }
    // 防重複開工：同版 source 的 run 還活著（10 分鐘內有更新）就不再排
    const st = await jsonGet<JobStatus>(env, statusKey(videoId));
    if (
      st &&
      st.sourceUploaded === sourceUploaded &&
      !st.failed &&
      st.stage !== 'done' &&
      Date.now() - new Date(st.updatedAt).getTime() < STALE_MS
    ) {
      return { status: 202, body: { ok: true, alreadyRunning: true, stage: st.stage, step: st.step } };
    }
  }

  // 保險絲完整性：上一輪還沒 done 就被重排（= 看門狗救斷鏈）時，token 計數必須跨輪累計 —
  // 否則「步驟反覆無聲死亡 → 看門狗每次重排歸零計數」會繞過每片上限，重演燒錢迴圈。
  // 人為動作（force、或上一輪已 done 的重新 ingest）才允許歸零。
  const prev = await jsonGet<JobStatus>(env, statusKey(videoId));
  const carry = prev && !force && prev.stage !== 'done' ? prev : undefined;
  const resume = !!carry && carry.sourceUploaded === sourceUploaded;

  // checkpoint：同版 source 的斷鏈重排 = 真 resume（parts 保留，鏈上冪等跳步不重付）；
  // force 或 source 換版才全清重來
  if (!resume) {
    const parts = await env.SUBS.list({ prefix: `subs/${videoId}/parts/` });
    for (const o of parts.objects) await env.SUBS.delete(o.key);
  }

  const needRepair = src.track.kind === 'asr';
  const sentences = segmentCues(src.cues);
  if (sentences.length === 0) return { status: 422, body: { ok: false, error: '沒有可翻譯的句子' } };
  const chunkCount = chunkSentences(sentences).length;

  const st: JobStatus = {
    videoId,
    stage: needRepair ? 'repair' : 'glossary',
    startedAt: new Date().toISOString(),
    updatedAt: '',
    sourceUploaded,
    route: 'text',
    repairBatches: needRepair ? Math.ceil(chunkCount / CHUNKS_PER_BATCH) : 0,
    translateBatches: needRepair ? null : Math.ceil(chunkCount / CHUNKS_PER_BATCH),
    tokensUsed: carry?.tokensUsed ?? 0,
    llmCalls: carry?.llmCalls ?? 0,
    retries: carry?.retries ?? 0,
    promptTokens: carry?.promptTokens ?? 0,
    thoughtTokens: carry?.thoughtTokens ?? 0,
    asrRepaired: 0,
    warnings: [],
    ...(modelOverride || carry?.modelOverride ? { modelOverride: modelOverride || carry?.modelOverride } : {}),
  };

  if (needRepair) {
    await jsonPut(env, `subs/${videoId}/parts/pre.json`, { sourceUploaded, sentences } satisfies PreDoc);
  } else {
    await jsonPut(env, `subs/${videoId}/sentences.json`, { videoId, asrRepaired: 0, sentences, sourceUploaded });
  }
  await writeStatus(env, st);
  return {
    status: 202,
    body: { ok: true, planned: videoId, repairBatches: st.repairBatches, chunks: chunkCount },
    next: needRepair ? { videoId, step: 'repair', batch: 0 } : { videoId, step: 'glossary' },
  };
}

async function repairStep(env: JobEnv, videoId: string, batch: number, llmOverride?: LlmFn): Promise<StepResult> {
  const run = await loadRun(env, videoId);
  if ('drop' in run) return { status: 200, body: { ok: false, dropped: run.drop } };
  if ('restart' in run) return { status: 202, body: { ok: true, restarted: true }, next: run.restart };
  const { st, src } = run;

  const nextMsg = (b: number): JobMsg =>
    b + 1 < st.repairBatches ? { videoId, step: 'repair', batch: b + 1 } : { videoId, step: 'glossary' };
  const partKey = `subs/${videoId}/parts/repair_${batch}.json`;

  // 冪等：這批已修完（同版 source）→ 直接接鏈
  const existing = await jsonGet<{ sourceUploaded: string }>(env, partKey);
  if (existing && existing.sourceUploaded === st.sourceUploaded) {
    return { status: 200, body: { ok: true, skipped: `repair ${batch} 已存在` }, next: nextMsg(batch) };
  }

  const pre = await jsonGet<PreDoc>(env, `subs/${videoId}/parts/pre.json`);
  if (!pre || pre.sourceUploaded !== st.sourceUploaded) {
    return { status: 202, body: { ok: true, restarted: true }, next: { videoId, step: 'plan' } };
  }
  const chunks = chunkSentences(pre.sentences).slice(batch * CHUNKS_PER_BATCH, (batch + 1) * CHUNKS_PER_BATCH);

  const meter: StepMeter = newMeter();
  const llm = makeStepLlm(env, meter, chunks.length * 3 + 2, llmOverride, modelOf(env, st));
  let retries = 0;
  const entries: Array<[number, string]> = [];
  const outcomes = await Promise.all(chunks.map((c) => repairChunk(llm, src.meta, c, src.track.languageCode)));
  for (const o of outcomes) {
    retries += o.retries;
    for (const [id, en] of o.byId) entries.push([id, en]);
  }
  await jsonPut(env, partKey, { sourceUploaded: st.sourceUploaded, entries, retries });

  st.stage = 'repair';
  st.step = `${batch + 1}/${st.repairBatches}`;
  await settle(env, st, meter, retries);
  return { status: 202, body: { ok: true, repaired: entries.length }, next: nextMsg(batch) };
}

async function glossaryStep(env: JobEnv, videoId: string, llmOverride?: LlmFn): Promise<StepResult> {
  const run = await loadRun(env, videoId);
  if ('drop' in run) return { status: 200, body: { ok: false, dropped: run.drop } };
  if ('restart' in run) return { status: 202, body: { ok: true, restarted: true }, next: run.restart };
  const { st, src } = run;

  // 修稿路線：先把 repair parts 合併成最終 sentences.json（deterministic、零 LLM、冪等）
  let asrRepairedDelta = 0;
  let sentencesDoc = await jsonGet<{ sentences: Sentence[]; sourceUploaded?: string; asrRepaired: number }>(
    env,
    `subs/${videoId}/sentences.json`
  );
  if (st.repairBatches > 0 && (!sentencesDoc || sentencesDoc.sourceUploaded !== st.sourceUploaded)) {
    const pre = await jsonGet<PreDoc>(env, `subs/${videoId}/parts/pre.json`);
    if (!pre || pre.sourceUploaded !== st.sourceUploaded) {
      return { status: 202, body: { ok: true, restarted: true }, next: { videoId, step: 'plan' } };
    }
    const fixedById = new Map<number, string>();
    for (let b = 0; b < st.repairBatches; b++) {
      const part = await jsonGet<{ sourceUploaded: string; entries: Array<[number, string]> }>(
        env,
        `subs/${videoId}/parts/repair_${b}.json`
      );
      if (!part || part.sourceUploaded !== st.sourceUploaded) throw new Error(`repair part ${b} 缺失，無法合併`);
      for (const [id, en] of part.entries) fixedById.set(id, en);
    }
    let asrRepaired = 0;
    const sentences = pre.sentences.flatMap((s) => {
      const cleaned = cleanAsrText(fixedById.get(s.id) ?? s.text);
      if (!cleaned) {
        asrRepaired++;
        return [];
      }
      if (cleaned !== s.text) asrRepaired++;
      return [{ ...s, text: cleaned }];
    });
    if (sentences.length === 0) throw new Error('修稿後沒有剩下任何句子');
    sentencesDoc = { videoId: videoId as never, asrRepaired, sentences, sourceUploaded: st.sourceUploaded } as never;
    await jsonPut(env, `subs/${videoId}/sentences.json`, sentencesDoc);
    asrRepairedDelta = asrRepaired;
  }
  if (!sentencesDoc) return { status: 202, body: { ok: true, restarted: true }, next: { videoId, step: 'plan' } };
  const sentences = sentencesDoc.sentences;
  st.translateBatches = Math.ceil(chunkSentences(sentences).length / CHUNKS_PER_BATCH);

  const model = modelOf(env, st);
  const meter: StepMeter = newMeter();
  let retries = 0;

  // 冪等：glossary 已是本輪產物就不重打
  const existing = await jsonGet<{ sourceUploaded?: string }>(env, `subs/${videoId}/glossary.json`);
  if (!existing || existing.sourceUploaded !== st.sourceUploaded) {
    const llm = makeStepLlm(env, meter, 4, llmOverride, modelOf(env, st));
    let glossary: GlossaryEntry[] = [];
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const parsed = cleanJson(await llm(buildGlossaryPrompt(src.meta, sentences, src.track.languageCode)));
        if (!Array.isArray(parsed)) throw new Error('glossary 不是陣列');
        glossary = parsed
          .map((g): Partial<GlossaryEntry> => ({
            term: g?.term,
            zh: g?.zh ?? g?.suggested_zh, // 舊 schema 相容
            note: typeof g?.note === 'string' && g.note.trim() ? g.note.trim().slice(0, 60) : undefined,
          }))
          .filter((g): g is GlossaryEntry => typeof g.term === 'string' && typeof g.zh === 'string')
          .slice(0, 60);
        break;
      } catch (e) {
        if (attempt === 0) retries++;
        else st.warnings.push(`glossary 失敗，以空表續跑：${e instanceof Error ? e.message : e}`);
      }
    }
    await jsonPut(env, `subs/${videoId}/glossary.json`, { videoId, model, sourceUploaded: st.sourceUploaded, glossary });
  }

  st.stage = 'glossary';
  st.step = undefined;
  await settle(env, st, meter, retries, asrRepairedDelta);
  return { status: 202, body: { ok: true }, next: { videoId, step: 'translate', batch: 0 } };
}

async function translateStep(env: JobEnv, videoId: string, batch: number, llmOverride?: LlmFn): Promise<StepResult> {
  const run = await loadRun(env, videoId);
  if ('drop' in run) return { status: 200, body: { ok: false, dropped: run.drop } };
  if ('restart' in run) return { status: 202, body: { ok: true, restarted: true }, next: run.restart };
  const { st, src } = run;
  const total = st.translateBatches ?? 0;
  if (total === 0) return { status: 202, body: { ok: true, restarted: true }, next: { videoId, step: 'plan' } };

  const nextMsg = (b: number): JobMsg =>
    b + 1 < total ? { videoId, step: 'translate', batch: b + 1 } : { videoId, step: 'assemble' };
  const partKey = `subs/${videoId}/parts/translate_${batch}.json`;

  const existing = await jsonGet<{ sourceUploaded: string }>(env, partKey);
  if (existing && existing.sourceUploaded === st.sourceUploaded) {
    return { status: 200, body: { ok: true, skipped: `translate ${batch} 已存在` }, next: nextMsg(batch) };
  }

  const sentencesDoc = await jsonGet<{ sentences: Sentence[]; sourceUploaded?: string }>(env, `subs/${videoId}/sentences.json`);
  const glossaryDoc = await jsonGet<{ glossary: GlossaryEntry[] }>(env, `subs/${videoId}/glossary.json`);
  if (!sentencesDoc || sentencesDoc.sourceUploaded !== st.sourceUploaded || !glossaryDoc) {
    return { status: 202, body: { ok: true, restarted: true }, next: { videoId, step: 'plan' } };
  }
  const allChunks = chunkSentences(sentencesDoc.sentences);
  const chunks = allChunks.slice(batch * CHUNKS_PER_BATCH, (batch + 1) * CHUNKS_PER_BATCH);

  const meter: StepMeter = newMeter();
  const llm = makeStepLlm(env, meter, chunks.length * 9 + 2, llmOverride, modelOf(env, st)); // 含切半分治與禁用詞重打的預算
  let retries = 0;
  const entries: Array<[number, { zh: string; note?: string }]> = [];
  const problems: string[] = [];
  const outcomes = await Promise.all(
    chunks.map((c) => translateChunk(llm, src.meta, glossaryDoc.glossary, c, src.track.languageCode))
  );
  for (let i = 0; i < outcomes.length; i++) {
    const o = outcomes[i];
    retries += o.retries;
    if (o.problems.length > 0) problems.push(`chunk ${batch * CHUNKS_PER_BATCH + i + 1}/${allChunks.length}：${o.problems.join('；')}`);
    for (const [id, v] of o.byId) entries.push([id, v]);
  }
  await jsonPut(env, partKey, { sourceUploaded: st.sourceUploaded, entries, problems, retries });

  st.stage = 'translate';
  st.step = `${batch + 1}/${total}`;
  await settle(env, st, meter, retries);
  return { status: 202, body: { ok: true, translated: entries.length }, next: nextMsg(batch) };
}

async function assembleStep(env: JobEnv, videoId: string): Promise<StepResult> {
  // video 路由的組裝走自己的邏輯（無 source.json）
  const st0 = await jsonGet<JobStatus>(env, statusKey(videoId));
  if (st0?.route === 'video') {
    const vrun = await loadVideoRun(env, videoId);
    if ('drop' in vrun) return { status: 200, body: { ok: false, dropped: vrun.drop } };
    if ('restart' in vrun) return { status: 202, body: { ok: true, restarted: true }, next: vrun.restart };
    return assembleVideoStep(env, videoId, vrun.st);
  }
  const run = await loadRun(env, videoId);
  if ('drop' in run) return { status: 200, body: { ok: false, dropped: run.drop } };
  if ('restart' in run) return { status: 202, body: { ok: true, restarted: true }, next: run.restart };
  const { st, src } = run;
  const model = modelOf(env, st);

  const sentencesDoc = await jsonGet<{ sentences: Sentence[]; asrRepaired: number; sourceUploaded?: string }>(
    env,
    `subs/${videoId}/sentences.json`
  );
  const glossaryDoc = await jsonGet<{ glossary: GlossaryEntry[] }>(env, `subs/${videoId}/glossary.json`);
  if (!sentencesDoc || sentencesDoc.sourceUploaded !== st.sourceUploaded || !glossaryDoc) {
    return { status: 202, body: { ok: true, restarted: true }, next: { videoId, step: 'plan' } };
  }

  const byId = new Map<number, { zh: string; note?: string }>();
  const warnings = [...st.warnings];
  const total = st.translateBatches ?? 0;
  for (let b = 0; b < total; b++) {
    const part = await jsonGet<{
      sourceUploaded: string;
      entries: Array<[number, { zh: string; note?: string }]>;
      problems: string[];
    }>(env, `subs/${videoId}/parts/translate_${b}.json`);
    if (!part || part.sourceUploaded !== st.sourceUploaded) throw new Error(`translate part ${b} 缺失，無法組裝`);
    warnings.push(...part.problems);
    for (const [id, v] of part.entries) byId.set(id, v);
  }

  const sentences = sentencesDoc.sentences;
  const { cues, untranslated, bannedHits, extendedHits } = assembleBilingual(sentences, src.cues, byId);
  retimeCues(cues); // B 治標內建：顯示鏈接 + 最短時長（docs/subtitle-timing.md）
  if (untranslated > 0) warnings.push(`${untranslated} 句翻譯失敗，以原文代替（標 untranslated）`);
  if (bannedHits.length > 0) warnings.push(`禁用詞殘留：${bannedHits.join('、')}`);
  const hints = extendedHits.length > 0 ? [`疑似中國用語（OpenCC 參考，僅提示）：${extendedHits.slice(0, 20).join('、')}`] : [];
  const autoNotes = attachGlossaryNotes(cues, glossaryDoc.glossary);

  // schema v2（migration.md §1）：orig 取代 en、kind 標記 speech/card、trust 標記信任等級
  const needRepair = src.track.kind === 'asr';
  const v2cues = cues.map(({ en, ...rest }: BilingualCue) => ({ ...rest, kind: 'speech' as const, orig: en }));
  const bilingual = {
    videoId,
    schema: 2,
    meta: src.meta,
    sourceLang: src.track.languageCode,
    tier: src.tier,
    route: 'text',
    trust: needRepair ? 'asr-repaired' : 'cc',
    asrRepaired: sentencesDoc.asrRepaired,
    model,
    promptVersion: PROMPT_VERSION,
    generatedAt: new Date().toISOString(),
    warnings,
    hints,
    cues: v2cues,
  };
  await jsonPut(env, `subs/${videoId}/bilingual.json`, bilingual);
  await env.SUBS.put(`subs/${videoId}/bilingual.srt`, toSrt(cues), {
    httpMetadata: { contentType: 'text/plain; charset=utf-8' },
  });
  await jsonPut(env, `subs/${videoId}/info.json`, {
    videoId,
    title: src.meta.title,
    channel: src.meta.channel,
    durationSec: src.meta.durationSec,
    cueCount: cues.length,
    generatedAt: bilingual.generatedAt,
  });

  // checkpoint 清掃（保留 sentences/glossary — 它們是可讀的中間產物）
  const parts = await env.SUBS.list({ prefix: `subs/${videoId}/parts/` });
  for (const o of parts.objects) await env.SUBS.delete(o.key);

  st.stage = 'done';
  st.step = undefined;
  st.asrRepaired = sentencesDoc.asrRepaired;
  st.warnings = warnings;
  await writeStatus(env, st);

  const stats: PipelineStats = {
    sentences: sentences.length,
    chunks: chunkSentences(sentences).length,
    glossaryTerms: glossaryDoc.glossary.length,
    asrRepaired: sentencesDoc.asrRepaired,
    autoNotes,
    llmCalls: st.llmCalls,
    retries: st.retries,
    untranslated,
    warnings,
    hints,
    elapsedMs: Date.now() - new Date(st.startedAt).getTime(),
  };
  return { status: 200, body: { ok: true, stats } };
}

// --- 步驟分派 ---

export async function runStep(
  env: JobEnv,
  msg: JobMsg,
  llmOverride?: LlmFn,
  watchOverride?: WatchLlmFn
): Promise<StepResult> {
  switch (msg.step) {
    case 'plan':
      return msg.route === 'video'
        ? planVideoStep(env, msg.videoId, msg.force === true)
        : planStep(env, msg.videoId, msg.force === true, msg.model);
    case 'repair':
      return repairStep(env, msg.videoId, msg.batch ?? 0, llmOverride);
    case 'glossary':
      return glossaryStep(env, msg.videoId, llmOverride);
    case 'translate':
      return translateStep(env, msg.videoId, msg.batch ?? 0, llmOverride);
    case 'watch':
      return watchStep(env, msg.videoId, watchOverride);
    case 'assemble':
      return assembleStep(env, msg.videoId);
  }
}

// --- queue consumer（保險絲都在這一層）---

export interface MsgLike {
  body: JobMsg;
  attempts: number;
  ack(): void;
  retry(opts?: { delaySeconds?: number }): void;
}

const LLM_STEPS: ReadonlySet<JobStep> = new Set(['repair', 'glossary', 'translate', 'watch']);

export async function handleJob(msg: MsgLike, env: JobEnv, llmOverride?: LlmFn, watchOverride?: WatchLlmFn): Promise<void> {
  const { videoId, step } = msg.body;
  try {
    if (LLM_STEPS.has(step)) {
      if (!llmOverride && !watchOverride && !env.GEMINI_API_KEY) throw new Error('未設定 GEMINI_API_KEY secret');
      const st = await jsonGet<JobStatus>(env, statusKey(videoId));
      // 保險絲第 3 層：每片 token 上限 → 永久失敗（只有 ?force=1 能重啟）
      // 看片路線成本高 ~30 倍，用獨立的較高上限
      const videoCap = st?.route === 'video' ? num(env.WATCH_TOKEN_CAP, 3_000_000) : num(env.VIDEO_TOKEN_CAP, 500_000);
      if (st && st.tokensUsed >= videoCap) {
        await failStatus(env, videoId, `token 用量 ${st.tokensUsed} 超過每片上限 ${videoCap}`);
        msg.ack();
        return;
      }
      // 保險絲第 4 層：日預算 → 暫停（不算失敗；隔日看門狗自動續跑）
      const dailyCap = num(env.DAILY_TOKEN_CAP, 2_000_000);
      const daily = await readDailyBudget(env);
      if (daily.tokens >= dailyCap) {
        if (st && !st.failed) {
          st.stage = 'paused';
          st.failReason = `日預算 ${daily.tokens}/${dailyCap} tokens 已用完，明日自動續跑`;
          await writeStatus(env, st);
        }
        msg.ack();
        return;
      }
    }
    const r = await runStep(env, msg.body, llmOverride, watchOverride);
    if (r.next && env.JOBS) await env.JOBS.send(r.next, r.delaySeconds ? { delaySeconds: r.delaySeconds } : undefined);
    msg.ack();
  } catch (e) {
    const reason = e instanceof Error ? e.message : String(e);
    // 保險絲第 2 層：3 次投遞仍失敗 → 永久標記，不再重試
    if (msg.attempts >= 3) {
      await failStatus(env, videoId, `${step} 步驟連續失敗：${reason}`);
      msg.ack();
    } else {
      msg.retry({ delaySeconds: 30 });
    }
  }
}

// --- cron 看門狗（零成本：只掃描與 enqueue，永不碰 LLM）---
// 角色：補漏。正常情況 ingest/translate 端點會直接 enqueue plan；訊息遺失或 run
// 斷鏈（status 超過 STALE_MS 沒更新）時由這裡重排。每輪最多排 2 支。

export async function watchdog(env: JobEnv): Promise<{ scanned: number; enqueued: string[] }> {
  const enqueued: string[] = [];
  if (!env.JOBS) return { scanned: 0, enqueued };

  const prefixes: string[] = [];
  let cursor: string | undefined;
  do {
    const res = await env.SUBS.list({ prefix: 'subs/', delimiter: '/', cursor });
    prefixes.push(...(res.delimitedPrefixes ?? []));
    cursor = res.truncated ? res.cursor : undefined;
  } while (cursor);

  let scanned = 0;
  for (const p of prefixes) {
    if (enqueued.length >= 2) break;
    const videoId = p.slice('subs/'.length).replace(/\/$/, '');
    if (!/^[A-Za-z0-9_-]{11}$/.test(videoId)) continue;
    scanned++;

    // 錨點：text=source.json、video=watch.json；兩者都有時取較新的那個當本輪輸入
    const srcHead = await env.SUBS.head(`subs/${videoId}/source.json`);
    const watchHead = await env.SUBS.head(`subs/${videoId}/watch.json`);
    const isVideo = !!watchHead && (!srcHead || watchHead.uploaded > srcHead.uploaded);
    const anchor = isVideo ? watchHead : srcHead;
    if (!anchor) continue;
    const bilHead = await env.SUBS.head(`subs/${videoId}/bilingual.json`);
    if (bilHead && bilHead.uploaded >= anchor.uploaded) continue; // 已是最新

    const st = await jsonGet<JobStatus>(env, statusKey(videoId));
    if (st && st.sourceUploaded === anchor.uploaded.toISOString()) {
      if (st.failed) continue; // 永久失敗，等人工 force
      if (Date.now() - new Date(st.updatedAt).getTime() < STALE_MS) continue; // run 還活著
      if (st.stage === 'paused' && st.updatedAt.slice(0, 10) === new Date().toISOString().slice(0, 10)) continue; // 日預算用完，今天不用再試
    }

    if (!isVideo) {
      const src = await jsonGet<SourceDoc>(env, `subs/${videoId}/source.json`);
      if (!src || routeSource(src).route === 'reject') continue;
    }

    await env.JOBS.send({ videoId, step: 'plan', ...(isVideo ? { route: 'video' as const } : {}) });
    enqueued.push(videoId);
  }
  return { scanned, enqueued };
}

// --- in-process 全程執行（測試與 wrangler dev 用；production 一律走 queue）---

export async function runPipeline(
  env: JobEnv,
  videoId: string,
  force: boolean,
  llmOverride?: LlmFn,
  route?: 'video',
  watchOverride?: WatchLlmFn
): Promise<{ status: number; body: Record<string, unknown> }> {
  let msg: JobMsg | undefined = { videoId, step: 'plan', force, ...(route ? { route } : {}) };
  let last: StepResult = { status: 500, body: { ok: false, error: '未執行任何步驟' } };
  for (let guard = 0; msg && guard < 200; guard++) {
    last = await runStep(env, msg, llmOverride, watchOverride);
    msg = last.next;
  }
  return { status: last.status, body: last.body };
}
