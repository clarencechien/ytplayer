// Queues 任務系統端到端：fake R2 + fake Queue + fake LLM。
// 涵蓋：in-process 全程（runPipeline）、路由表、queue 步進與冪等、看門狗、四層保險絲的 2–4 層。
import { describe, it, expect } from 'vitest';
import {
  runPipeline,
  runStep,
  handleJob,
  watchdog,
  type JobStatus,
  type MsgLike,
  type JobEnv,
} from '../src/jobs';
import { FakeR2, FakeQueue, drain, envOf, readJson } from './fakes';

const makeSource = () => ({
  videoId: 'ksfm6jeTg3Q',
  tier: 2,
  sourceLang: 'en',
  availableTracks: [],
  meta: { title: 'Agentic infra', channel: 'Claude', description: 'desc', durationSec: 100 },
  track: { languageCode: 'en', kind: null as string | null },
  cues: [
    { start: 0, dur: 2, text: 'Hello everyone.' },
    { start: 2, dur: 2, text: 'Agents are moving to' },
    { start: 4, dur: 2, text: 'production today.' },
    { start: 6, dur: 2, text: 'Thanks for watching.' },
  ],
});

// glossary 呼叫回術語表；修稿呼叫回修正後原文；翻譯呼叫依 prompt 中的「id: 句子」回中文
const fakeLlm = async (prompt: string): Promise<string> => {
  if (prompt.includes('術語編輯')) {
    return '[{"term":"agents","zh":"Agent","note":"能自主完成任務的 AI 程式"}]';
  }
  const ids = [...prompt.matchAll(/^(\d+): /gm)].map((m) => Number(m[1]));
  if (prompt.includes('你是字幕編輯')) {
    return JSON.stringify(ids.map((id) => ({ id, en: `Repaired sentence ${id}.` })));
  }
  return JSON.stringify(ids.map((id) => ({ id, zh: `中文${id}。` })));
};

