import { describe, it, expect, vi, afterEach } from 'vitest';
import { geminiGenerate } from '../src/llm';

const okResponse = (text: string) =>
  new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text }] } }] }), { status: 200 });

afterEach(() => vi.unstubAllGlobals());

describe('geminiGenerate 重試策略', () => {
  it('「User location is not supported」400 視為可重試（CF 出口 colo 輪替）', async () => {
    let calls = 0;
    vi.stubGlobal('fetch', async () => {
      calls++;
      if (calls === 1) {
        return new Response(JSON.stringify({ error: { code: 400, message: 'User location is not supported for the API use.' } }), { status: 400 });
      }
      return okResponse('成功了');
    });
    const out = await geminiGenerate('key', 'model', 'prompt');
    expect(out).toBe('成功了');
    expect(calls).toBe(2);
  });

  it('其他 400（如參數錯誤）不重試，直接丟', async () => {
    let calls = 0;
    vi.stubGlobal('fetch', async () => {
      calls++;
      return new Response(JSON.stringify({ error: { code: 400, message: 'Invalid argument: contents' } }), { status: 400 });
    });
    await expect(geminiGenerate('key', 'model', 'prompt')).rejects.toThrow('400');
    expect(calls).toBe(1);
  });

  it('連續 location 400 到達上限後丟錯（不無限重試）', { timeout: 15000 }, async () => {
    let calls = 0;
    vi.stubGlobal('fetch', async () => {
      calls++;
      return new Response(JSON.stringify({ error: { message: 'User location is not supported for the API use.' } }), { status: 400 });
    });
    await expect(geminiGenerate('key', 'model', 'prompt')).rejects.toThrow('location is not supported');
    expect(calls).toBe(4);
  });

  it('429/5xx 照樣重試', async () => {
    let calls = 0;
    vi.stubGlobal('fetch', async () => {
      calls++;
      if (calls < 3) return new Response('overloaded', { status: calls === 1 ? 429 : 503 });
      return okResponse('ok');
    });
    expect(await geminiGenerate('key', 'model', 'prompt')).toBe('ok');
    expect(calls).toBe(3);
  });
});
