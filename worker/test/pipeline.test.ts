import { describe, it, expect } from 'vitest';
import {
  cleanJson,
  scanBanned,
  scanExtended,
  cleanAsrText,
  chunkSentences,
  translateChunk,
  repairChunk,
  sanityCheckItem,
  echoMismatch,
  assembleBilingual,
  attachGlossaryNotes,
  toSrt,
} from '../src/pipeline';
import type { BilingualCue } from '../src/pipeline';
import type { Sentence } from '../src/segment';
import type { Cue } from '../src/validate';

const sent = (id: number, text = `sentence ${id}.`): Sentence => ({ id, text, cueIds: [id] });
const meta = { title: 't', channel: 'c', description: 'd' };

describe('cleanJson', () => {
  it('接受純 JSON、markdown 圍欄、前後雜訊三種', () => {
    expect(cleanJson('[{"id":0}]')).toEqual([{ id: 0 }]);
    expect(cleanJson('```json\n[{"id":0}]\n```')).toEqual([{ id: 0 }]);
    expect(cleanJson('好的，以下是翻譯：\n[{"id":0}]\n以上。')).toEqual([{ id: 0 }]);
  });
  it('無法解析就丟錯', () => {
    expect(() => cleanJson('完全不是 JSON')).toThrow();
  });
  it('中途截斷的 JSON 救回已完整的部分', () => {
    expect(cleanJson('[{"id":0,"zh":"甲"},{"id":1,"zh":"乙"},{"id":2,"zh":"丙')).toEqual([
      { id: 0, zh: '甲' },
      { id: 1, zh: '乙' },
    ]);
  });
});

describe('scanBanned', () => {
  it('抓中國用語、放過台灣用語', () => {
    expect(scanBanned('這個視頻的質量很好')).toEqual(['視頻', '質量']);
    expect(scanBanned('這支影片的品質很好，軟體與硬體都讚')).toEqual([]);
  });
  it('speak-human-tw 策展追加詞也在執法層', () => {
    expect(scanBanned('服務器不兼容，用鼠標卸載')).toEqual(['服務器', '鼠標', '兼容', '卸載']);
    expect(scanBanned('伺服器不相容，用滑鼠移除')).toEqual([]);
  });
  it('物理的質量（mass）是正確用法，不誤傷', () => {
    expect(scanBanned('龐大的質量流量（Mass flow）與能量')).toEqual([]);
    expect(scanBanned('火箭的質量（Mass）非常大')).toEqual([]);
    expect(scanBanned('質量流量很大，但翻譯質量很差')).toEqual(['質量']);
  });
});

describe('scanExtended（OpenCC 報告層）', () => {
  it('詞表載入正常且能命中（僅提示用）', async () => {
    const { EXTENDED } = await import('../src/twlexicon');
    expect(EXTENDED.length).toBeGreaterThan(500);
    const [bad, good] = EXTENDED.find(([b]) => b === '網吧')!;
    expect(scanExtended(`他在${bad}打電動`)).toEqual([`${bad}→${good}`]);
    expect(scanExtended('他在網咖打電動')).toEqual([]);
  });
  it('執法層與報告層不重疊（視頻只歸執法層）', () => {
    expect(scanExtended('這個視頻的質量')).toEqual([]);
  });
});

describe('cleanAsrText', () => {
  it('去除 [標記] 與 >> 記號，摺疊空白', () => {
    expect(cleanAsrText('When dealing [music] with rockets')).toBe('When dealing with rockets');
    expect(cleanAsrText('>> Hello there')).toBe('Hello there');
    expect(cleanAsrText('so >> what now')).toBe('so what now');
  });
  it('純雜訊句清成空字串（上游會整句移除）', () => {
    expect(cleanAsrText('>> [music]')).toBe('');
    expect(cleanAsrText('[cheering] [applause]')).toBe('');
  });
});

describe('chunkSentences', () => {
  it('40 句一塊、前後 overlap 2', () => {
    const ss = Array.from({ length: 85 }, (_, i) => sent(i));
    const chunks = chunkSentences(ss);
    expect(chunks.length).toBe(3);
    expect(chunks[0].before.length).toBe(0);
    expect(chunks[0].target.map((s) => s.id)).toEqual([...Array(40).keys()]);
    expect(chunks[1].before.map((s) => s.id)).toEqual([38, 39]);
    expect(chunks[1].after.map((s) => s.id)).toEqual([80, 81]);
    expect(chunks[2].target.length).toBe(5);
    expect(chunks[2].after.length).toBe(0);
  });
});