describe('runPipeline（in-process 整合）', () => {
  it('Tier 2 全流程：sentences/glossary/bilingual(v2)/srt/status 都寫入，第二次命中 cache', async () => {
    const SUBS = new FakeR2();
    await SUBS.put('subs/ksfm6jeTg3Q/source.json', JSON.stringify(makeSource()));
    const env = envOf(SUBS);

    const r1 = await runPipeline(env, 'ksfm6jeTg3Q', false, fakeLlm);
    expect(r1.status).toBe(200);
    const stats = (r1.body as { stats: Record<string, unknown> }).stats;
    expect(stats.sentences).toBe(3); // 兩個 cue 併成一句 + 另兩句
    expect(stats.glossaryTerms).toBe(1);
    expect(stats.untranslated).toBe(0);
    expect(stats.asrRepaired).toBe(0); // 人工軌不修稿
    expect(stats.autoNotes).toBe(1);
    expect(stats.warnings).toEqual([]);

    const bilingual = readJson(SUBS, 'subs/ksfm6jeTg3Q/bilingual.json');
    expect(bilingual.schema).toBe(2);
    expect(bilingual.trust).toBe('cc');
    expect(bilingual.route).toBe('text');
    expect(bilingual.promptVersion).toBeTruthy();
    expect(bilingual.model).toBe('fake-model');
    expect(bilingual.cues.length).toBe(3);
    expect(bilingual.cues[1]).toMatchObject({
      start: 2,
      end: 5.95, // retime 內建：與下一句保留 0.05s 縫（docs/subtitle-timing.md B）
      kind: 'speech',
      orig: 'Agents are moving to production today.',
      zh: '中文1。',
      note: 'Agent：能自主完成任務的 AI 程式',
    });
    expect(SUBS.store.get('subs/ksfm6jeTg3Q/bilingual.srt')!.value).toContain('中文0。\nHello everyone.');
    expect(SUBS.store.has('subs/ksfm6jeTg3Q/sentences.json')).toBe(true);
    expect(SUBS.store.has('subs/ksfm6jeTg3Q/glossary.json')).toBe(true);
    const status = readJson(SUBS, 'subs/ksfm6jeTg3Q/status.json') as JobStatus;
    expect(status.stage).toBe('done');
    // checkpoint 清掃
    expect([...SUBS.store.keys()].filter((k) => k.includes('/parts/'))).toEqual([]);

    const r2 = await runPipeline(env, 'ksfm6jeTg3Q', false, fakeLlm);
    expect(r2.body).toMatchObject({ ok: true, cached: true });
  });

  it('翻譯持續缺句 → fallback 原文 + warnings 非空（驗收會擋）', async () => {
    const SUBS = new FakeR2();
    await SUBS.put('subs/ksfm6jeTg3Q/source.json', JSON.stringify(makeSource()));
    const partialLlm = async (prompt: string): Promise<string> => {
      if (prompt.includes('術語編輯')) return '[]';
      return '[{"id":0,"zh":"只有第一句。"}]';
    };
    const r = await runPipeline(envOf(SUBS), 'ksfm6jeTg3Q', false, partialLlm);
    expect(r.status).toBe(200);
    const stats = (r.body as { stats: { untranslated: number; warnings: string[] } }).stats;
    expect(stats.untranslated).toBe(2);
    expect(stats.warnings.some((w) => w.includes('翻譯失敗'))).toBe(true);
  });

  it('英文 ASR：先修稿再翻，orig 是修好的版本、trust 是 asr-repaired', async () => {
    const SUBS = new FakeR2();
    const src = makeSource();
    src.tier = 3;
    src.track = { languageCode: 'en', kind: 'asr' };
    await SUBS.put('subs/ksfm6jeTg3Q/source.json', JSON.stringify(src));
    const r = await runPipeline(envOf(SUBS), 'ksfm6jeTg3Q', false, fakeLlm);
    expect(r.status).toBe(200);
    expect((r.body as { stats: { asrRepaired: number } }).stats.asrRepaired).toBe(3);
    const bilingual = readJson(SUBS, 'subs/ksfm6jeTg3Q/bilingual.json');
    expect(bilingual.tier).toBe(3);
    expect(bilingual.trust).toBe('asr-repaired');
    expect(bilingual.cues[0].orig).toBe('Repaired sentence 0.');
    expect(bilingual.cues[0].zh).toBe('中文0。');
  });

  it('路由表：日文 ASR 開放（走修稿）；韓文 ASR 拒；中文軌拒；日文人工軌可翻', async () => {
    const SUBS = new FakeR2();
    const env = envOf(SUBS);

    const jaAsr = makeSource();
    jaAsr.tier = 3;
    jaAsr.track = { languageCode: 'ja', kind: 'asr' };
    await SUBS.put('subs/ksfm6jeTg3Q/source.json', JSON.stringify(jaAsr));
    const rJa = await runPipeline(env, 'ksfm6jeTg3Q', false, fakeLlm);
    expect(rJa.status).toBe(200); // asr-language-experiment 決策：非英文 ASR 閘門開放
    expect(readJson(SUBS, 'subs/ksfm6jeTg3Q/bilingual.json').trust).toBe('asr-repaired');

    const koAsr = makeSource();
    koAsr.track = { languageCode: 'ko', kind: 'asr' };
    await SUBS.put('subs/ksfm6jeTg3Q/source.json', JSON.stringify(koAsr));
    expect((await runPipeline(env, 'ksfm6jeTg3Q', false, fakeLlm)).status).toBe(422); // 韓文未量測，走 video 路線

    const zhManual = makeSource();
    zhManual.track = { languageCode: 'zh-Hant', kind: null };
    await SUBS.put('subs/ksfm6jeTg3Q/source.json', JSON.stringify(zhManual));
    expect((await runPipeline(env, 'ksfm6jeTg3Q', false, fakeLlm)).status).toBe(422); // 紅線

    const jaManual = makeSource();
    jaManual.tier = 1; // 影片有繁中軌，但使用者主動選了日文原文軌重做
    jaManual.track = { languageCode: 'ja', kind: null };
    await SUBS.put('subs/ksfm6jeTg3Q/source.json', JSON.stringify(jaManual));
    const r = await runPipeline(env, 'ksfm6jeTg3Q', false, fakeLlm);
    expect(r.status).toBe(200);
    expect((r.body as { stats: { asrRepaired: number } }).stats.asrRepaired).toBe(0); // 人工軌不修稿
  });
});

