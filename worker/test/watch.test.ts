// video 路由（Gemini 看片，自 kvsplayer 移植）：解析/清洗/失敗階梯/掃描推進 + queue 端到端。
import { describe, it, expect } from 'vitest';
import {
  parseWatchOutput,
  sanitizeWatchCues,
  initWatchState,
  nextSegment,
  advance,
  applyFailureLadder,
  type WatchCue,
  type WatchLlmFn,
} from '../src/watch';
import { runPipeline, watchdog, type JobStatus } from '../src/jobs';
import { FakeR2, FakeQueue, drain, envOf, readJson } from './fakes';

describe('parseWatchOutput', () => {
  it('MM:SS 轉秒、clamp 到段界、kvsplayer 舊 schema（ko 欄位）相容', () => {
    const raw = JSON.stringify([
      { start: '3:05', end: '3:09', kind: 'speech', orig: '안녕', zh: '哈囉' },
      { start: '2:00', end: '3:00', kind: 'card', ko: '舊欄位', zh: '字卡' }, // start 早於段界 → clamp
      { start: 'x', end: '3:10', kind: 'speech', zh: '壞時間戳' }, // 丟棄
      { start: '3:20', end: '3:22', kind: 'speech', orig: '', zh: '' }, // 空 zh 丟棄
    ]);
    const cues = parseWatchOutput(raw, 180, 360);
    expect(cues.length).toBe(2);
    expect(cues[0]).toMatchObject({ start: 185, end: 189, kind: 'speech', orig: '안녕', zh: '哈囉' });
    expect(cues[1]).toMatchObject({ start: 180, kind: 'card', orig: '舊欄位' });
  });

  it('輸出截斷 → 逐 } 回退救回完整 cue', () => {
    const good = [
      { start: '0:10', end: '0:12', kind: 'speech', orig: 'a', zh: '一' },
      { start: '0:14', end: '0:16', kind: 'speech', orig: 'b', zh: '二' },
    ];
    const truncated = JSON.stringify(good).slice(0, -20); // 砍尾
    const cues = parseWatchOutput(truncated, 0, 180);
    expect(cues.length).toBe(1);
    expect(cues[0].zh).toBe('一');
  });
});

describe('sanitizeWatchCues（清洗 + 卡卡修法）', () => {
  const c = (over: Partial<WatchCue>): WatchCue => ({
    start: 0,
    end: 4,
    kind: 'speech',
    orig: '',
    zh: '句',
    ...over,
  });

  it('壞時間戳修正、speech 15s 上限、韓文字母洩漏清除', () => {
    const out = sanitizeWatchCues([
      c({ start: 10, end: 5, zh: 'end 早於 start' }), // → end = start+4
      c({ start: 20, end: 60, zh: '太長' }), // → 15s cap
      c({ start: 50, end: 53, zh: '洩漏한글啦' }),
    ]);
    expect(out[0].end).toBe(14);
    expect(out[1].end).toBe(35);
    expect(out[2].zh).toBe('洩漏啦');
  });

  it('card 與同步內嵌字幕（名牌|對白）判重：同文即丟', () => {
    const out = sanitizeWatchCues([
      c({ start: 10, end: 13, kind: 'speech', orig: '진짜 맛있다', zh: '真的好吃' }),
      c({ start: 11, end: 14, kind: 'card', orig: '재석 | 진짜 맛있다', zh: '真的好吃（重複）' }), // dup → 丟
      c({ start: 12, end: 15, kind: 'card', orig: '충격', zh: '衝擊' }), // 真字卡 → 留
    ]);
    expect(out.filter((x) => x.kind === 'card').length).toBe(1);
    expect(out.find((x) => x.kind === 'card')!.zh).toBe('衝擊');
  });

  it('重疊掃描的同型重複合併 + speech 單調不重疊', () => {
    const out = sanitizeWatchCues([
      c({ start: 10, end: 14, orig: '같은 말', zh: '同一句' }),
      c({ start: 12, end: 16, orig: '같은 말', zh: '同一句' }), // 合併 → end 16
      c({ start: 15, end: 19, orig: '다음', zh: '下一句' }), // 與前句重疊 → 前句 end 縮到 15
    ]);
    expect(out.length).toBe(2);
    expect(out[0].end).toBe(15); // 合併後被不重疊規則縮回
    expect(out[1].start).toBe(15);
  });
});