describe('sanityCheckItem（fail-fast，不用 LLM 自我審查）', () => {
  const en = 'the models are really great and can figure out steps';
  it('簡體字直接打回', () => {
    expect(sanityCheckItem(en, '这些模型真的很棒')).toContain('簡體');
    expect(sanityCheckItem(en, '模型可以在护栏内运作')).toContain('簡體');
  });
  it('沒翻（原文照抄 / 無中文）打回', () => {
    expect(sanityCheckItem(en, en)).toBeTruthy();
    expect(sanityCheckItem(en, 'some english output only')).toBeTruthy();
  });
  it('正常繁體譯文通過；短句保留英文（OK、專有名詞）不誤殺', () => {
    expect(sanityCheckItem(en, '這些模型真的很強，能自己想出步驟。')).toBeNull();
    expect(sanityCheckItem('OK.', 'OK。')).toBeNull();
    expect(sanityCheckItem('Katelyn?', 'Katelyn？')).toBeNull();
  });
  it('譯文長度爆走打回', () => {
    expect(sanityCheckItem('Hi there friends.', '哈'.repeat(200))).toContain('長度');
  });
});

describe('translateChunk', () => {
  const chunk = { before: [], target: [sent(0), sent(1)], after: [] };

  it('一次成功', async () => {
    const llm = async () => '[{"id":0,"zh":"零"},{"id":1,"zh":"一","note":"備註"}]';
    const r = await translateChunk(llm, meta, [], chunk);
    expect(r.retries).toBe(0);
    expect(r.byId.get(0)).toEqual({ zh: '零', note: undefined });
    expect(r.byId.get(1)).toEqual({ zh: '一', note: '備註' });
  });

  it('第一次壞 JSON → 重試一次成功', async () => {
    let n = 0;
    const llm = async () => (n++ === 0 ? '不是 JSON' : '[{"id":0,"zh":"零"},{"id":1,"zh":"一"}]');
    const r = await translateChunk(llm, meta, [], chunk);
    expect(r.retries).toBe(1);
    expect(r.byId.size).toBe(2);
  });

  it('缺句 → 重試；兩次都缺 → 回傳部分結果不丟錯', async () => {
    const llm = async () => '[{"id":0,"zh":"零"}]';
    const r = await translateChunk(llm, meta, [], chunk);
    expect(r.retries).toBe(1);
    expect(r.byId.size).toBe(1);
  });

  it('禁用詞命中 → 帶提示重打並採用乾淨版本', async () => {
    let n = 0;
    const llm = async (prompt: string) => {
      if (n++ === 0) return '[{"id":0,"zh":"這個視頻很棒"},{"id":1,"zh":"一"}]';
      expect(prompt).toContain('視頻');
      return '[{"id":0,"zh":"這支影片很棒"},{"id":1,"zh":"一"}]';
    };
    const r = await translateChunk(llm, meta, [], chunk);
    expect(r.retries).toBe(1);
    expect(r.byId.get(0)?.zh).toBe('這支影片很棒');
  });

  it('fail-fast：簡體輸出視同缺句 → 帶提示重試後過關', async () => {
    let n = 0;
    const llm = async (prompt: string) => {
      if (n++ === 0) return '[{"id":0,"zh":"这是简体输出"},{"id":1,"zh":"一"}]';
      expect(prompt).toContain('品質檢查');
      return '[{"id":0,"zh":"這是繁體輸出"},{"id":1,"zh":"一"}]';
    };
    const r = await translateChunk(llm, meta, [], chunk);
    expect(r.retries).toBe(1);
    expect(r.byId.get(0)?.zh).toBe('這是繁體輸出');
    expect(r.problems).toEqual([]);
  });

  it('崩塌偵測：同句譯文重複 3 次只留第一句，其餘視同缺句', async () => {
    const big = { before: [], target: [sent(0), sent(1), sent(2)], after: [] };
    const llm = async () => '[{"id":0,"zh":"重複的譯文內容"},{"id":1,"zh":"重複的譯文內容"},{"id":2,"zh":"重複的譯文內容"}]';
    const r = await translateChunk(llm, meta, [], big);
    expect(r.byId.size).toBe(1);
    expect(r.problems.join(' ')).toContain('重複');
  });

  it('整包兩次失敗 → 切半分治救回（>10 句才切）', async () => {
    const big = { before: [], target: Array.from({ length: 12 }, (_, i) => sent(i)), after: [] };
    const llm = async (prompt: string) => {
      const ids = [...prompt.matchAll(/^(\d+): /gm)].map((m) => Number(m[1]));
      if (ids.length > 6) return '整包壞掉不是 JSON'; // 大包一律失敗
      return JSON.stringify(ids.map((id) => ({ id, zh: `中${id}` })));
    };
    const r = await translateChunk(llm, meta, [], big);
    expect(r.byId.size).toBe(12); // 兩半各自成功
    expect(r.problems).toEqual([]);
    expect(r.retries).toBeGreaterThan(0);
  });

  it('分治後仍缺 → problems 記載原因', async () => {
    const big = { before: [], target: Array.from({ length: 12 }, (_, i) => sent(i)), after: [] };
    const llm = async () => '永遠壞掉';
    const r = await translateChunk(llm, meta, [], big);
    expect(r.byId.size).toBe(0);
    expect(r.problems.length).toBeGreaterThan(0);
    expect(r.problems.join(' ')).toContain('缺');
  });

  it('多餘的 id 與空 zh 被丟棄（重試補齊）；重複 id 屬對滑徵兆由連號檢查擋', async () => {
    let n = 0;
    const llm = async () =>
      n++ === 0
        ? '[{"id":0,"zh":"零"},{"id":1,"zh":""},{"id":99,"zh":"多的"}]'
        : '[{"id":0,"zh":"零"},{"id":1,"zh":"一"}]';
    const r = await translateChunk(llm, meta, [], chunk);
    expect([...r.byId.keys()].sort()).toEqual([0, 1]);
    expect(r.retries).toBe(1);
  });
});

