// Gemini Generative Language API 呼叫。
// 可重試：429/5xx，以及「User location is not supported」400 —— CF Worker 的
// 出口 colo 會變（台灣流量常經香港，該區不被 Gemini 支援），同一請求重打
// 常會走到支援的出口，實測有效。其餘錯誤直接丟。
//
// thinking：Gemini 2.5+ 預設開推理，思考 token 以「輸出價」計費。翻譯/修稿是
// 機械性 JSON 轉換不需要推理 — 預設 thinkingBudget=128（2026-08-13 帳單事故：
// AI Studio 用量圖 Output 是 Input 的 3–4 倍，全是 thinking）。
// 為什麼是 128 不是 0：實測 3.6-flash 拒收 0（400 invalid argument）但接受 128
// 且實際 thoughts=0；3.5-flash 兩者皆可。128 是兩者通吃的「實質關閉」。
// 模型仍拒絕時（400），自動退回不帶 thinkingConfig 再試一次。

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export type LlmFn = (prompt: string) => Promise<string>;

export interface LlmUsage {
  total: number;
  prompt: number;
  output: number;
  thoughts: number;
}

const MAX_ATTEMPTS = 4;

export async function geminiGenerate(
  apiKey: string,
  model: string,
  prompt: string,
  onUsage?: (u: LlmUsage) => void,
  thinkingBudget: number | null = 128
): Promise<string> {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;
  let budget = thinkingBudget;
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-goog-api-key': apiKey },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: {
          temperature: 0.2,
          responseMimeType: 'application/json',
          ...(budget != null ? { thinkingConfig: { thinkingBudget: budget } } : {}),
        },
      }),
    });
    if (res.ok) {
      const data = (await res.json()) as {
        usageMetadata?: {
          totalTokenCount?: number;
          promptTokenCount?: number;
          candidatesTokenCount?: number;
          thoughtsTokenCount?: number;
        };
        candidates?: Array<{ finishReason?: string; content?: { parts?: Array<{ text?: string }> } }>;
      };
      const u = data.usageMetadata;
      if (onUsage && u?.totalTokenCount) {
        onUsage({
          total: u.totalTokenCount,
          prompt: u.promptTokenCount ?? 0,
          output: u.candidatesTokenCount ?? 0,
          thoughts: u.thoughtsTokenCount ?? 0,
        });
      }
      const cand = data.candidates?.[0];
      const text = (cand?.content?.parts ?? []).map((p) => p.text ?? '').join('');
      if (!text) throw new Error(`Gemini 回應無文字（finishReason: ${cand?.finishReason ?? '未知'}）`);
      return text;
    }
    const body = (await res.text()).slice(0, 300);
    // 模型不接受 thinkingBudget 設定 → 拿掉再試（Google 的 400 訊息很泛，
    // 「invalid argument」也視為此類；若真是別的問題，重試同樣會 400 再正常拋出）
    if (res.status === 400 && budget != null && /thinking|invalid argument/i.test(body)) {
      budget = null;
      continue;
    }
    const retryable =
      res.status === 429 || res.status >= 500 || (res.status === 400 && body.includes('location is not supported'));
    if (attempt < MAX_ATTEMPTS - 1 && retryable) {
      await sleep(1000 * (attempt + 1));
      continue;
    }
    throw new Error(`Gemini API ${res.status}: ${body}`);
  }
}
