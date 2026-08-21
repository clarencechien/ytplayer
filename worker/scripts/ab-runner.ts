// 本機 A/B 實驗 runner：同一支影片、不同模型，各跑一輪完整 text pipeline。
// 不碰 production R2 — source 從公開端點抓、輸出寫本機檔案。
//
// 用法：node ab-runner.bundle.mjs <videoId> <model> <outDir> [--repeat N]
//   --repeat N  同設定重複 N 次，輸出 run-1..N 與 summary.json
//               —— 這是「量自然變異」用的（docs/model-reeval-sop.md 第 2 步）：
//               沒有這把尺，就無法宣稱候選模型／新協定「比較好」
// 變因用環境變數：CHUNK_SIZE、TRANSLATE_PROTOCOL、
//   SEED_GLOSSARY=<dir>（把本機 glossary 檔載進 MemR2，測 channel/genre 疊層用）
// 需求：環境變數 gemini_key、HTTPS_PROXY（node fetch 需手動接 proxy）

import { setGlobalDispatcher, ProxyAgent } from 'undici';
import { writeFileSync, mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { runPipeline, type JobEnv } from '../src/jobs';
import { charBudget } from '../src/pipeline';

const proxy = process.env.HTTPS_PROXY || process.env.https_proxy;
if (proxy) setGlobalDispatcher(new ProxyAgent(proxy));

// 極簡 in-memory R2（介面同 worker 測試的 FakeR2）
class MemR2 {
  store = new Map<string, { value: string; uploaded: Date }>();
  private seq = 0;
  async get(key: string) {
    const e = this.store.get(key);
    return e === undefined ? null : { text: async () => e.value, body: e.value };
  }
  async put(key: string, value: string) {
    this.store.set(key, { value: String(value), uploaded: new Date(Date.now() + this.seq++) });
  }
  async head(key: string) {
    const e = this.store.get(key);
    return e === undefined ? null : { uploaded: e.uploaded };
  }
  async delete(key: string) {
    this.store.delete(key);
  }
  async list({ prefix, delimiter }: { prefix: string; delimiter?: string }) {
    const delimitedPrefixes = new Set<string>();
    const objects: Array<{ key: string }> = [];
    for (const key of this.store.keys()) {
      if (!key.startsWith(prefix)) continue;
      if (delimiter) {
        const rest = key.slice(prefix.length);
        const i = rest.indexOf(delimiter);
        if (i >= 0) delimitedPrefixes.add(prefix + rest.slice(0, i + 1));
        else objects.push({ key });
      } else objects.push({ key });
    }
    return { delimitedPrefixes: [...delimitedPrefixes], objects, truncated: false as const };
  }
}

// 費率表 NT$/M tokens（牌價 ×31，來源見 docs/model-experiment.md「外部資料驗證」）。
// **必須逐模型分開**：拿 flash 的費率去估 lite 會高估 5 倍，直接讓 A/B 的成本結論失真
//（2026-08-16 差點就這樣誤判 F2 的 gate）。thinking 一律計輸出價。
const RATES: Array<[RegExp, { in: number; out: number }]> = [
  [/lite/i, { in: 9.3, out: 77.5 }], // $0.30 / $2.50
  [/3\.6-flash/i, { in: 47, out: 232.5 }], // $1.50 / $7.50
  [/./, { in: 47, out: 280 }], // 3.5-flash 及未知模型：$1.50 / $9.00（保守取高）
];
const estNTD = (total: number, prompt: number, model: string): number => {
  const r = RATES.find(([re]) => re.test(model))![1];
  return Math.round(((prompt / 1e6) * r.in + ((total - prompt) / 1e6) * r.out) * 100) / 100;
};

interface RunMetrics {
  run: number;
  status: number;
  elapsed: number;
  cues: number;
  untranslated: number;
  drift: number; // 子句邊界漂移的 hint 命中數
  cpsOver: number; // 顯示時間讀不完的句數（R1 指標）
  budgeted: number; // 被標字數預算的句數 —— **0 代表功能根本沒啟動**，別再白跑一輪
  zhMedian: number; // 譯文字數中位數 —— 用來確認壓縮沒有變成「全面變短」
  echoOff: number; // 模型不回 t 的 chunk 數（回聲對位失效）
  echoRejects: number; // 回聲對位擋下並重譯的句次（F1 成效）
  warnings: number;
  tokens: number;
  promptTokens: number;
  thoughtTokens: number;
  llmCalls: number;
  retries: number;
  estNTD: number;
}

const countIn = (arr: string[] | undefined, re: RegExp): number => {
  const line = (arr ?? []).find((h) => re.test(h));
  return line ? Number(line.match(/(\d+)/)?.[1] ?? 0) : 0;
};

async function runOnce(videoId: string, model: string, source: string, outDir: string, run: number): Promise<RunMetrics> {
  const SUBS = new MemR2();
  await SUBS.put(`subs/${videoId}/source.json`, source);
  // SEED_GLOSSARY=<dir>：把本機的 glossary 檔載進 MemR2（測疊層用；檔名即 R2 的 glossary/<檔名>）
  if (process.env.SEED_GLOSSARY) {
    for (const f of readdirSync(process.env.SEED_GLOSSARY)) {
      await SUBS.put(`glossary/${f}`, readFileSync(`${process.env.SEED_GLOSSARY}/${f}`, 'utf8'));
    }
  }
  const env = {
    SUBS: SUBS as unknown as R2Bucket,
    GEMINI_API_KEY: process.env.gemini_key || process.env.GEMINI_API_KEY,
    GEMINI_MODEL: model,
    ...(process.env.CHUNK_SIZE ? { CHUNK_SIZE: process.env.CHUNK_SIZE } : {}),
    ...(process.env.TRANSLATE_PROTOCOL ? { TRANSLATE_PROTOCOL: process.env.TRANSLATE_PROTOCOL } : {}),
    ...(process.env.CPS_BUDGET ? { CPS_BUDGET: process.env.CPS_BUDGET } : {}),
  } as JobEnv;

  const t0 = Date.now();
  const r = await runPipeline(env, videoId, true);
  const elapsed = Math.round((Date.now() - t0) / 1000);

  mkdirSync(outDir, { recursive: true });
  for (const name of ['bilingual.json', 'sentences.json', 'glossary.json', 'status.json']) {
    const obj = SUBS.store.get(`subs/${videoId}/${name}`);
    if (obj) writeFileSync(`${outDir}/${name}`, obj.value);
  }
  writeFileSync(`${outDir}/result.json`, JSON.stringify({ model, elapsed, ...r }, null, 2));

  const bil = JSON.parse(SUBS.store.get(`subs/${videoId}/bilingual.json`)?.value ?? '{}');
  const st = JSON.parse(SUBS.store.get(`subs/${videoId}/status.json`)?.value ?? '{}');
  const cues: Array<{ untranslated?: boolean }> = bil.cues ?? [];
  return {
    run,
    status: r.status,
    elapsed,
    cues: cues.length,
    untranslated: cues.filter((c) => c.untranslated).length,
    drift: countIn(bil.hints, /漂移/),
    cpsOver: countIn(bil.hints, /字\/秒/),
    budgeted: (() => {
      const ss = (JSON.parse(SUBS.store.get(`subs/${videoId}/sentences.json`)?.value ?? '{}').sentences ?? []) as Array<
        Parameters<typeof charBudget>[0]
      >;
      return process.env.CPS_BUDGET === 'off' ? 0 : ss.filter((s, i) => charBudget(s, ss[i + 1]) !== undefined).length;
    })(),
    zhMedian: (() => {
      const ls = cues.map((c) => String((c as { zh?: string }).zh ?? '').length).sort((a, b) => a - b);
      return ls.length ? ls[Math.floor(ls.length / 2)] : 0;
    })(),
    echoOff: countIn(bil.hints, /回聲對位未生效/),
    echoRejects: countIn(bil.hints, /回聲對位攔下/),
    warnings: (bil.warnings ?? []).length,
    tokens: st.tokensUsed ?? 0,
    promptTokens: st.promptTokens ?? 0,
    thoughtTokens: st.thoughtTokens ?? 0,
    llmCalls: st.llmCalls ?? 0,
    retries: st.retries ?? 0,
    estNTD: estNTD(st.tokensUsed ?? 0, st.promptTokens ?? 0, model),
  };
}

const stats = (xs: number[]) => ({
  min: Math.min(...xs),
  max: Math.max(...xs),
  mean: Math.round((xs.reduce((a, b) => a + b, 0) / xs.length) * 100) / 100,
});

async function main() {
  const argv = process.argv.slice(2);
  const positional: string[] = [];
  let repeat = 1;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--repeat') {
      repeat = Math.max(1, Number(argv[++i] ?? 1));
      continue;
    }
    positional.push(argv[i]);
  }
  const [videoId, model, outDir] = positional;
  if (!videoId || !model || !outDir) throw new Error('用法：ab-runner <videoId> <model> <outDir> [--repeat N]');
  const apiKey = process.env.gemini_key || process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error('缺 gemini_key 環境變數');

  const srcRes = await fetch(`https://ytplayer.ai-apps.work/subs/${videoId}/source.json`);
  if (!srcRes.ok) throw new Error(`source.json 抓不到（${srcRes.status}）`);
  const source = await srcRes.text();

  const runs: RunMetrics[] = [];
  for (let i = 1; i <= repeat; i++) {
    console.log(`[${model}] 開跑 ${videoId}（${i}/${repeat}）…`);
    const dir = repeat === 1 ? outDir : `${outDir}/run-${i}`;
    const m = await runOnce(videoId, model, source, dir, i);
    runs.push(m);
    console.log(
      `[${model}] #${i} status=${m.status} ${m.elapsed}s cues=${m.cues} 未譯=${m.untranslated} ` +
        `漂移=${m.drift} CPS超標=${m.cpsOver} 標了預算=${m.budgeted} 中位字數=${m.zhMedian} warn=${m.warnings} tokens=${m.tokens}（prompt ${m.promptTokens}／思考 ${m.thoughtTokens}）NT$${m.estNTD}`
    );
  }

  // 同設定跑多次 = 自然變異的尺；只有超出這把尺的差距才值得下結論
  const summary = {
    videoId,
    model,
    repeat,
    chunkSize: process.env.CHUNK_SIZE ?? '(default)',
    protocol: process.env.TRANSLATE_PROTOCOL ?? 'id',
    cpsBudget: process.env.CPS_BUDGET ?? 'on',
    runs,
    variance: Object.fromEntries(
      (['untranslated', 'drift', 'cpsOver', 'budgeted', 'zhMedian', 'echoOff', 'echoRejects', 'warnings', 'tokens', 'estNTD', 'retries'] as const).map((k) => [
        k,
        stats(runs.map((r) => r[k])),
      ])
    ),
  };
  mkdirSync(outDir, { recursive: true });
  writeFileSync(`${outDir}/summary.json`, JSON.stringify(summary, null, 2));
  if (repeat > 1) console.log('變異：', JSON.stringify(summary.variance));
  const bad = runs.find((r) => r.status !== 200);
  if (bad) throw new Error(`第 ${bad.run} 輪 pipeline 未完成（status ${bad.status}）`);
}

main().catch((e) => {
  console.error('FAILED:', e.message);
  process.exit(1);
});