describe('repairChunk', () => {
  const chunk = { before: [], target: [sent(0, 'when your dealing [music] with rockets'), sent(1, 'ok.')], after: [] };

  it('prompt 帶入原文語言，且明確禁止翻譯成其他語言（日文 ASR 的關鍵防線）', async () => {
    let seen = '';
    await repairChunk(async (p) => { seen = p; return '[{"id":0,"en":"a"},{"id":1,"en":"b"}]'; }, meta, chunk, 'ja');
    expect(seen).toContain('ja');
    expect(seen).toContain('絕對不要翻譯成其他語言');
    expect(seen).not.toContain('正確的英文');
  });

  it('修稿成功：取代原文', async () => {
    const llm = async () => '[{"id":0,"en":"When you\'re dealing with rockets."},{"id":1,"en":"OK."}]';
    const r = await repairChunk(llm, meta, chunk);
    expect(r.byId.get(0)).toBe("When you're dealing with rockets.");
    expect(r.retries).toBe(0);
  });

  it('只回改動句是正常結果，不觸發重試（L2 協定 — 省輸出）', async () => {
    let calls = 0;
    const llm = async () => { calls++; return '[{"id":0,"en":"fixed."}]'; }; // 只有 id 0 需要修
    const r = await repairChunk(llm, meta, chunk);
    expect(calls).toBe(1);       // 不因「少於句數」而重打
    expect(r.retries).toBe(0);
    expect(r.byId.size).toBe(1); // 未回傳的 id 1 由上游沿用原文
  });

  it('全部都不用改（空陣列）也是正常結果', async () => {
    let calls = 0;
    const r = await repairChunk(async () => { calls++; return '[]'; }, meta, chunk);
    expect(calls).toBe(1);
    expect(r.byId.size).toBe(0);
    expect(r.retries).toBe(0);
  });

  it('解析失敗才重打；第二次仍失敗就放行（視為無修改，不擋 pipeline）', async () => {
    let calls = 0;
    const r = await repairChunk(async () => { calls++; return '不是 JSON'; }, meta, chunk);
    expect(calls).toBe(2);
    expect(r.retries).toBe(1);
    expect(r.byId.size).toBe(0);
  });
});