describe('queue 步進（handleJob + FakeQueue）', () => {
  it('plan 入列後自我續鏈到完成；status 每步更新、日預算有記帳', async () => {
    const SUBS = new FakeR2();
    const q = new FakeQueue();
    const env = envOf(SUBS, q);
    const src = makeSource();
    src.track = { languageCode: 'en', kind: 'asr' }; // 走最長鏈：repair → glossary → translate → assemble
    await SUBS.put('subs/ksfm6jeTg3Q/source.json', JSON.stringify(src));

    await q.send({ videoId: 'ksfm6jeTg3Q', step: 'plan' });
    const steps = await drain(q, env, fakeLlm);
    expect(steps).toBe(5); // plan + repair + glossary + translate + assemble

    expect(readJson(SUBS, 'subs/ksfm6jeTg3Q/bilingual.json').schema).toBe(2);
    const st = readJson(SUBS, 'subs/ksfm6jeTg3Q/status.json') as JobStatus;
    expect(st.stage).toBe('done');
    expect(st.llmCalls).toBeGreaterThan(0);
    const today = new Date().toISOString().slice(0, 10);
    expect(readJson(SUBS, `budget/${today}.json`).calls).toBe(st.llmCalls);
  });

  it('步驟冪等：repair part 已存在（同版 source）→ 跳過工作直接接鏈', async () => {
    const SUBS = new FakeR2();
    const env = envOf(SUBS);
    const src = makeSource();
    src.track = { languageCode: 'en', kind: 'asr' };
    await SUBS.put('subs/ksfm6jeTg3Q/source.json', JSON.stringify(src));

    let calls = 0;
    const countingLlm = async (p: string) => {
      calls++;
      return fakeLlm(p);
    };
    const plan = await runStep(env, { videoId: 'ksfm6jeTg3Q', step: 'plan' });
    expect(plan.next).toEqual({ videoId: 'ksfm6jeTg3Q', step: 'repair', batch: 0 });

    const r1 = await runStep(env, plan.next!, countingLlm);
    const afterFirst = calls;
    expect(afterFirst).toBeGreaterThan(0);
    expect(r1.next).toEqual({ videoId: 'ksfm6jeTg3Q', step: 'glossary' });

    const r2 = await runStep(env, plan.next!, countingLlm); // 同一步再投遞一次（at-least-once）
    expect(calls).toBe(afterFirst); // 零 LLM 花費
    expect(r2.body.skipped).toBeTruthy();
    expect(r2.next).toEqual({ videoId: 'ksfm6jeTg3Q', step: 'glossary' });
  });

  it('看門狗重排（非 force）＝真 resume：token 計數累計、checkpoint 保留不重付', async () => {
    const SUBS = new FakeR2();
    const env = envOf(SUBS);
    const src = makeSource();
    src.track = { languageCode: 'en', kind: 'asr' };
    await SUBS.put('subs/ksfm6jeTg3Q/source.json', JSON.stringify(src));

    let calls = 0;
    const countingLlm = async (p: string) => (calls++, fakeLlm(p));
    const plan = await runStep(env, { videoId: 'ksfm6jeTg3Q', step: 'plan' });
    await runStep(env, plan.next!, countingLlm); // repair 0 完成（有 token 計數與 part 落地）
    const afterRepair = calls;

    // 模擬斷鏈：status 停更超過 STALE_MS（改舊 updatedAt），看門狗會重排 plan（非 force）
    const st = readJson(SUBS, 'subs/ksfm6jeTg3Q/status.json') as JobStatus;
    st.updatedAt = new Date(Date.now() - 11 * 60 * 1000).toISOString();
    st.llmCalls = 7;
    st.tokensUsed = 1234;
    await SUBS.put('subs/ksfm6jeTg3Q/status.json', JSON.stringify(st));

    const replan = await runStep(env, { videoId: 'ksfm6jeTg3Q', step: 'plan' });
    const st2 = readJson(SUBS, 'subs/ksfm6jeTg3Q/status.json') as JobStatus;
    expect(st2.tokensUsed).toBe(1234); // 計數器沒有被歸零（每片上限保險絲跨輪有效）
    expect(st2.llmCalls).toBe(7);
    const r = await runStep(env, replan.next!, countingLlm); // 重排後的 repair 0
    expect(calls).toBe(afterRepair); // checkpoint 保留 → 冪等跳過，零 LLM 花費
    expect(r.body.skipped).toBeTruthy();

    // 對照組：force 重跑 = 人為動作，計數歸零、checkpoint 清掉
    const forced = await runStep(env, { videoId: 'ksfm6jeTg3Q', step: 'plan', force: true });
    const st3 = readJson(SUBS, 'subs/ksfm6jeTg3Q/status.json') as JobStatus;
    expect(st3.tokensUsed).toBe(0);
    expect(forced.next).toEqual({ videoId: 'ksfm6jeTg3Q', step: 'repair', batch: 0 });
    await runStep(env, forced.next!, countingLlm);
    expect(calls).toBeGreaterThan(afterRepair); // 真的重打了
  });

  it('?model= 本輪覆寫：整鏈用指定模型、bilingual.model 記錄之；預設輪不受影響', async () => {
    const SUBS = new FakeR2();
    const q = new FakeQueue();
    const env = envOf(SUBS, q);
    await SUBS.put('subs/ksfm6jeTg3Q/source.json', JSON.stringify(makeSource()));
    await q.send({ videoId: 'ksfm6jeTg3Q', step: 'plan', model: 'fake-lite' });
    await drain(q, env, fakeLlm);
    expect(readJson(SUBS, 'subs/ksfm6jeTg3Q/bilingual.json').model).toBe('fake-lite');
    expect((readJson(SUBS, 'subs/ksfm6jeTg3Q/status.json') as JobStatus).modelOverride).toBe('fake-lite');
    // 之後不帶 model 的 force 重跑回到 env 預設
    await q.send({ videoId: 'ksfm6jeTg3Q', step: 'plan', force: true });
    await drain(q, env, fakeLlm);
    expect(readJson(SUBS, 'subs/ksfm6jeTg3Q/bilingual.json').model).toBe('fake-model');
  });

  it('source 跑到一半被重新 ingest → 步驟偵測版本不符，改排 plan 重來', async () => {
    const SUBS = new FakeR2();
    const env = envOf(SUBS);
    await SUBS.put('subs/ksfm6jeTg3Q/source.json', JSON.stringify(makeSource()));
    const plan = await runStep(env, { videoId: 'ksfm6jeTg3Q', step: 'plan' });
    await SUBS.put('subs/ksfm6jeTg3Q/source.json', JSON.stringify(makeSource())); // re-ingest
    const r = await runStep(env, plan.next!, fakeLlm);
    expect(r.next).toEqual({ videoId: 'ksfm6jeTg3Q', step: 'plan' });
  });
});

