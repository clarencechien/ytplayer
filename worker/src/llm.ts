// Gemini Generative Language API 呼叫。
// 可重試：429/5xx，以及「User location is not supported」400 —— CF Worker 的
// 出口 colo 會變（台灣流量常經香港，該區不被 Gemini 支援），同一請求重打
// 常會走到支援的出口，實測有效。其餘錯誤直接丟。

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export type LlmFn = (prompt: string) => Promise<string>;

const MAX_ATTEMPTS = 4;

export async function geminiGenerate(apiKey: string, model: string, prompt: string): Promise<string> {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-goog-api-key': apiKey },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: { temperature: 0.2, responseMimeType: 'application/json' },
      }),
    });
    if (res.ok) {
      const data = (await res.json()) as {
        candidates?: Array<{ finishReason?: string; content?: { parts?: Array<{ text?: string }> } }>;
      };
      const cand = data.candidates?.[0];
      const text = (cand?.content?.parts ?? []).map((p) => p.text ?? '').join('');
      if (!text) throw new Error(`Gemini 回應無文字（finishReason: ${cand?.finishReason ?? '未知'}）`);
      return text;
    }
    const body = (await res.text()).slice(0, 300);
    const retryable =
      res.status === 429 || res.status >= 500 || (res.status === 400 && body.includes('location is not supported'));
    if (attempt < MAX_ATTEMPTS - 1 && retryable) {
      await sleep(1000 * (attempt + 1));
      continue;
    }
    throw new Error(`Gemini API ${res.status}: ${body}`);
  }
}