describe('attachGlossaryNotes', () => {
  const mkCues = (): BilingualCue[] => [
    { start: 0, end: 2, en: 'Intro sentence.', zh: '開場。' },
    { start: 2, end: 4, en: 'We added guardrails here.', zh: '我們加了護欄機制（Guardrails）。' },
    { start: 4, end: 6, en: 'More guardrails talk.', zh: '更多 Guardrails 的討論。' },
  ];

  it('術語第一次出現的句子拿到「呈現形式：解釋」格式的註（只一次）', () => {
    const cues = mkCues();
    const added = attachGlossaryNotes(cues, [
      { term: 'guardrails', zh: '護欄機制（Guardrails）', note: '限制 AI 行為範圍的安全機制' },
    ]);
    expect(added).toBe(1);
    expect(cues[1].note).toBe('護欄機制（Guardrails）：限制 AI 行為範圍的安全機制');
    expect(cues[2].note).toBeUndefined();
  });

  it('純中文呈現的術語不需要註；同句可疊多條（既有譯註保留在最上面）', () => {
    const cues = mkCues();
    cues[1].note = '既有譯註';
    const added = attachGlossaryNotes(cues, [
      { term: 'guardrails', zh: '護欄機制（Guardrails）', note: '解釋' },
      { term: 'intro', zh: '開場', note: '不該出現' },
    ]);
    expect(added).toBe(1);
    expect(cues[1].note).toBe('既有譯註\n護欄機制（Guardrails）：解釋');
    expect(cues[0].note).toBeUndefined();
  });

  it('一句最多 3 條註，滿了才退到下一句含該術語處', () => {
    const cues: BilingualCue[] = [
      { start: 0, end: 2, en: 'alpha beta gamma delta here.', zh: '第一句。' },
      { start: 2, end: 4, en: 'delta appears again.', zh: '第二句。' },
    ];
    const added = attachGlossaryNotes(cues, [
      { term: 'alpha', zh: 'Alpha', note: '解釋A' },
      { term: 'beta', zh: 'Beta', note: '解釋B' },
      { term: 'gamma', zh: 'Gamma', note: '解釋C' },
      { term: 'delta', zh: 'Delta', note: '解釋D' }, // 首句已滿 3 條 → 退到第二句
    ]);
    expect(added).toBe(4);
    expect(cues[0].note).toBe('Alpha：解釋A\nBeta：解釋B\nGamma：解釋C');
    expect(cues[1].note).toBe('Delta：解釋D');
  });

  it('term 含多形式（a / b）逐一嘗試', () => {
    const cues = mkCues();
    const added = attachGlossaryNotes(cues, [
      { term: 'harness / guardrails', zh: 'Harness', note: '外部控制框架' },
    ]);
    expect(added).toBe(1);
    expect(cues[1].note).toBe('Harness：外部控制框架');
  });
});

describe('assembleBilingual + toSrt', () => {
  const cues: Cue[] = [
    { start: 1, dur: 2, text: 'hello' },
    { start: 3, dur: 2, text: 'world.' },
    { start: 6, dur: 1.5, text: 'bye.' },
  ];
  const sentences: Sentence[] = [
    { id: 0, text: 'hello world.', cueIds: [0, 1] },
    { id: 1, text: 'bye.', cueIds: [2] },
  ];

  it('句子映回 cue 時間範圍；缺譯 fallback 英文並標記', () => {
    const byId = new Map([[0, { zh: '哈囉世界。', note: undefined }]]);
    const { cues: out, untranslated, bannedHits } = assembleBilingual(sentences, cues, byId);
    expect(out[0]).toMatchObject({ start: 1, end: 5, en: 'hello world.', zh: '哈囉世界。' });
    expect(out[1]).toMatchObject({ start: 6, end: 7.5, zh: 'bye.', untranslated: true });
    expect(untranslated).toBe(1);
    expect(bannedHits).toEqual([]);
  });

  it('組裝階段仍掃描禁用詞（重試後殘留要進 warnings）', () => {
    const byId = new Map([
      [0, { zh: '這視頻不錯' }],
      [1, { zh: '掰' }],
    ]);
    expect(assembleBilingual(sentences, cues, byId).bannedHits).toEqual(['視頻']);
  });

  it('SRT：中上英下、時間格式正確', () => {
    const srt = toSrt([{ start: 1, end: 5, en: 'hello world.', zh: '哈囉世界。' }]);
    expect(srt).toBe('1\n00:00:01,000 --> 00:00:05,000\n哈囉世界。\nhello world.\n');
  });
});

