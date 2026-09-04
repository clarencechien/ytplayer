// watchdog 的重排迴圈（y3）。
//
// 為什麼要有這支：failStatus 先前在 status.json 還不存在時直接 return，
// 而 probeDuration 跑在 writeStatus 之前 —— 一支「讀不到片長又沒給 durationMin」
// 的影片會 throw 在那裡，什麼痕跡都不留。watchdog 看到「沒有 status」就當成
// 沒跑過，每 5 分鐘重排一次，**永遠不停**。它不燒 LLM token（只花 countTokens
// 與 oEmbed），所以帳單上看不出來，但兩個 watchdog 名額被它佔掉一個。

import { describe, it, expect } from 'vitest';
import { watchdog, failStatus, MAX_WATCHDOG_ATTEMPTS } from '../src/jobs';
import { FakeR2, FakeQueue } from './fakes';

const VIDEO = 'ksfm6jeTg3Q';

function envWith(objects: Record<string, unknown>) {
  const subs = new FakeR2();
  for (const [k, v] of Object.entries(objects)) {
    (subs as unknown as { put(k: string, v: string): Promise<unknown> }).put(k, JSON.stringify(v));
  }
  return {
    env: { SUBS: subs as unknown as R2Bucket, JOBS: new FakeQueue() as unknown as Queue },
    subs,
  };
}

const watchDoc = { videoId: VIDEO, url: `https://youtu.be/${VIDEO}` };

describe('watchdog：失敗過的 job 不該被無限重排', () => {
  it('沒有 status.json 時會重排（這是它該做的事）', async () => {
    const { env } = envWith({ [`subs/${VIDEO}/watch.json`]: watchDoc });
    const r = await watchdog(env as never);
    expect(r.enqueued).toEqual([VIDEO]);
  });

  it('已標記 failed 就不再重排', async () => {
    const { env, subs } = envWith({ [`subs/${VIDEO}/watch.json`]: watchDoc });
    const head = await (subs as unknown as { head(k: string): Promise<{ uploaded: Date }> }).head(
      `subs/${VIDEO}/watch.json`
    );
    await (subs as unknown as { put(k: string, v: string): Promise<unknown> }).put(
      `subs/${VIDEO}/status.json`,
      JSON.stringify({
        videoId: VIDEO,
        stage: 'failed',
        failed: true,
        failReason: '讀不到片長',
        attempts: 1,
        sourceUploaded: head.uploaded.toISOString(),
        route: 'video',
        startedAt: new Date(0).toISOString(),
        updatedAt: new Date(0).toISOString(),
        repairBatches: 0,
        translateBatches: null,
        tokensUsed: 0,
        llmCalls: 0,
        retries: 0,
        asrRepaired: 0,
        warnings: [],
      })
    );
    const r = await watchdog(env as never);
    expect(r.enqueued).toEqual([]);
  });

  it('沒標 failed 但 attempts 到頂也停手（安全網）', async () => {
    const { env, subs } = envWith({ [`subs/${VIDEO}/watch.json`]: watchDoc });
    const head = await (subs as unknown as { head(k: string): Promise<{ uploaded: Date }> }).head(
      `subs/${VIDEO}/watch.json`
    );
    await (subs as unknown as { put(k: string, v: string): Promise<unknown> }).put(
      `subs/${VIDEO}/status.json`,
      JSON.stringify({
        videoId: VIDEO,
        stage: 'plan',
        attempts: MAX_WATCHDOG_ATTEMPTS,
        sourceUploaded: head.uploaded.toISOString(),
        route: 'video',
        startedAt: new Date(0).toISOString(),
        updatedAt: new Date(0).toISOString(), // 夠舊，STALE_MS 那一關不會擋
        repairBatches: 0,
        translateBatches: null,
        tokensUsed: 0,
        llmCalls: 0,
        retries: 0,
        asrRepaired: 0,
        warnings: [],
      })
    );
    const r = await watchdog(env as never);
    expect(r.enqueued).toEqual([]);
  });
});

describe('failStatus：status.json 還不存在時也要留下痕跡', () => {
  it('沒有既有 status + 有錨點 → 寫出一筆 failed，watchdog 從此不再重排', async () => {
    const { env, subs } = envWith({ [`subs/${VIDEO}/watch.json`]: watchDoc });
    const head = await (subs as unknown as { head(k: string): Promise<{ uploaded: Date }> }).head(
      `subs/${VIDEO}/watch.json`
    );

    // 重排一次是對的（還沒跑過）
    expect((await watchdog(env as never)).enqueued).toEqual([VIDEO]);

    // 這就是 probeDuration 炸掉的那一刻：status.json 尚未建立
    await failStatus(env as never, VIDEO, 'plan 步驟連續失敗：讀不到片長', {
      sourceUploaded: head.uploaded.toISOString(),
      route: 'video',
    });

    const st = JSON.parse(
      await (
        await (subs as unknown as { get(k: string): Promise<{ text(): Promise<string> }> }).get(
          `subs/${VIDEO}/status.json`
        )
      ).text()
    );
    expect(st.failed).toBe(true);
    expect(st.attempts).toBe(1);
    expect(st.sourceUploaded).toBe(head.uploaded.toISOString());

    // 這一次就不該再排了
    expect((await watchdog(env as never)).enqueued).toEqual([]);
  });

  it('沒有錨點就不寫（連是哪一版都不知道，寫了反而會擋住之後的重跑）', async () => {
    const { env, subs } = envWith({});
    await failStatus(env as never, VIDEO, 'x');
    expect(
      await (subs as unknown as { get(k: string): Promise<unknown> }).get(`subs/${VIDEO}/status.json`)
    ).toBeNull();
  });

  it('已有 status 時累加 attempts', async () => {
    const { env, subs } = envWith({
      [`subs/${VIDEO}/watch.json`]: watchDoc,
      [`subs/${VIDEO}/status.json`]: { videoId: VIDEO, stage: 'plan', attempts: 1, warnings: [] },
    });
    await failStatus(env as never, VIDEO, 'again');
    const st = JSON.parse(
      await (
        await (subs as unknown as { get(k: string): Promise<{ text(): Promise<string> }> }).get(
          `subs/${VIDEO}/status.json`
        )
      ).text()
    );
    expect(st.attempts).toBe(2);
    expect(st.failed).toBe(true);
  });
});