describe('保險絲', () => {
  const statusOf = (over: Partial<JobStatus>): JobStatus => ({
    videoId: 'ksfm6jeTg3Q',
    stage: 'translate',
    startedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    sourceUploaded: '',
    route: 'text',
    repairBatches: 0,
    translateBatches: 1,
    tokensUsed: 0,
    llmCalls: 0,
    retries: 0,
    asrRepaired: 0,
    warnings: [],
    ...over,
  });

  it('第 2 層：步驟連續失敗 3 次 → 永久標記 failed，不再重試', async () => {
    const SUBS = new FakeR2();
    const q = new FakeQueue();
    const env = envOf(SUBS, q);
    await SUBS.put('subs/ksfm6jeTg3Q/source.json', JSON.stringify(makeSource()));
    const head = await SUBS.head('subs/ksfm6jeTg3Q/source.json');
    const su = head!.uploaded.toISOString();
    // 假造斷鏈現場：sentences/glossary 都在，status 說 translate 已完成 1 批，但 part 遺失 → assemble 必炸
    await SUBS.put('subs/ksfm6jeTg3Q/sentences.json', JSON.stringify({ sentences: [], asrRepaired: 0, sourceUploaded: su }));
    await SUBS.put('subs/ksfm6jeTg3Q/glossary.json', JSON.stringify({ glossary: [], sourceUploaded: su }));
    await SUBS.put('subs/ksfm6jeTg3Q/status.json', JSON.stringify(statusOf({ sourceUploaded: su, stage: 'assemble' })));
    await q.send({ videoId: 'ksfm6jeTg3Q', step: 'assemble' });
    const steps = await drain(q, env, fakeLlm);
    expect(steps).toBe(3); // 首投 + 2 次 retry，第 3 次標記失敗
    const st = readJson(SUBS, 'subs/ksfm6jeTg3Q/status.json') as JobStatus;
    expect(st.failed).toBe(true);
    expect(st.failReason).toContain('assemble');
    expect(q.pending.length).toBe(0);
  });

  it('第 3 層：每片 token 超上限 → 永久 failed、不打 LLM', async () => {
    const SUBS = new FakeR2();
    const env = { ...envOf(SUBS, new FakeQueue()), VIDEO_TOKEN_CAP: '1000' } as JobEnv;
    await SUBS.put('subs/ksfm6jeTg3Q/source.json', JSON.stringify(makeSource()));
    const head = await SUBS.head('subs/ksfm6jeTg3Q/source.json');
    await SUBS.put(
      'subs/ksfm6jeTg3Q/status.json',
      JSON.stringify(statusOf({ sourceUploaded: head!.uploaded.toISOString(), tokensUsed: 5000 }))
    );
    let calls = 0;
    const msg: MsgLike = { body: { videoId: 'ksfm6jeTg3Q', step: 'translate', batch: 0 }, attempts: 1, ack() {}, retry() {} };
    await handleJob(msg, env, async () => (calls++, '[]'));
    expect(calls).toBe(0);
    const st = readJson(SUBS, 'subs/ksfm6jeTg3Q/status.json') as JobStatus;
    expect(st.failed).toBe(true);
    expect(st.failReason).toContain('上限');
  });

  it('第 4 層：日預算用完 → paused（非 failed）、不打 LLM；看門狗當日不重排', async () => {
    const SUBS = new FakeR2();
    const q = new FakeQueue();
    const env = { ...envOf(SUBS, q), DAILY_TOKEN_CAP: '100' } as JobEnv;
    await SUBS.put('subs/ksfm6jeTg3Q/source.json', JSON.stringify(makeSource()));
    const head = await SUBS.head('subs/ksfm6jeTg3Q/source.json');
    await SUBS.put(
      'subs/ksfm6jeTg3Q/status.json',
      JSON.stringify(statusOf({ sourceUploaded: head!.uploaded.toISOString() }))
    );
    const today = new Date().toISOString().slice(0, 10);
    await SUBS.put(`budget/${today}.json`, JSON.stringify({ tokens: 500, calls: 3 }));

    let calls = 0;
    const msg: MsgLike = { body: { videoId: 'ksfm6jeTg3Q', step: 'translate', batch: 0 }, attempts: 1, ack() {}, retry() {} };
    await handleJob(msg, env, async () => (calls++, '[]'));
    expect(calls).toBe(0);
    const st = readJson(SUBS, 'subs/ksfm6jeTg3Q/status.json') as JobStatus;
    expect(st.stage).toBe('paused');
    expect(st.failed).toBeUndefined();

    const r = await watchdog(env);
    expect(r.enqueued).toEqual([]); // 今天不用再試（明天日期變了自然放行）
  });
});