describe('id 連號檢查（批次對滑防線 — gemini-api-lessons §6）', () => {
  const sentences = (n: number): Sentence[] =>
    Array.from({ length: n }, (_, i) => ({ id: i, text: `Sentence number ${i} is here.`, cueIds: [i] }));
  const meta = { title: 't', channel: 'c', description: '' };

  it('輸出 id 重複 → 整包丟掉觸發重試；重試正常則收下', async () => {
    let attempt = 0;
    const llm = async () => {
      attempt++;
      if (attempt === 1) return '[{"id":0,"zh":"甲句翻譯"},{"id":0,"zh":"乙句翻譯"},{"id":2,"zh":"丙句翻譯"}]';
      return '[{"id":0,"zh":"甲句翻譯"},{"id":1,"zh":"乙句翻譯"},{"id":2,"zh":"丙句翻譯"}]';
    };
    const chunk = { before: [], target: sentences(3), after: [] };
    const r = await translateChunk(llm, meta, [], chunk);
    expect(r.byId.size).toBe(3);
    expect(r.retries).toBeGreaterThanOrEqual(1);
  });

  it('輸出 id 亂序 → 同樣丟掉（對滑的徵兆）；修稿 parse 同規則', async () => {
    const badOrder = async () => '[{"id":2,"zh":"丙"},{"id":0,"zh":"甲"},{"id":1,"zh":"乙"}]';
    const chunk = { before: [], target: sentences(3), after: [] };
    const r = await translateChunk(badOrder, meta, [], chunk);
    expect(r.byId.size).toBe(0); // 兩輪都亂序 → 全缺，problems 記錄
    expect(r.problems.join('')).toContain('亂序');

    const badRepair = async () => '[{"id":1,"en":"b"},{"id":0,"en":"a"}]';
    const rr = await repairChunk(badRepair, meta, { before: [], target: sentences(2), after: [] });
    expect(rr.byId.size).toBe(0);
  });
});

describe('L1 補丁式重試（cost-optimization.md — 缺句不重吐整包）', () => {
  const meta2 = { title: 't', channel: 'c', description: 'd' };
  const mk = (n: number) => ({ before: [], target: Array.from({ length: n }, (_, i) => sent(i)), after: [] });

  it('少數缺句 → 第二發只送缺的那幾句（輸入輸出都不重付整包）', async () => {
    const asked: number[][] = [];
    const llm = async (prompt: string) => {
      const ids = [...prompt.matchAll(/^(\d+): /gm)].map((m) => Number(m[1]));
      asked.push(ids);
      // 第一發：20 句只回 18 句（缺 5、11）；第二發：把被問到的都回
      const give = asked.length === 1 ? ids.filter((id) => id !== 5 && id !== 11) : ids;
      return JSON.stringify(give.map((id) => ({ id, zh: `中文${id}。` })));
    };
    const r = await translateChunk(llm, meta2, [], mk(20));
    expect(r.byId.size).toBe(20);
    expect(asked[0].length).toBe(20); // 第一發整包
    expect(asked[1]).toEqual([5, 11]); // 第二發只補缺的兩句 ← 省下的就是這個
    expect(r.retries).toBe(1);
  });

  it('大量缺句（>25%）→ 判定可能是截斷，仍走整包重打', async () => {
    const asked: number[][] = [];
    const llm = async (prompt: string) => {
      const ids = [...prompt.matchAll(/^(\d+): /gm)].map((m) => Number(m[1]));
      asked.push(ids);
      const give = asked.length === 1 ? ids.slice(0, 5) : ids; // 第一發只回 1/4
      return JSON.stringify(give.map((id) => ({ id, zh: `中文${id}。` })));
    };
    const r = await translateChunk(llm, meta2, [], mk(20));
    expect(asked[1].length).toBe(20); // 整包重打，不是補丁
    expect(r.byId.size).toBe(20);
  });

  it('禁用詞只重譯命中的那句；沒改乾淨就保留原譯（不會越修越糟）', async () => {
    const asked: number[][] = [];
    const llm = async (prompt: string) => {
      const ids = [...prompt.matchAll(/^(\d+): /gm)].map((m) => Number(m[1]));
      asked.push(ids);
      if (asked.length === 1) {
        return JSON.stringify(ids.map((id) => ({ id, zh: id === 2 ? '這個視頻很棒' : `中文${id}。` })));
      }
      return JSON.stringify(ids.map((id) => ({ id, zh: '這支影片很棒' })));
    };
    const r = await translateChunk(llm, meta2, [], mk(6));
    expect(asked[1]).toEqual([2]); // 只重譯命中那句
    expect(r.byId.get(2)?.zh).toBe('這支影片很棒');
    expect(r.byId.get(0)?.zh).toBe('中文0。'); // 其他句原封不動

    // 重譯後仍有禁用詞 → 保留原譯（避免用更糟的覆蓋）
    const stubborn = async (prompt: string) => {
      const ids = [...prompt.matchAll(/^(\d+): /gm)].map((m) => Number(m[1]));
      return JSON.stringify(ids.map((id) => ({ id, zh: id === 2 ? '這個視頻很棒' : `中文${id}。` })));
    };
    const r2 = await translateChunk(stubborn, meta2, [], mk(6));
    expect(r2.byId.get(2)?.zh).toBe('這個視頻很棒'); // 沒改乾淨 → 維持，交給組裝階段記 warning
  });
});