describe('掃描推進與失敗階梯（kvsplayer 實戰配方）', () => {
  it('covered_s 從最後一句結尾接續（截斷不漏內容）；掃完收尾', () => {
    const w = initWatchState(360, false);
    const seg1 = nextSegment(w);
    expect(seg1).toMatchObject({ n: 0, startS: 0, endS: 180 });
    // 段輸出只到 150s（截斷）→ 下一段從 150s 接續
    const r1 = advance(w, seg1, [{ start: 10, end: 150, kind: 'speech', orig: '', zh: 'x' }]);
    expect(r1.ended).toBe(false);
    expect(w.covered_s).toBe(150);
    const seg2 = nextSegment(w);
    expect(seg2.startS).toBe(150);
    const r2 = advance(w, seg2, [{ start: 200, end: 330, kind: 'speech', orig: '', zh: 'y' }]);
    expect(r2.ended).toBe(false); // covered 330 < 360
    const r3 = advance(w, nextSegment(w), []);
    expect(r3.ended).toBe(true); // 非 open：endS 蓋到 360
  });

  it('open 模式：空段 = 片尾', () => {
    const w = initWatchState(600, true);
    const r = advance(w, nextSegment(w), []);
    expect(r.ended).toBe(true);
  });

  it('階梯：2 連炸 → 60s 細掃；細掃 3 炸（中段）→ 跳毒段；片尾附近 → 收尾', () => {
    const w = initWatchState(3600, false);
    expect(applyFailureLadder(w, 'Gemini 500: x')).toBe('retry');
    expect(applyFailureLadder(w, 'Gemini 500: x')).toBe('retry'); // fail_count 2 → 降級
    expect(w.try_len).toBe(60);
    expect(applyFailureLadder(w, 'boom')).toBe('retry');
    expect(applyFailureLadder(w, 'boom')).toBe('retry');
    expect(applyFailureLadder(w, 'boom')).toBe('continue'); // 細掃 3 炸 → 跳 60s
    expect(w.skipped).toEqual([0]);
    expect(w.covered_s).toBe(60);

    // 片尾附近（剩 ≤360s）細掃連炸 → 判定實際結尾
    const w2 = initWatchState(600, false);
    w2.covered_s = 400;
    w2.try_len = 60;
    w2.fail_count = 2;
    w2.fail_key = '400'; // 同一位置連炸（key 換了會重數）
    expect(applyFailureLadder(w2, 'boom')).toBe('continue');
    expect(w2.duration_s).toBe(400);
    expect(w2.open).toBe(false);
  });

  it('No frames to extract = 影片實際結尾，立即收尾', () => {
    const w = initWatchState(600, true);
    w.covered_s = 431;
    expect(applyFailureLadder(w, 'Gemini 400: No frames to extract from video')).toBe('continue');
    expect(w.duration_s).toBe(431);
    expect(w.open).toBe(false);
  });

  it('total_fails 超過 60 → fatal（kvsplayer 的全域保險絲）', () => {
    const w = initWatchState(3600, false);
    let r: string = 'retry';
    for (let i = 0; i < 200 && r !== 'fatal'; i++) {
      r = applyFailureLadder(w, 'unknown error');
      // 模擬每次都在新位置炸（不觸發縮段/跳段路徑）
      w.covered_s += 1;
    }
    expect(r).toBe('fatal');
    expect(w.total_fails).toBeGreaterThan(60);
  });
});

