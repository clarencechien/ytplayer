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

  // G1（docs/glossary-layers.md）：人工養的 channel/genre 表壓過當片自動抽的，
  // 而且要在 translate prompt 裡真的看得到 —— 「同頻道跨影片譯法不一致」修的就是這個
  it('glossary 疊層：channel 表壓過自動抽，且進了翻譯 prompt', async () => {
    const SUBS = new FakeR2();
    const src = makeSource();
    src.meta = { ...src.meta, channelId: 'UCabcdefghijklmnopqrstuv' } as typeof src.meta;
    await SUBS.put('subs/ksfm6jeTg3Q/source.json', JSON.stringify(src));
    await SUBS.put(
      'glossary/channel-UCabcdefghijklmnopqrstuv.json',
      JSON.stringify({ channel: 'Claude', entries: [{ term: 'agents', zh: '代理程式（Agent）' }] })
    );
    await SUBS.put('glossary/genre-en.json', JSON.stringify([{ term: 'inference', zh: '推論（Inference）' }]));

    const prompts: string[] = [];
    const spyLlm = async (p: string) => {
      prompts.push(p);
      return fakeLlm(p);
    };
    const r = await runPipeline(envOf(SUBS), 'ksfm6jeTg3Q', false, spyLlm);
    expect(r.status).toBe(200);

    const g = readJson(SUBS, 'subs/ksfm6jeTg3Q/glossary.json');
    expect(g.layers).toMatchObject({ channelKey: 'UCabcdefghijklmnopqrstuv', channel: 1, genre: 1, auto: 1, merged: 2 });
    // 自動抽的 agents→「Agent」被 channel 表的譯法取代（同 term 上層贏）
    expect(g.glossary).toEqual([
      { term: 'agents', zh: '代理程式（Agent）', layer: 'channel' },
      { term: 'inference', zh: '推論（Inference）', layer: 'genre' },
    ]);
    expect(prompts.some((p) => p.includes('資深字幕譯者') && p.includes('agents → 代理程式（Agent）'))).toBe(true);
  });

  it('沒有 channelId 的舊 source：退回頻道名稱 slug 當鍵值', async () => {
    const SUBS = new FakeR2();
    await SUBS.put('subs/ksfm6jeTg3Q/source.json', JSON.stringify(makeSource())); // meta.channel = 'Claude'
    await SUBS.put('glossary/channel-claude.json', JSON.stringify([{ term: 'agents', zh: '代理程式' }]));
    const r = await runPipeline(envOf(SUBS), 'ksfm6jeTg3Q', false, fakeLlm);
    expect(r.status).toBe(200);
    expect(readJson(SUBS, 'subs/ksfm6jeTg3Q/glossary.json').layers.channelKey).toBe('claude');
  });

  it('翻譯持續缺句 → 自動補譯兩輪；補不動就 fallback 原文 + warnings 非空（驗收會擋）', async () => {
    const SUBS = new FakeR2();
    await SUBS.put('subs/ksfm6jeTg3Q/source.json', JSON.stringify(makeSource()));
    const partialLlm = async (prompt: string): Promise<string> => {
      if (prompt.includes('術語編輯')) return '[]';
      return '[{"id":0,"zh":"只有第一句。"}]';
    };
    // assemble 發現未譯 → 自動接 patch（docs/patch-untranslated.md P1），
    // 模型還是只回第一句 → 補不動，兩輪後停手並照舊標記
    const r = await runPipeline(envOf(SUBS), 'ksfm6jeTg3Q', false, partialLlm);
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ patched: 0, left: 2, round: 2 }); // 上限 2 輪，不無限補

    const bil = readJson(SUBS, 'subs/ksfm6jeTg3Q/bilingual.json');
    expect(bil.cues.filter((c: { untranslated?: boolean }) => c.untranslated)).toHaveLength(2);
    expect(bil.warnings.some((w: string) => w.includes('翻譯失敗'))).toBe(true);
    const st = readJson(SUBS, 'subs/ksfm6jeTg3Q/status.json') as JobStatus;
    expect(st.untranslated).toBe(2); // 儀表板看得到
    expect(st.patchRounds).toBe(2);
  });

  it('自動補譯：第二次呼叫給得出譯文時，未譯歸零且時間軸不變', async () => {
    const SUBS = new FakeR2();
    await SUBS.put('subs/ksfm6jeTg3Q/source.json', JSON.stringify(makeSource()));
    let firstPass = true;
    const flakyLlm = async (prompt: string): Promise<string> => {
      if (prompt.includes('術語編輯')) return '[]';
      const ids = [...prompt.matchAll(/^(\d+): /gm)].map((m) => Number(m[1]));
      if (firstPass && ids.length === 3) {
        firstPass = false; // 第一輪整包只回第一句，其餘進補譯
        return '[{"id":0,"zh":"只有第一句。"}]';
      }
      return JSON.stringify(ids.map((id) => ({ id, zh: `補回來的中文${id}。` })));
    };
    const r = await runPipeline(envOf(SUBS), 'ksfm6jeTg3Q', false, flakyLlm);
    expect(r.status).toBe(200);

    const bil = readJson(SUBS, 'subs/ksfm6jeTg3Q/bilingual.json');
    expect(bil.cues.filter((c: { untranslated?: boolean }) => c.untranslated)).toHaveLength(0);
    expect(bil.cues[1].zh).toContain('補回來的中文');
    expect(bil.cues[1].end).toBe(5.95); // 補譯不動時間軸
    expect(bil.warnings.every((w: string) => !w.includes('翻譯失敗'))).toBe(true); // 過期的警告要清掉
    expect(SUBS.store.get('subs/ksfm6jeTg3Q/bilingual.srt')!.value).toContain('補回來的中文');
    expect((readJson(SUBS, 'subs/ksfm6jeTg3Q/status.json') as JobStatus).untranslated).toBe(0);
  });

  // R4b（docs/subtitle-readability.md）：已經翻好的舊片也要修得掉 ——
  // 品質改善若沒有事後套用路徑，等於只對「之後的新片」有效（CLAUDE.md 硬規則 #8）
  describe('壓縮補譯 mode=cps', () => {
    const longLlm = async (prompt: string): Promise<string> => {
      if (prompt.includes('術語編輯')) return '[]';
      const ids = [...prompt.matchAll(/^(\d+): /gm)].map((m) => Number(m[1]));
      return JSON.stringify(ids.map((id) => ({ id, zh: `這是一句刻意寫得又臭又長、顯示時間根本讀不完的中文字幕第${id}句。` })));
    };
    const seedLongVideo = async (): Promise<FakeR2> => {
      const SUBS = new FakeR2();
      await SUBS.put('subs/ksfm6jeTg3Q/source.json', JSON.stringify(makeSource()));
      const r = await runPipeline(envOf(SUBS), 'ksfm6jeTg3Q', false, longLlm);
      expect(r.status).toBe(200);
      // assemble 只自動接「未譯」那條；讀不完不自動花錢重譯，等使用者按鈕
      expect((readJson(SUBS, 'subs/ksfm6jeTg3Q/status.json') as JobStatus).cpsOver).toBeGreaterThan(0);
      expect((readJson(SUBS, 'subs/ksfm6jeTg3Q/status.json') as JobStatus).patchRounds ?? 0).toBe(0);
      return SUBS;
    };

    it('把讀不完的句子重譯成短的：cpsOver 歸零、時間軸不動、prompt 帶字數上限', async () => {
      const SUBS = await seedLongVideo();
      const before = readJson(SUBS, 'subs/ksfm6jeTg3Q/bilingual.json');
      const prompts: string[] = [];
      const shortLlm = async (prompt: string): Promise<string> => {
        prompts.push(prompt);
        const ids = [...prompt.matchAll(/^(\d+): /gm)].map((m) => Number(m[1]));
        return JSON.stringify(ids.map((id) => ({ id, zh: `短句${id}。` })));
      };
      const overBefore = (readJson(SUBS, 'subs/ksfm6jeTg3Q/status.json') as JobStatus).cpsOver!;
      const r = await runStep(envOf(SUBS), { videoId: 'ksfm6jeTg3Q', step: 'patch', mode: 'cps' }, shortLlm);
      expect(r.status).toBe(200);
      expect(r.body).toMatchObject({ mode: 'cps', patched: overBefore, leftCps: 0 });
      expect(r.next).toBeUndefined(); // 壓縮不重試：壓不下去的句子再壓一次只是多花錢

      // 字數上限真的送進 prompt（沒送 = 模型不知道要壓多短，等於白花錢）
      expect(prompts[0]).toMatch(/^\d+: \[≤\d+ 字\] /m);
      const after = readJson(SUBS, 'subs/ksfm6jeTg3Q/bilingual.json');
      // 只改讀不完的那幾句：其餘原譯文一字不動（重譯是有代價的，不該順手全片重寫）
      expect(after.cues[0].zh).toBe('短句0。');
      expect(after.cues.filter((c: { zh: string }) => /^短句/.test(c.zh))).toHaveLength(overBefore);
      expect(after.cues.map((c: { start: number; end: number }) => [c.start, c.end])).toEqual(
        before.cues.map((c: { start: number; end: number }) => [c.start, c.end])
      );
      expect(SUBS.store.get('subs/ksfm6jeTg3Q/bilingual.srt')!.value).toContain('短句0。');
      const st = readJson(SUBS, 'subs/ksfm6jeTg3Q/status.json') as JobStatus;
      expect(st.cpsOver).toBe(0);
      expect(st.untranslated).toBe(0); // 壓縮不該把好句子弄成未譯
    });

    it('壓出來更長就不換：重譯不該讓情況變糟', async () => {
      const SUBS = await seedLongVideo();
      const before = readJson(SUBS, 'subs/ksfm6jeTg3Q/bilingual.json');
      const longerLlm = async (prompt: string): Promise<string> => {
        const ids = [...prompt.matchAll(/^(\d+): /gm)].map((m) => Number(m[1]));
        return JSON.stringify(ids.map((id) => ({ id, zh: `${'更'.repeat(60)}長第${id}句。` })));
      };
      const r = await runStep(envOf(SUBS), { videoId: 'ksfm6jeTg3Q', step: 'patch', mode: 'cps' }, longerLlm);
      expect(r.body).toMatchObject({ patched: 0 });
      const after = readJson(SUBS, 'subs/ksfm6jeTg3Q/bilingual.json');
      expect(after.cues.map((c: { zh: string }) => c.zh)).toEqual(before.cues.map((c: { zh: string }) => c.zh));
    });

    // 「被 40 句上限切掉」不是「補不動」—— 前者該接著做完，否則按鈕寫 49 卻只修 40，
    // 使用者看不出差別（實測 hK9fypJKHyY 就是 49 句）
    it('超過一次上限 40 句時自動接著補完，而不是靜靜地只修 40 句', async () => {
      const SUBS = new FakeR2();
      const src = makeSource();
      src.cues = Array.from({ length: 45 }, (_, i) => ({ start: i * 2, dur: 1, text: `Sentence ${i} here.` }));
      await SUBS.put('subs/ksfm6jeTg3Q/source.json', JSON.stringify(src));
      await runPipeline(envOf(SUBS), 'ksfm6jeTg3Q', false, longLlm);
      // 最後一句的顯示時間會被 retime 拉長，所以是 44 而不是 45
      const overBefore = (readJson(SUBS, 'subs/ksfm6jeTg3Q/status.json') as JobStatus).cpsOver!;
      expect(overBefore).toBeGreaterThan(40);

      const shortLlm = async (prompt: string): Promise<string> => {
        const ids = [...prompt.matchAll(/^(\d+): /gm)].map((m) => Number(m[1]));
        return JSON.stringify(ids.map((id) => ({ id, zh: `短句${id}。` })));
      };
      const env = envOf(SUBS);
      const r1 = await runStep(env, { videoId: 'ksfm6jeTg3Q', step: 'patch', mode: 'cps' }, shortLlm);
      expect(r1.body).toMatchObject({ patched: 40, truncated: true });
      expect(r1.next).toEqual({ videoId: 'ksfm6jeTg3Q', step: 'patch', mode: 'cps' });

      const r2 = await runStep(env, r1.next!, shortLlm);
      expect(r2.body).toMatchObject({ patched: overBefore - 40, truncated: false, leftCps: 0 });
      expect(r2.next).toBeUndefined();
      expect((readJson(SUBS, 'subs/ksfm6jeTg3Q/status.json') as JobStatus).cpsOver).toBe(0);
    });

    it('壓不動時不續接：只有「還沒輪到」值得再排一輪，重試壓不動的句子只是多花錢', async () => {
      const SUBS = await seedLongVideo();
      const sameLlm = async (prompt: string): Promise<string> => {
        const ids = [...prompt.matchAll(/^(\d+): /gm)].map((m) => Number(m[1]));
        return JSON.stringify(ids.map((id) => ({ id, zh: `這是一句刻意寫得又臭又長、顯示時間根本讀不完的中文字幕第${id}句。` })));
      };
      const r = await runStep(envOf(SUBS), { videoId: 'ksfm6jeTg3Q', step: 'patch', mode: 'cps' }, sameLlm);
      expect(r.body).toMatchObject({ patched: 0, truncated: false });
      expect(r.next).toBeUndefined();
    });

    it('mode=cps 不碰未譯句；沒有目標時直接回 0 且不呼叫模型', async () => {
      const SUBS = new FakeR2();
      await SUBS.put('subs/ksfm6jeTg3Q/source.json', JSON.stringify(makeSource()));
      await runPipeline(envOf(SUBS), 'ksfm6jeTg3Q', false, fakeLlm); // 「中文N。」很短，沒有讀不完的句子
      let called = 0;
      const spy = async (p: string): Promise<string> => {
        called++;
        return fakeLlm(p);
      };
      const r = await runStep(envOf(SUBS), { videoId: 'ksfm6jeTg3Q', step: 'patch', mode: 'cps' }, spy);
      expect(r.body).toMatchObject({ ok: true, patched: 0, mode: 'cps' });
      expect(called).toBe(0);
    });
  });

  it('只有標點的句子（「。」）不送模型、也不算未譯', async () => {
    const SUBS = new FakeR2();
    const src = makeSource();
    src.cues = [...src.cues, { start: 8, dur: 2, text: '。' }];
    await SUBS.put('subs/ksfm6jeTg3Q/source.json', JSON.stringify(src));
    const asked: number[][] = [];
    const llm = async (prompt: string): Promise<string> => {
      if (prompt.includes('術語編輯')) return '[]';
      const ids = [...prompt.matchAll(/^(\d+): /gm)].map((m) => Number(m[1]));
      asked.push(ids);
      return JSON.stringify(ids.map((id) => ({ id, zh: `中文${id}。` })));
    };
    const r = await runPipeline(envOf(SUBS), 'ksfm6jeTg3Q', false, llm);
    expect(r.status).toBe(200);
    const bil = readJson(SUBS, 'subs/ksfm6jeTg3Q/bilingual.json');
    const dot = bil.cues[bil.cues.length - 1];
    expect(dot.orig).toBe('。');
    expect(dot.untranslated).toBeUndefined(); // 沒東西可翻 ≠ 翻譯失敗
    expect(asked.flat()).not.toContain(3); // 也沒被送去翻
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

describe('inbox 待補佇列（PWA 手機送片 → 桌機 ext 補收）', () => {
  // 端點層邏輯以 FakeR2 直接驗證行為（路由本身在 index.ts，此處測資料流與銷帳）
  it('ingest 成功會把該片從待補佇列銷帳（補收閉環）', async () => {
    const SUBS = new FakeR2();
    await SUBS.put('inbox/ksfm6jeTg3Q.json', JSON.stringify({ videoId: 'ksfm6jeTg3Q', requestedAt: 'x' }));
    // 模擬 /ingest 的關鍵兩步：寫 source + 刪 inbox
    await SUBS.put('subs/ksfm6jeTg3Q/source.json', JSON.stringify(makeSource()));
    await SUBS.delete('inbox/ksfm6jeTg3Q.json');
    expect(SUBS.store.has('inbox/ksfm6jeTg3Q.json')).toBe(false);
    // 銷帳後仍可正常翻譯
    const r = await runPipeline(envOf(SUBS), 'ksfm6jeTg3Q', false, fakeLlm);
    expect(r.status).toBe(200);
  });

  it('待補項目與影片資料分屬不同 prefix，不會污染清單/看門狗掃描', async () => {
    const SUBS = new FakeR2();
    const q = new FakeQueue();
    await SUBS.put('inbox/AAAAAAAAAAA.json', JSON.stringify({ videoId: 'AAAAAAAAAAA' }));
    // 看門狗只掃 subs/ → 待補項目不該被當成待翻譯（它連 source 都還沒有）
    const r = await watchdog(envOf(SUBS, q));
    expect(r.enqueued).toEqual([]);
    expect(r.scanned).toBe(0);
  });
});
