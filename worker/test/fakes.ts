// 測試共用替身：R2 / Queue / 投遞驅動
import { handleJob, type JobMsg, type MsgLike, type JobEnv } from '../src/jobs';
import type { LlmFn } from '../src/llm';
import type { WatchLlmFn } from '../src/watch';

export class FakeR2 {
  store = new Map<string, { value: string; uploaded: Date }>();
  private seq = 0;
  async get(key: string) {
    const e = this.store.get(key);
    return e === undefined ? null : { text: async () => e.value, body: e.value };
  }
  async put(key: string, value: string) {
    // uploaded 單調遞增（貼近 now，讓新鮮度判斷成立）
    this.store.set(key, { value: String(value), uploaded: new Date(Date.now() + this.seq++) });
  }
  async head(key: string) {
    const e = this.store.get(key);
    return e === undefined ? null : { uploaded: e.uploaded };
  }
  async delete(key: string) {
    this.store.delete(key);
  }
  async list({ prefix, delimiter }: { prefix: string; delimiter?: string; cursor?: string }) {
    const delimitedPrefixes = new Set<string>();
    const objects: Array<{ key: string }> = [];
    for (const key of this.store.keys()) {
      if (!key.startsWith(prefix)) continue;
      if (delimiter) {
        const rest = key.slice(prefix.length);
        const i = rest.indexOf(delimiter);
        if (i >= 0) delimitedPrefixes.add(prefix + rest.slice(0, i + 1));
        else objects.push({ key });
      } else {
        objects.push({ key });
      }
    }
    return { delimitedPrefixes: [...delimitedPrefixes], objects, truncated: false as const };
  }
}

// 佇列 + 投遞驅動：retry 會以 attempts+1 重新入列（模擬 Queues at-least-once 語意）
export class FakeQueue {
  pending: Array<{ body: JobMsg; attempts: number }> = [];
  async send(m: JobMsg) {
    this.pending.push({ body: m, attempts: 1 });
  }
}

export async function drain(
  q: FakeQueue,
  env: JobEnv,
  llm?: LlmFn,
  maxIter = 100,
  watchLlm?: WatchLlmFn
): Promise<number> {
  let iter = 0;
  while (q.pending.length > 0 && iter < maxIter) {
    iter++;
    const item = q.pending.shift()!;
    const msg: MsgLike = {
      body: item.body,
      attempts: item.attempts,
      ack() {},
      retry() {
        q.pending.push({ body: item.body, attempts: item.attempts + 1 });
      },
    };
    await handleJob(msg, env, llm, watchLlm);
  }
  return iter;
}

export const envOf = (SUBS: FakeR2, JOBS?: FakeQueue): JobEnv =>
  ({ SUBS: SUBS as unknown as R2Bucket, JOBS, GEMINI_MODEL: 'fake-model' }) as JobEnv;

export const readJson = (SUBS: FakeR2, key: string) => JSON.parse(SUBS.store.get(key)!.value);
