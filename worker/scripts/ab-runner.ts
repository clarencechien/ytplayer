// 本機 A/B 實驗 runner：同一支影片、不同模型，各跑一輪完整 text pipeline。
// 不碰 production R2 — source 從公開端點抓、輸出寫本機檔案。
// 用法：node ab-runner.bundle.mjs <videoId> <model> <outDir>
// 需求：環境變數 gemini_key、HTTPS_PROXY（node fetch 需手動接 proxy）

import { setGlobalDispatcher, ProxyAgent } from 'undici';
import { writeFileSync, mkdirSync } from 'node:fs';
import { runPipeline, type JobEnv } from '../src/jobs';

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

async function main() {
  const [videoId, model, outDir] = process.argv.slice(2);
  if (!videoId || !model || !outDir) throw new Error('用法：ab-runner <videoId> <model> <outDir>');
  const apiKey = process.env.gemini_key || process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error('缺 gemini_key 環境變數');

  const srcRes = await fetch(`https://ytplayer.ai-apps.work/subs/${videoId}/source.json`);
  if (!srcRes.ok) throw new Error(`source.json 抓不到（${srcRes.status}）`);
  const source = await srcRes.text();

  const SUBS = new MemR2();
  await SUBS.put(`subs/${videoId}/source.json`, source);
  const env = {
    SUBS: SUBS as unknown as R2Bucket,
    GEMINI_API_KEY: apiKey,
    GEMINI_MODEL: model,
    ...(process.env.CHUNK_SIZE ? { CHUNK_SIZE: process.env.CHUNK_SIZE } : {}),
  } as JobEnv;

  const t0 = Date.now();
  console.log(`[${model}] 開跑 ${videoId}…`);
  const r = await runPipeline(env, videoId, true);
  const elapsed = Math.round((Date.now() - t0) / 1000);
  console.log(`[${model}] status=${r.status} elapsed=${elapsed}s`);

  mkdirSync(outDir, { recursive: true });
  for (const name of ['bilingual.json', 'sentences.json', 'glossary.json', 'status.json']) {
    const obj = SUBS.store.get(`subs/${videoId}/${name}`);
    if (obj) writeFileSync(`${outDir}/${name}`, obj.value);
  }
  writeFileSync(`${outDir}/result.json`, JSON.stringify({ model, elapsed, ...r }, null, 2));
  if (r.status !== 200) throw new Error(`pipeline 未完成：${JSON.stringify(r.body).slice(0, 300)}`);
}

main().catch((e) => {
  console.error('FAILED:', e.message);
  process.exit(1);
});
