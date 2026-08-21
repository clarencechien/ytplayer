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
import type { LlmFn, Thinking } from './llm';
import { PROMPT_VERSION, buildGlossaryPrompt, type PromptMeta } from './prompts';
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
  needsRetranslate,
  countCpsOver,
  stripGloss,
  CPS_TARGET,
  type SourceDoc,
  type GlossaryEntry,
  type BilingualCue,
  type PipelineStats,
  type TranslateProtocol,
} from './pipeline';
import { retimeCues } from './retime';
import {
  loadChannelLayer,
  loadGenreLayer,
  mergeGlossary,
  channelKeys,
  type LayeredEntry,
} from './glossary'; // 疊層合併（docs/glossary-layers.md G1）
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

export type JobStep = 'plan' | 'repair' | 'glossary' | 'translate' | 'watch' | 'assemble' | 'patch';
// 補譯要修哪一種毛病（docs/subtitle-readability.md R4b）：
//   untranslated = 未譯／原文照抄（預設，assemble 自動接的那條）
//   cps          = 顯示時間讀不完，重譯成更短的說法
//   all          = 兩種一起（同一次 LLM 呼叫，省一趟）
export type PatchMode = 'untranslated' | 'cps' | 'all';
export interface JobMsg {
  videoId: string;
  step: JobStep;
  batch?: number;
  force?: boolean;
  route?: 'video'; // plan 專用：走看片路線（無此欄位 = text）
  model?: string; // plan 專用：本輪模型覆寫（A/B 測試用；整輪固定，記在 status.modelOverride）
  mode?: PatchMode; // patch 專用
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
  // 未譯句數（assemble/patch 後更新）：儀表板要看得到，不能只躺在 bilingual.json 裡
  untranslated?: number;
  cpsOver?: number; // 顯示時間讀不完的句數（R1 指標，「📏 壓縮」按鈕會用）
  patchRounds?: number; // 補譯輪數（上限 2 — 補不動的就是補不動，別無限燒）
  // 這支片第一次翻完的時刻。**耗時要用它算，不能用 updatedAt** ——
  // 事後補譯／壓縮會推進 updatedAt，拿它減 startedAt 會把「幾天後按了一次按鈕」
  // 顯示成「跑了 7229 分鐘」，看起來像失控燒錢（2026-08-21 實際誤會過一次）
  doneAt?: string;
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
  // thinking 旋鈕（gemini-api-lessons §1）：預設 minimal（唯一實測歸零的檔位）。
  // GEMINI_THINKING_BUDGET 是 legacy 逃生口；兩者都設時以 level 為準（永不同時送出）
  GEMINI_THINKING_LEVEL?: string;
  GEMINI_THINKING_BUDGET?: string;
  VIDEO_TOKEN_CAP?: string; // text 路由每片 token 上限（保險絲第 3 層），預設 500k
  WATCH_TOKEN_CAP?: string; // video 路由每片上限，預設 3M（看片 ≈ 300 tok/秒，30 分鐘 ≈ 54 萬 + 重試餘裕）
  DAILY_TOKEN_CAP?: string; // 每日全域 token 上限（第 4 層），預設 2M
  CHUNK_SIZE?: string; // 每 chunk 句數，預設 40（lite 級模型建議 20 — gemini-api-lessons §2）
  // 翻譯輸出協定（docs/future-ideas.md F2）：預設 id（含回聲對位 t）。
  // 'array' = 按位置對齊的純字串陣列，給 lite 級模型用 —— **尚未通過 A/B 驗證，預設不啟用**；
  // 要開必須同時把 CHUNK_SIZE 調小（10–15），因為它無法部分成功（長度不符整包重來）
  TRANSLATE_PROTOCOL?: string;
  // 字幕閱讀速度預算（docs/subtitle-readability.md R1）：預設開。
  // 設 'off' 關掉 —— A/B 對照組用，也是「模型壓縮得太過頭」時的 kill switch
  CPS_BUDGET?: string;
}

// video 路由的 ingest 請求檔（admin 貼連結 / API 建立）
export interface WatchRequest {
  requestedAt: string;
  durationMin?: number; // 使用者提供片長 → 關閉 open 模式（countTokens 估算會低估）
  lang?: string; // 原文語言標籤，預設 ko
  title?: string;
  channel?: string; // glossary channel 鎖定表鍵值（例 15ya）；看片路線沒有頻道 meta，只能人工指定
}

const chunkSize = (env: JobEnv): number => {
  const n = Number(env.CHUNK_SIZE);
  return Number.isFinite(n) && n >= 10 && n <= 100 ? n : 40;
};

