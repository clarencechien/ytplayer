// 翻譯 pipeline 的 prompt 與禁用詞表。改任何 prompt 內容必須同步改 PROMPT_VERSION（cache key）。

import type { Sentence } from './segment';
import type { GlossaryEntry } from './pipeline';

export const PROMPT_VERSION = 'v1';

// handoff §4.4 對照表。左：禁用（中國用語），右：台灣慣用。程式端掃描 + prompt 內文皆用此表。
export const BANNED_WORDS: Array<[string, string]> = [
  ['視頻', '影片'],
  ['質量', '品質'],
  ['信息', '資訊'],
  ['網絡', '網路'],
  ['軟件', '軟體'],
  ['硬件', '硬體'],
  ['屏幕', '螢幕'],
  ['數據', '資料'],
  ['用戶', '使用者'],
  ['默認', '預設'],
  ['激活', '啟用'],
  ['調用', '呼叫'],
  ['打印', '列印'],
  ['內存', '記憶體'],
  ['優化', '最佳化'],
  ['菜單', '選單'],
];

export interface PromptMeta {
  title: string;
  channel: string;
  description: string;
}

const bannedTable = () => BANNED_WORDS.map(([bad, good]) => `${bad}→${good}`).join('、');

export function buildGlossaryPrompt(meta: PromptMeta, sentences: Sentence[]): string {
  return `你是專業影片字幕翻譯的術語編輯。以下是一支 YouTube 影片的資訊與完整英文字幕。
任務：抽出翻譯前需要統一的術語表，供後續逐段翻譯時全片一致使用。

包含：人名、公司/組織/產品名、領域專有術語（技術、財經、半導體、航太等）、縮寫（附展開）。
規則：
- suggested_zh 給台灣慣用譯法；業界慣用直接講英文的（如 API、GPU、Starship），suggested_zh 就填英文原文
- note 選填，20 字內（縮寫展開或必要說明）
- 最多 60 條，只收真的會影響翻譯一致性的詞
- 只輸出純 JSON 陣列，不要 markdown 圍欄、不要任何前後文字
格式：[{"term":"...","suggested_zh":"...","note":"..."}]

影片標題：${meta.title}
頻道：${meta.channel}
簡介節錄：${meta.description.slice(0, 500)}

字幕全文：
${sentences.map((s) => s.text).join('\n')}`;
}

export interface TranslateChunkInput {
  before: Sentence[];
  target: Sentence[];
  after: Sentence[];
}

export function buildTranslatePrompt(
  meta: PromptMeta,
  glossary: GlossaryEntry[],
  chunk: TranslateChunkInput,
  extraHint?: string
): string {
  const glossaryText = glossary.length
    ? glossary.map((g) => `- ${g.term} → ${g.suggested_zh}${g.note ? `（${g.note}）` : ''}`).join('\n')
    : '（無）';
  return `你是資深字幕譯者，把英文影片字幕翻成道地的台灣正體中文。目標：品質明顯高於機器翻譯，讀起來像台灣人寫的字幕。

影片背景（幫助理解語境，不用翻譯）：
標題：${meta.title}／頻道：${meta.channel}
簡介節錄：${meta.description.slice(0, 300)}

術語表（全片必須一致使用）：
${glossaryText}

語言規範：
- 台灣正體中文，台灣慣用詞彙與語感
- 嚴禁中國用語，對照表：${bannedTable()}、視頻博主→YouTuber
- 避免翻譯腔（不要「令人印象深刻的」、「這是一個⋯⋯的過程」這類直譯句式），口語但精準
- 專有名詞與技術縮寫保留英文原文，不要硬翻
- 遇到雙關、文化梗、需要背景知識的縮寫，加 "note" 欄位（20 字內），沒有就省略
${extraHint ? `\n特別注意：${extraHint}\n` : ''}
上文（僅供銜接語氣，不要翻譯）：
${chunk.before.map((s) => s.text).join('\n') || '（無）'}

請翻譯下列句子，id 必須原樣對應、一句不缺：
${chunk.target.map((s) => `${s.id}: ${s.text}`).join('\n')}

下文（僅供銜接語氣，不要翻譯）：
${chunk.after.map((s) => s.text).join('\n') || '（無）'}

輸出：純 JSON 陣列，無 markdown 圍欄、無說明文字。格式：
[{"id":0,"zh":"中文翻譯","note":"選填譯註"}]`;
}