describe('F1 回聲對位（t 欄位 — 讓「譯文對到哪句」可驗證）', () => {
  const mk = (n: number) => ({
    before: [],
    // 每句開頭都不同 —— 回聲對位只能分辨「開頭不同」的句子（見 §限制）
    target: Array.from({ length: n }, (_, i) => sent(i, `Number ${i}, this is a distinct sentence.`)),
    after: [],
  });
  const idsOf = (prompt: string) => [...prompt.matchAll(/^(\d+): /gm)].map((m) => Number(m[1]));

  it('echoMismatch：正規化空白/標點/全半形後比對；太短的句子不誤判', () => {
    expect(echoMismatch('I think it is a good idea', 'I think it is')).toBe(false);
    expect(echoMismatch('I think it is a good idea', 'i  think, it is!')).toBe(false); // 標點/空白/大小寫不算
    expect(echoMismatch('ＡＢＣＤＥＦＧＨ', 'abcdefgh')).toBe(false); // 全半形
    expect(echoMismatch('I think it is a good idea', 'But the rocket was')).toBe(true);
    expect(echoMismatch('I think it is a good idea', '')).toBe(true);
    expect(echoMismatch('I think it is a good idea', undefined)).toBe(true);
    expect(echoMismatch('OK.', 'Hm.')).toBe(false); // 3 字元以下判不出來 → 保守放行
  });

  it('prompt 要求 t 欄位並說明用途', async () => {
    let seen = '';
    await translateChunk(
      async (p) => {
        seen = p;
        return JSON.stringify(idsOf(p).map((id) => ({ id, t: `Number 0, thi`, zh: `中文${id}。` })));
      },
      meta,
      [],
      mk(2)
    );
    expect(seen).toContain('"t"');
    expect(seen).toContain('原樣照抄');
  });

  it('對不上的句子被丟掉 → 只補那幾句（沿用 L1 補丁式重試）', async () => {
    const asked: number[][] = [];
    const llm = async (prompt: string) => {
      const ids = idsOf(prompt);
      asked.push(ids);
      return JSON.stringify(
        ids.map((id) => ({
          id,
          // 第一發：#3 的回聲對到別句（模型自認在翻 #7）→ 該句必須被丟掉
          t: asked.length === 1 && id === 3 ? 'Number 7, this is' : `Number ${id}, this is`,
          zh: `中文${id}。`,
        }))
      );
    };
    const r = await translateChunk(llm, meta, [], mk(8));
    expect(asked[1]).toEqual([3]); // 只重譯對不上的那句
    expect(r.byId.size).toBe(8);
    expect(r.echoOff).toBe(false);
  });

  it('模型完全不回 t → 退回只靠 id 的舊行為（不讓整支影片翻不出來），但標記 echoOff', async () => {
    const llm = async (prompt: string) => JSON.stringify(idsOf(prompt).map((id) => ({ id, zh: `中文${id}。` })));
    const r = await translateChunk(llm, meta, [], mk(4));
    expect(r.byId.size).toBe(4);
    expect(r.echoOff).toBe(true);
    expect(r.retries).toBe(0);
  });

  it('只回一部分 t → 沒回的那幾句一律丟（半套協定的輸出不可信）', async () => {
    let n = 0;
    const llm = async (prompt: string) => {
      const ids = idsOf(prompt);
      n++;
      return JSON.stringify(
        ids.map((id) => ({
          id,
          ...(n > 1 || id % 2 === 0 ? { t: `Number ${id}, this is` } : {}),
          zh: `中文${id}。`,
        }))
      );
    };
    const r = await translateChunk(llm, meta, [], mk(4));
    expect(r.byId.size).toBe(4); // 第二發補回來
    expect(r.echoOff).toBe(false);
  });

  it('整批對滑（每句都對到下一句）→ 全部丟掉，不會靜靜地收下通順但錯位的譯文', async () => {
    const llm = async (prompt: string) =>
      JSON.stringify(idsOf(prompt).map((id) => ({ id, t: `Number ${id + 1}, this is`, zh: `中文${id}。` })));
    const r = await translateChunk(llm, meta, [], mk(12));
    expect(r.byId.size).toBe(0);
    expect(r.problems.join('')).toContain('回聲對位不符');
  });
});

