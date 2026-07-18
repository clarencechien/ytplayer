// 翻譯 pipeline 的 prompt 與禁用詞表。改任何 prompt 內容必須同步改 PROMPT_VERSION（cache key）。
//
// v2（依第一次實測 ksfm6jeTg3Q 調整）：
// - 目標觀眾明確化：台灣大學生程度、非本科領域，目標看懂六～八成
// - 術語呈現決策集中到 glossary pass：「中文（English）」/ 保留英文 / 純中文，
//   保留英文者必附 30 字白話 note（第一次出現時由程式端 attachGlossaryNotes 顯示給觀眾）
// - Phase 2.5：新增英文 ASR 修稿 prompt（Tier 3 + en 專用）

import type { Sentence } from './segment';
import type { GlossaryEntry } from './pipeline';

export const PROMPT_VERSION = 'v2';

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

const AUDIENCE = '目標觀眾：台灣的大學生程度、非本科領域的一般人。目標是讓他們看懂六～八成 — 未解釋的行話是最大的障礙。';

export function buildGlossaryPrompt(meta: PromptMeta, sentences: Sentence[]): string {
  return `你是專業影片字幕翻譯的術語編輯。${AUDIENCE}
以下是一支 YouTube 影片的資訊與完整英文字幕。
任務：抽出翻譯前需要統一的術語表，並替每個術語決定「呈現形式」與「白話註解」。

zh（呈現形式）規則：
- 有慣用中譯的領域術語 → 寫成「中文（English）」，例：護欄機制（Guardrails）、非確定性（Nondeterminism）、推論（Inference）
- 業界慣用直接講英文、硬翻反而難懂的（API、GPU、Agent、產品名） → 保留英文原文
- 人名、公司/組織名 → 保留原文
- 一般人都懂的常識詞（AI、Google） → 不必收進表

note（白話註解）規則：
- 非本科觀眾第一次看到會「蛤？」的詞，**必須**給 30 字內的白話解釋 — 特別是保留英文的那些
- 用日常語言解釋它是什麼／做什麼，不要用另一個行話解釋行話

只輸出純 JSON 陣列（無 markdown 圍欄、無前後文字），最多 60 條：
[{"term":"guardrails","zh":"護欄機制（Guardrails）","note":"限制 AI 行為範圍的安全機制"}]

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
    ? glossary.map((g) => `- ${g.term} → ${g.zh}${g.note ? `（${g.note}）` : ''}`).join('\n')
    : '（無）';
  return `你是資深字幕譯者，把英文影片字幕翻成道地的台灣正體中文。品質目標：明顯高於機器翻譯，讀起來像台灣人寫的字幕。
${AUDIENCE}

影片背景（幫助理解語境，不用翻譯）：
標題：${meta.title}／頻道：${meta.channel}
簡介節錄：${meta.description.slice(0, 300)}

術語表（全片必須一致，照表中 zh 的形式使用；括號內是給你參考的白話含義）：
${glossaryText}

術語使用規則：
- 術語在句中一律使用表中的 zh 形式；「中文（English）」形式的術語，同一句已出現過一次後可只寫中文部分
- 不在表中的專有名詞、技術縮寫：保留英文原文，不要硬翻

語言規範：
- 台灣正體中文，台灣慣用詞彙與語感
- 嚴禁中國用語，對照表：${bannedTable()}、視頻博主→YouTuber
- 避免翻譯腔（不要「令人印象深刻的」、「這是一個⋯⋯的過程」這類直譯句式），口語但精準

note（譯註）規則：
- 雙關、文化梗、慣用語、需要背景知識才懂的說法 → 加 "note"，30 字內白話解釋
- 術語本身的解釋不用你加（系統會在術語第一次出現時自動附上），不要為術語重複寫 note
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

// Phase 2.5 — 英文 ASR 修稿（Tier 3 + en 專用）
export function buildRepairPrompt(meta: PromptMeta, chunk: TranslateChunkInput, extraHint?: string): string {
  return `你是英文字幕編輯。以下句子來自 YouTube 自動語音辨識（ASR），可能含有：
同音字聽寫錯誤、專有名詞拼錯、[music]／[applause] 之類的雜訊標記、標點不完整。

影片背景（判斷專有名詞的依據）：
標題：${meta.title}／頻道：${meta.channel}
簡介節錄：${meta.description.slice(0, 300)}

任務：逐句修復成乾淨正確的英文。規則：
- 保持原意與口語風格：不改寫、不濃縮、不翻譯、不合併句子
- 移除 [music]、[applause] 等雜訊標記
- 依上下文修正明顯聽錯的詞，特別是人名、公司、產品、術語
- 標點與大小寫修到正常書寫水準
- id 原樣對應、一句不缺；沒問題的句子原樣輸出
${extraHint ? `\n特別注意：${extraHint}\n` : ''}
上文（僅供參考，不要輸出）：
${chunk.before.map((s) => s.text).join('\n') || '（無）'}

請修復下列句子：
${chunk.target.map((s) => `${s.id}: ${s.text}`).join('\n')}

下文（僅供參考，不要輸出）：
${chunk.after.map((s) => s.text).join('\n') || '（無）'}

輸出：純 JSON 陣列，無 markdown 圍欄、無說明文字。格式：
[{"id":0,"en":"corrected sentence"}]`;
}