describe('video 路由端到端（queue）', () => {
  // 兩段（6 分鐘）假影片：每段回一句對白 + 第一段一張字卡
  const fakeWatch: WatchLlmFn = async ({ startS, endS }) => {
    const mm = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
    // 最後一句结到段尾 → covered_s 剛好推進一整段（真實情境：對白鋪滿整段）
    const cues = [
      { start: mm(startS + 5), end: mm(startS + 9), kind: 'speech', orig: `말 ${startS}`, zh: `第 ${startS} 秒的話` },
      { start: mm(endS - 6), end: mm(endS), kind: 'speech', orig: '끝', zh: '段尾的話' },
      ...(startS === 0 ? [{ start: '0:20', end: '0:24', kind: 'card', orig: '충격!', zh: '衝擊！' }] : []),
    ];
    return JSON.stringify(cues);
  };

  it('watch.json → plan(video) → watch×2 → assemble：bilingual v2（trust=model、含字卡）', async () => {
    const SUBS = new FakeR2();
    const env = envOf(SUBS);
    await SUBS.put(
      'subs/AAAAAAAAAAA/watch.json',
      JSON.stringify({ requestedAt: new Date().toISOString(), durationMin: 6, lang: 'ko', title: '韓綜測試' })
    );
    const r = await runPipeline(env, 'AAAAAAAAAAA', false, undefined, 'video', fakeWatch);
    expect(r.status).toBe(200);
    const stats = (r.body as { stats: Record<string, unknown> }).stats;
    expect(stats.segments).toBe(2);
    expect(stats.cards).toBe(1);

    const bil = readJson(SUBS, 'subs/AAAAAAAAAAA/bilingual.json');
    expect(bil.schema).toBe(2);
    expect(bil.route).toBe('video');
    expect(bil.trust).toBe('model');
    expect(bil.sourceLang).toBe('ko');
    expect(bil.meta.title).toBe('韓綜測試');
    expect(bil.cues.some((c: { kind: string }) => c.kind === 'card')).toBe(true);
    expect(SUBS.store.has('subs/AAAAAAAAAAA/bilingual.srt')).toBe(true);
    const st = readJson(SUBS, 'subs/AAAAAAAAAAA/status.json') as JobStatus;
    expect(st.stage).toBe('done');
    expect([...SUBS.store.keys()].filter((k) => k.includes('/parts/'))).toEqual([]);
  });

  it('看門狗把 pending 的 watch 請求排回去（route: video）', async () => {
    const SUBS = new FakeR2();
    const q = new FakeQueue();
    const env = envOf(SUBS, q);
    await SUBS.put('subs/BBBBBBBBBBB/watch.json', JSON.stringify({ requestedAt: new Date().toISOString(), durationMin: 3 }));
    const r = await watchdog(env);
    expect(r.enqueued).toEqual(['BBBBBBBBBBB']);
    expect(q.pending[0].body).toEqual({ videoId: 'BBBBBBBBBBB', step: 'plan', route: 'video' });
    // drain 跑完整條鏈
    await drain(q, env, undefined, 100, fakeWatch);
    expect(readJson(SUBS, 'subs/BBBBBBBBBBB/bilingual.json').route).toBe('video');
  });

  it('看片失敗走階梯而不是永久失敗：一段炸兩次後縮段續跑、最終完成', async () => {
    const SUBS = new FakeR2();
    const q = new FakeQueue();
    const env = envOf(SUBS, q);
    await SUBS.put('subs/CCCCCCCCCCC/watch.json', JSON.stringify({ requestedAt: new Date().toISOString(), durationMin: 3 }));
    let booms = 0;
    const flaky: WatchLlmFn = async (a) => {
      if (a.startS === 0 && booms < 2) {
        booms++;
        throw new Error('Gemini 500: transient');
      }
      return fakeWatch(a);
    };
    await q.send({ videoId: 'CCCCCCCCCCC', step: 'plan', route: 'video' });
    await drain(q, env, undefined, 100, flaky);
    const st = readJson(SUBS, 'subs/CCCCCCCCCCC/status.json') as JobStatus;
    expect(st.failed).toBeUndefined();
    expect(st.stage).toBe('done');
    expect(st.watch!.try_len).toBeUndefined(); // 成功後恢復
    expect(readJson(SUBS, 'subs/CCCCCCCCCCC/bilingual.json').cues.length).toBeGreaterThan(0);
  });
});
