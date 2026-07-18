// Gemini Generative Language API 呼叫。429/5xx 退避重試兩次，其餘直接丟錯。

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export type LlmFn = (prompt: string) => Promise<string>;

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
    if (attempt < 2 && (res.status === 429 || res.status >= 500)) {
      await sleep(1500 * (attempt + 1));
      continue;
    }
    throw new Error(`Gemini API ${res.status}: ${(await res.text()).slice(0, 300)}`);
  }
}