describe('F2 位置對齊協定（lite 級模型用，預設不啟用）', () => {
  const mk = (n: number) => ({
    before: [],
    target: Array.from({ length: n }, (_, i) => sent(i, `Number ${i}, this is a distinct sentence.`)),
    after: [],
  });
  const arr = (llm: (p: string) => Promise<string>, n: number) => translateChunk(llm, meta, [], mk(n), 'en', 0, 'array');

  it('prompt 不給 id、要求純字串陣列且長度固定', async () => {
    let seen = '';
    await arr(async (p) => {
      seen = p;
      return JSON.stringify(['甲的譯文', '乙的譯文', '丙的譯文']);
    }, 3);
    expect(seen).toContain('陣列長度必須剛好 3');
    expect(seen).not.toMatch(/^0: /m); // 不再標號
  });

  it('按位置對應譯文', async () => {
    const r = await arr(async () => JSON.stringify(['甲的譯文', '乙的譯文', '丙的譯文']), 3);
    expect(r.byId.get(0)?.zh).toBe('甲的譯文');
    expect(r.byId.get(2)?.zh).toBe('丙的譯文');
    expect(r.echoOff).toBe(false); // 位置對齊本身即對位保證，不需要回聲欄位
  });

  it('長度不符 → 整包丟棄重試（比 id 檢查更硬）', async () => {
    let n = 0;
    const llm = async () => {
      n++;
      // 第一發少一句（模型把兩句合併）→ 整包作廢；第二發長度正確才收
      return n === 1 ? JSON.stringify(['甲的譯文', '乙丙合併的譯文']) : JSON.stringify(['甲的譯文', '乙的譯文', '丙的譯文']);
    };
    const r = await arr(llm, 3);
    expect(n).toBe(2);
    expect(r.byId.size).toBe(3);
    expect(r.byId.get(1)?.zh).toBe('乙的譯文');
  });

  it('長度永遠不符 → 缺句進 problems，不會硬塞錯位的譯文', async () => {
    const r = await arr(async () => JSON.stringify(['只有一句']), 3);
    expect(r.byId.size).toBe(0);
    expect(r.problems.join('')).toContain('位置對齊');
  });

  it('品質地板照舊：簡體/原文照抄那句會被剔除', async () => {
    const r = await arr(async () => JSON.stringify(['甲的譯文', '这是简体输出', '丙的譯文']), 3);
    expect(r.byId.has(1)).toBe(false);
    expect(r.byId.size).toBe(2);
  });
});

describe('子句邊界漂移偵測（僅提示，不是執法）', () => {
  it('長原文配極短譯文會被數出來；正常長度與短原文不誤報', () => {
    const cs: Cue[] = [
      { start: 0, dur: 2, text: 'a' },
      { start: 2, dur: 2, text: 'b' },
      { start: 4, dur: 2, text: 'c' },
    ];
    const ss: Sentence[] = [
      { id: 0, text: 'I think it is a very good option for a', cueIds: [0] }, // 10 字 → 譯文太短
      { id: 1, text: 'this is a completely normal sentence here', cueIds: [1] },
      { id: 2, text: 'OK.', cueIds: [2] }, // 短原文短譯文 = 正常
    ];
    const byId = new Map([
      [0, { zh: '它的' }],
      [1, { zh: '這是一句長度完全正常的譯文。' }],
      [2, { zh: '好。' }],
    ]);
    const r = assembleBilingual(ss, cs, byId);
    expect(r.driftCount).toBe(1);
  });
});