// 本輪模型解析：status 覆寫 > env 預設。fallback 與 wrangler.jsonc 一致
export const modelOf = (env: JobEnv, st?: JobStatus | null): string =>
  st?.modelOverride || env.GEMINI_MODEL || 'gemini-3.5-flash';

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
  model = model || env.GEMINI_MODEL || 'gemini-3.5-flash';
  // 翻譯/修稿是機械性 JSON 轉換 → thinking 關到底。level 'minimal' 是唯一實測 thoughts=0 的檔位；
  // budget 是「預算」不是硬上限（實測 budget 128 在真實 prompt 上仍漏 507 thoughts，見 llm.ts）
  const budgetVar = Number(env.GEMINI_THINKING_BUDGET);
  const thinking: Thinking = env.GEMINI_THINKING_LEVEL
    ? { level: env.GEMINI_THINKING_LEVEL }
    : env.GEMINI_THINKING_BUDGET != null && Number.isFinite(budgetVar)
      ? { budget: budgetVar }
      : { level: 'minimal' };
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
      thinking
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
  // 譯名表 = merge(① channel, ② genre)（G1）。看片路線沒有 channel meta，鎖定表由
  // watch.json 的 channel 欄位人工指定（/admin 表單）；沒指定就只吃 genre —— 這正是
  // 「A 節目的人名不會塞進 B 節目的 prompt」的修法。內建表讓它不依賴任何匯入動作。
  const wreq = await jsonGet<WatchRequest>(env, `subs/${videoId}/watch.json`);
  const lang = wreq?.lang || 'ko';
  const merged = mergeGlossary({
    channel: (await loadChannelLayer(env.SUBS, wreq?.channel ? [wreq.channel] : [])).entries,
    genre: await loadGenreLayer(env.SUBS, lang),
  });
  const glossary = JSON.stringify(merged.map(({ term, zh }) => ({ term, zh })));

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
  st.doneAt = bilingual.generatedAt;
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
      const wantModel = modelOverride || env.GEMINI_MODEL || 'gemini-3.5-flash';
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
  const chunkCount = chunkSentences(sentences, chunkSize(env)).length;

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
  const chunks = chunkSentences(pre.sentences, chunkSize(env)).slice(batch * CHUNKS_PER_BATCH, (batch + 1) * CHUNKS_PER_BATCH);

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
  st.translateBatches = Math.ceil(chunkSentences(sentences, chunkSize(env)).length / CHUNKS_PER_BATCH);

  const model = modelOf(env, st);
  const meter: StepMeter = newMeter();
  let retries = 0;

  // 冪等：glossary 已是本輪產物就不重打
  const existing = await jsonGet<{ sourceUploaded?: string }>(env, `subs/${videoId}/glossary.json`);
  if (!existing || existing.sourceUploaded !== st.sourceUploaded) {
    const llm = makeStepLlm(env, meter, 4, llmOverride, modelOf(env, st));
    let auto: GlossaryEntry[] = [];
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const parsed = cleanJson(await llm(buildGlossaryPrompt(src.meta, sentences, src.track.languageCode)));
        if (!Array.isArray(parsed)) throw new Error('glossary 不是陣列');
        auto = parsed
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
    // 疊層合併（G1）：人工養的 ①② 壓過當片自動抽的 ③ —— 這是「好譯法能沉澱」的機制。
    // ①② 是 R2 上的人工檔，改了不會自動觸發重翻（便宜、可預期）；要套用新表請 ?force=1
    const channel = await loadChannelLayer(env.SUBS, channelKeys(src.meta));
    const genre = await loadGenreLayer(env.SUBS, src.track.languageCode);
    const glossary: LayeredEntry[] = mergeGlossary({ channel: channel.entries, genre, auto });
    await jsonPut(env, `subs/${videoId}/glossary.json`, {
      videoId,
      model,
      sourceUploaded: st.sourceUploaded,
      // 層來源（除錯用）：譯法怪掉時一眼看出是誰貢獻的那條
      layers: {
        channelKey: channel.key ?? null,
        channel: channel.entries.length,
        genre: genre.length,
        auto: auto.length,
        merged: glossary.length,
      },
      glossary,
    });
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
  const allChunks = chunkSentences(sentencesDoc.sentences, chunkSize(env), 2, env.CPS_BUDGET !== 'off');
  const chunks = allChunks.slice(batch * CHUNKS_PER_BATCH, (batch + 1) * CHUNKS_PER_BATCH);

  const meter: StepMeter = newMeter();
  const llm = makeStepLlm(env, meter, chunks.length * 9 + 2, llmOverride, modelOf(env, st)); // 含切半分治與禁用詞重打的預算
  let retries = 0;
  let echoOff = 0; // 模型不回 t 的 chunk 數（回聲對位失效 — 可見但不擋，見 assembleStep 的 hints）
  let echoRejects = 0; // 被回聲對位擋下重譯的句次（F1 的成效指標）
  const entries: Array<[number, { zh: string; note?: string }]> = [];
  const problems: string[] = [];
  const protocol: TranslateProtocol = env.TRANSLATE_PROTOCOL === 'array' ? 'array' : 'id';
  const outcomes = await Promise.all(
    chunks.map((c) => translateChunk(llm, src.meta, glossaryDoc.glossary, c, src.track.languageCode, 0, protocol))
  );
  for (let i = 0; i < outcomes.length; i++) {
    const o = outcomes[i];
    retries += o.retries;
    if (o.echoOff) echoOff++;
    echoRejects += o.echoRejects;
    if (o.problems.length > 0) problems.push(`chunk ${batch * CHUNKS_PER_BATCH + i + 1}/${allChunks.length}：${o.problems.join('；')}`);
    for (const [id, v] of o.byId) entries.push([id, v]);
  }
  await jsonPut(env, partKey, { sourceUploaded: st.sourceUploaded, entries, problems, retries, echoOff, echoRejects });

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
  let echoOff = 0;
  let echoRejects = 0;
  for (let b = 0; b < total; b++) {
    const part = await jsonGet<{
      sourceUploaded: string;
      entries: Array<[number, { zh: string; note?: string }]>;
      problems: string[];
      echoOff?: number;
      echoRejects?: number;
    }>(env, `subs/${videoId}/parts/translate_${b}.json`);
    if (!part || part.sourceUploaded !== st.sourceUploaded) throw new Error(`translate part ${b} 缺失，無法組裝`);
    warnings.push(...part.problems);
    echoOff += part.echoOff ?? 0;
    echoRejects += part.echoRejects ?? 0;
    for (const [id, v] of part.entries) byId.set(id, v);
  }

  const sentences = sentencesDoc.sentences;
  const { cues, untranslated, bannedHits, extendedHits, driftCount } = assembleBilingual(sentences, src.cues, byId);
  retimeCues(cues); // B 治標內建：顯示鏈接 + 最短時長（docs/subtitle-timing.md）
  if (untranslated > 0) warnings.push(`${untranslated} 句翻譯失敗，以原文代替（標 untranslated）`);
  if (bannedHits.length > 0) warnings.push(`禁用詞殘留：${bannedHits.join('、')}`);
  const hints = extendedHits.length > 0 ? [`疑似中國用語（OpenCC 參考，僅提示）：${extendedHits.slice(0, 20).join('、')}`] : [];
  // 子句邊界漂移：ASR 碎片翻譯的既有現象，僅提示（新舊版都有，見 cost-optimization.md §8）
  if (driftCount > 0) hints.push(`${driftCount} 句疑似子句邊界漂移（長原文配極短譯文，單句對位可能偏移）`);
  // 回聲對位失效要看得見：模型不回 t 時我們會退回「只靠 id」的舊行為，
  // 這支影片就沒有對位保護 —— 換模型時這行是第一個該看的東西（docs/future-ideas.md F1）
  if (echoOff > 0) hints.push(`${echoOff} 個 chunk 的模型未回 t 欄位，該段回聲對位未生效（退回只靠 id）`);
  // F1 的成效指標：被擋下的都已重譯（不是缺句），這行是「回聲對位有沒有在做事」的唯一硬證據
  if (echoRejects > 0) hints.push(`回聲對位攔下 ${echoRejects} 句次對位不符的譯文（已重譯）`);
  // R1 的成效指標（docs/subtitle-readability.md）：顯示時間讀不完的句數。
  // 在 retime 之後算 —— 顯示時間才是觀眾實際有的時間
  const cpsOver = countCpsOver(cues);
  if (cpsOver > 0) hints.push(`${cpsOver} 句超過 ${CPS_TARGET} 字/秒（顯示時間可能讀不完）`);
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
  st.doneAt = bilingual.generatedAt; // 耗時的分母（之後的補譯不該算進這支片的翻譯時間）
  st.asrRepaired = sentencesDoc.asrRepaired;
  st.untranslated = untranslated;
  st.cpsOver = cpsOver;
  st.warnings = warnings;
  await writeStatus(env, st);

  const stats: PipelineStats = {
    sentences: sentences.length,
    chunks: chunkSentences(sentences, chunkSize(env)).length,
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
  return {
    status: 200,
    body: { ok: true, stats },
    // 有未譯句就自己補（docs/patch-untranslated.md P1）——
    // 使用者不該在看片時才發現，系統翻完當下就知道了
    next: untranslated > 0 && (st.patchRounds ?? 0) < MAX_PATCH_ROUNDS ? { videoId, step: 'patch' } : undefined,
  };
}

// --- 補譯（docs/patch-untranslated.md P1）---
// 翻完自己檢查、自己補：未譯句以「句」計價重譯，不重跑整片。
// 上限 2 輪，走 queue consumer 所以四層保險絲全部適用。
const MAX_PATCH_ROUNDS = 2;

interface BilingualDoc {
  sourceLang: string;
  meta: PromptMeta;
  warnings: string[];
  hints: string[];
  cues: Array<{ start: number; end: number; orig: string; zh: string; untranslated?: boolean; note?: string; [k: string]: unknown }>;
  [k: string]: unknown;
}

// 顯示時間讀不完（R4b 的目標偵測）—— 與 countCpsOver 同一把尺
const exceedsCps = (c: { start: number; end: number; zh: string; untranslated?: boolean }): boolean =>
  !c.untranslated && c.end > c.start && c.zh.length / (c.end - c.start) > CPS_TARGET;

// 用**實際顯示時間**算字數上限（比翻譯當下的預估更準：retime 已經跑過了）
const cueBudget = (c: { start: number; end: number }): number =>
  Math.min(32, Math.max(8, Math.round((c.end - c.start) * CPS_TARGET)));

async function patchStep(env: JobEnv, videoId: string, mode: PatchMode = 'untranslated', llmOverride?: LlmFn): Promise<StepResult> {
  const st = await jsonGet<JobStatus>(env, statusKey(videoId));
  const doc = await jsonGet<BilingualDoc>(env, `subs/${videoId}/bilingual.json`);
  if (!st || !doc) return { status: 404, body: { ok: false, error: 'status 或 bilingual.json 不存在' } };
  if (st.route === 'video') return { status: 422, body: { ok: false, error: '看片路線不支援補譯（重跑整段太貴，請 ?force=1）' } };

  const sentencesDoc = await jsonGet<{ sentences: Sentence[] }>(env, `subs/${videoId}/sentences.json`);
  const glossaryDoc = await jsonGet<{ glossary: GlossaryEntry[] }>(env, `subs/${videoId}/glossary.json`);
  if (!sentencesDoc || sentencesDoc.sentences.length !== doc.cues.length) {
    return { status: 409, body: { ok: false, error: 'sentences.json 與 bilingual 對不起來，請改用 ?force=1 重翻' } };
  }

  // 目標偵測全 deterministic（開發原則 #1）。兩種偵測器共用同一套補譯機制：
  //   untranslated = 未譯旗標／原文照抄　　cps = 顯示時間讀不完（docs/subtitle-readability.md R4b）
  const wantUn = mode !== 'cps';
  const wantCps = mode !== 'untranslated';
  const isTarget = (s: Sentence, c: BilingualDoc['cues'][number]): boolean =>
    (wantUn && needsRetranslate(s.text, c.zh, c.untranslated)) || (wantCps && exceedsCps(c));

  let retries = 0;
  const targets = doc.cues
    .map((c, i) => ({ i, s: sentencesDoc.sentences[i], c }))
    .filter(({ s, c }) => isTarget(s, c));
  if (targets.length === 0) {
    if (wantUn) st.untranslated = 0;
    if (wantCps) st.cpsOver = 0;
    await writeStatus(env, st);
    return { status: 200, body: { ok: true, patched: 0, mode, note: '沒有需要補譯的句子' } };
  }

  // R5：先做零成本的那一半 —— 剝掉超標句的英文夾註再重算一次。
  // 達標的就不必送模型（省錢），而且 deterministic 的修法本來就該排在花錢的修法前面。
  let stripped = 0;
  if (wantCps) {
    for (const t of targets) {
      if (!exceedsCps(t.c)) continue;
      const zh = stripGloss(t.c.zh);
      if (zh === t.c.zh) continue;
      t.c = { ...t.c, zh };
      doc.cues[t.i] = t.c;
      stripped++;
    }
  }
  // 剝完還超標的（以及未譯的）才送模型
  const remaining = targets.filter(({ s, c }) => isTarget(s, c));

  const meter: StepMeter = newMeter();
  const all = sentencesDoc.sentences;
  const ctx = (i: number, d: number): Sentence[] => all.slice(Math.max(0, i - d), i);
  // 一次最多補 40 句（更多代表整片有問題，該重翻而不是補）
  const picked = remaining.slice(0, 40);
  const truncated = remaining.length > picked.length; // 被 40 上限切掉 ≠ 補不動，兩者的續接條件不同
  let patched = 0;
  if (picked.length > 0) {
    const llm = makeStepLlm(env, meter, 6, llmOverride, modelOf(env, st));
    const first = picked[0].i;
    const last = picked[picked.length - 1].i;
    const outcome = await translateChunk(
      llm,
      doc.meta,
      glossaryDoc?.glossary ?? [],
      {
        before: ctx(first, 2),
        // 壓縮模式要把字數上限一起送進 prompt —— 不然模型不知道要壓多短（R1 同一套機制）
        target: picked.map((t) => (wantCps ? { ...t.s, budget: cueBudget(t.c) } : t.s)),
        after: all.slice(last + 1, last + 3),
      },
      doc.sourceLang
    );
    retries = outcome.retries;

    for (const { i, s, c } of picked) {
      const v = outcome.byId.get(s.id);
      if (!v) continue;
      // 模型也常常把夾註加回來 —— 壓縮模式一律再剝一次，標準前後一致
      const zh = wantCps && exceedsCps(c) ? stripGloss(v.zh) : v.zh;
      // 壓縮模式：改出來更長就不換 —— 重譯不該讓情況變糟
      if (wantCps && !c.untranslated && zh.length >= c.zh.length && !needsRetranslate(s.text, c.zh, c.untranslated)) continue;
      doc.cues[i] = { ...doc.cues[i], zh, ...(v.note ? { note: v.note } : {}) };
      delete doc.cues[i].untranslated;
      patched++;
    }
  }

  const leftUn = doc.cues.filter((c, i) => needsRetranslate(sentencesDoc.sentences[i].text, c.zh, c.untranslated)).length;
  const leftCps = doc.cues.filter(exceedsCps).length;
  const left = mode === 'cps' ? leftCps : leftUn;
  // warnings 重寫：舊的「N 句翻譯失敗」已經不準了，留著只會誤導
  doc.warnings = [
    ...doc.warnings.filter((w) => !/句翻譯失敗/.test(w)),
    ...(leftUn > 0 ? [`${leftUn} 句翻譯失敗，以原文代替（標 untranslated，已補譯 ${(st.patchRounds ?? 0) + 1} 輪）`] : []),
  ];
  doc.hints = [
    ...doc.hints.filter((h) => !/補譯|字\/秒|夾註/.test(h)),
    `補譯（${mode}）：${patched} 句已改寫${left > 0 ? `，仍有 ${left} 句沒解決` : ''}`,
    ...(stripped > 0 ? [`剝掉 ${stripped} 句的英文夾註（零 LLM，原文與 note 都還在）`] : []),
    ...(leftCps > 0 ? [`${leftCps} 句超過 ${CPS_TARGET} 字/秒（顯示時間可能讀不完）`] : []),
  ];
  await jsonPut(env, `subs/${videoId}/bilingual.json`, doc);
  await env.SUBS.put(
    `subs/${videoId}/bilingual.srt`,
    toSrt(doc.cues.map((c) => ({ start: Number(c.start), end: Number(c.end), en: c.orig, zh: c.zh }))),
    { httpMetadata: { contentType: 'text/plain; charset=utf-8' } }
  );

  st.patchRounds = (st.patchRounds ?? 0) + 1;
  st.untranslated = leftUn;
  st.cpsOver = leftCps;
  await settle(env, st, meter, retries);
  return {
    status: 200,
    body: { ok: true, mode, patched, stripped, left, leftUntranslated: leftUn, leftCps, truncated, round: st.patchRounds },
    // 續接的兩種理由要分清楚：
    //   未譯 —— 值得再試一次（模型第二次常常就給得出來）
    //   壓縮 —— **壓不動的不重試**（原譯文本來就可用，只是讀起來趕；§3），
    //           但「被 40 句上限切掉」是另一回事：那是還沒輪到，不是失敗，該接著做完
    next:
      st.patchRounds < MAX_PATCH_ROUNDS && ((wantUn && leftUn > 0) || (wantCps && truncated && patched > 0))
        ? { videoId, step: 'patch', mode }
        : undefined,
  };
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
    case 'patch':
      return patchStep(env, msg.videoId, msg.mode ?? 'untranslated', llmOverride);
  }
}

// --- queue consumer（保險絲都在這一層）---

export interface MsgLike {
  body: JobMsg;
  attempts: number;
  ack(): void;
  retry(opts?: { delaySeconds?: number }): void;
}

const LLM_STEPS: ReadonlySet<JobStep> = new Set(['repair', 'glossary', 'translate', 'watch', 'patch']);

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