describe('watchdog（cron 看門狗 — 零成本補漏）', () => {
  it('pending 影片重排 plan；translated 且最新的跳過', async () => {
    const SUBS = new FakeR2();
    const q = new FakeQueue();
    const env = envOf(SUBS, q);
    await SUBS.put('subs/ksfm6jeTg3Q/source.json', JSON.stringify(makeSource()));
    const r = await watchdog(env);
    expect(r.enqueued).toEqual(['ksfm6jeTg3Q']);
    expect(q.pending[0].body).toEqual({ videoId: 'ksfm6jeTg3Q', step: 'plan' });

    // 翻完之後（bilingual 比 source 新）→ 無事可做
    q.pending.length = 0;
    await drain(q, env, fakeLlm); // 空佇列 no-op
    await runPipeline(env, 'ksfm6jeTg3Q', false, fakeLlm);
    expect((await watchdog(env)).enqueued).toEqual([]);

    // 重新 ingest（source 較新）→ 重排。但 10 分鐘內 status 仍新鮮（上一輪 done）不擋 pending 判斷
    await SUBS.put('subs/ksfm6jeTg3Q/source.json', JSON.stringify(makeSource()));
    expect((await watchdog(env)).enqueued).toEqual(['ksfm6jeTg3Q']);
  });

  it('拒收路由（zh / ko ASR）與 failed 的不重排；活著的 run 不重複排', async () => {
    const SUBS = new FakeR2();
    const q = new FakeQueue();
    const env = envOf(SUBS, q);

    const zh = makeSource();
    zh.videoId = 'AAAAAAAAAAA';
    zh.track = { languageCode: 'zh-TW', kind: null };
    await SUBS.put('subs/AAAAAAAAAAA/source.json', JSON.stringify(zh));

    const ko = makeSource();
    ko.videoId = 'BBBBBBBBBBB';
    ko.track = { languageCode: 'ko', kind: 'asr' };
    await SUBS.put('subs/BBBBBBBBBBB/source.json', JSON.stringify(ko));

    // 活著的 run：status 剛更新
    const live = makeSource();
    live.videoId = 'CCCCCCCCCCC';
    await SUBS.put('subs/CCCCCCCCCCC/source.json', JSON.stringify(live));
    const liveHead = await SUBS.head('subs/CCCCCCCCCCC/source.json');
    await SUBS.put(
      'subs/CCCCCCCCCCC/status.json',
      JSON.stringify({
        videoId: 'CCCCCCCCCCC',
        stage: 'translate',
        startedAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        sourceUploaded: liveHead!.uploaded.toISOString(),
        route: 'text',
        repairBatches: 0,
        translateBatches: 2,
        tokensUsed: 0,
        llmCalls: 1,
        retries: 0,
        asrRepaired: 0,
        warnings: [],
      })
    );

    // failed 的 run
    const failed = makeSource();
    failed.videoId = 'DDDDDDDDDDD';
    await SUBS.put('subs/DDDDDDDDDDD/source.json', JSON.stringify(failed));
    const failedHead = await SUBS.head('subs/DDDDDDDDDDD/source.json');
    await SUBS.put(
      'subs/DDDDDDDDDDD/status.json',
      JSON.stringify({
        videoId: 'DDDDDDDDDDD',
        stage: 'failed',
        failed: true,
        failReason: 'x',
        startedAt: new Date().toISOString(),
        updatedAt: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
        sourceUploaded: failedHead!.uploaded.toISOString(),
        route: 'text',
        repairBatches: 0,
        translateBatches: 1,
        tokensUsed: 0,
        llmCalls: 0,
        retries: 0,
        asrRepaired: 0,
        warnings: [],
      })
    );

    const r = await watchdog(env);
    expect(r.enqueued).toEqual([]);
    expect(r.scanned).toBe(4);
  });
});
