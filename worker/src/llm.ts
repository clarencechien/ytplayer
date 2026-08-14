// Gemini Generative Language API 呼叫。
// 可重試：429/5xx，以及「User location is not supported」400 —— CF Worker 的
// 出口 colo 會變（台灣流量常經香港，該區不被 Gemini 支援），同一請求重打
// 常會走到支援的出口，實測有效。其餘錯誤直接丟。
//
// thinking（docs/gemini-api-lessons.md §1）：Gemini 3.x 預設開推理，思考 token 以
// 「輸出價」計費。翻譯/修稿是機械性 JSON 轉換不需要推理 → 預設 thinkingLevel='minimal'。
// 為什麼不用 thinkingBudget：**budget 是預算不是硬上限**。本 repo 用真實翻譯 prompt 實測
// （2026-08-14，3.5-flash）：不設 → thoughts 1909（5.5×）、budget 128 → thoughts **507**（1.5×）、
// level minimal → **0**。早前量到「budget 128 → thoughts=0」是玩具 prompt 的巧合，不可依賴。
// 規則：budget 與 level 永不同時給（400「only one of...」）；模型拒絕 thinkingConfig 時
// 自動退回不帶設定再試一次。

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export type LlmFn = (prompt: string) => Promise<string>;

export interface LlmUsage {
  total: number;
  prompt: number;
  output: number;
  thoughts: number;
}

// 二選一，永不同時送出。null = 不帶 thinkingConfig（用模型預設）
export type Thinking = { level: string } | { budget: number } | null;

const MAX_ATTEMPTS = 4;

export async function geminiGenerate(
  apiKey: string,
  model: string,
  prompt: string,
  onUsage?: (u: LlmUsage) => void,
  thinking: Thinking = { level: 'minimal' }
): Promise<string> {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;
  let think = thinking;
  for (let attempt = 0; ; attempt++) {
    const thinkingConfig = think
      ? 'level' in think
        ? { thinkingLevel: think.level }
        : { thinkingBudget: think.budget }
      : undefined;
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-goog-api-key': apiKey },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: {
          temperature: 0.2,
          responseMimeType: 'application/json',
          ...(thinkingConfig ? { thinkingConfig } : {}),
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
    // 模型不接受這個 thinking 旋鈕（舊模型不懂 level、新模型拒收 budget 0…）→ 拿掉再試。
    // Google 的 400 訊息很泛，「invalid argument」也視為此類；若真是別的問題，重試同樣會 400 正常拋出
    if (res.status === 400 && think != null && /thinking|invalid argument/i.test(body)) {
      think = null;
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
