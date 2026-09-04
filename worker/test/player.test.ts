// Player 頁的內嵌 JS 是「TS 模板字串裡的字串」—— tsc 不會去解析它，
// 所以一個少打的括號可以一路上線、只在瀏覽器裡壞掉。這裡用 new Function 當語法檢查
//（只編譯不執行），順便釘住幾個「壞掉會沒人發現」的 DOM 契約。
import { describe, it, expect } from 'vitest';
import { watchPage, indexPage, adminPage, sharePage } from '../src/player';

// 取出所有沒有 src 的 <script> 內容（有 src 的是 YouTube iframe API，不是我們的碼）
const inlineScripts = (html: string): string[] =>
  [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)].map((m) => m[1]);

const PAGES: Array<[string, string]> = [
  ['watch', watchPage('ksfm6jeTg3Q')],
  ['index', indexPage()],
  ['admin', adminPage()],
  ['share', sharePage()],
];

describe('player 頁面', () => {
  it.each(PAGES)('%s 頁的內嵌 JS 語法正確', (_name, html) => {
    const scripts = inlineScripts(html);
    expect(scripts.length).toBeGreaterThan(0);
    for (const js of scripts) expect(() => new Function(js)).not.toThrow();
  });

  it.each(PAGES)('%s 頁沒有未展開的模板變數', (_name, html) => {
    expect(html).not.toContain('${'); // 忘記跳脫的 ${} 會原封不動出現在頁面上
    expect(html).not.toContain('undefined"');
  });

  // R2a + R3（docs/subtitle-readability.md §4a、§5）
  describe('字幕行數預算', () => {
    const html = watchPage('ksfm6jeTg3Q');

    it('前一句是獨立元素，而且排在字幕帶最上面（roll-up 的視覺語意：舊的在上）', () => {
      expect(html).toMatch(/<div id="subBand"><div id="subPrev"/);
    });

    it('中文一行 16 全形字、原文另給較寬上限（拉丁字母窄，同一個上限會折得太碎）', () => {
      expect(html).toContain('#subZh { max-width: min(92%, 16em); }');
      expect(html).toContain('#subEn { max-width: min(92%, 24em); }');
    });

    it('前一句是三態不是開關 —— 「自動」才有「關掉原文就自然出現」的行為', () => {
      expect(html).toContain('"前一句：自動"');
      expect(html).toContain('"前一句：開"');
      expect(html).toContain('"前一句：關"');
    });

    it('讓步順序寫死在程式裡：砍前一句 → 中文縮一級 → 原文永遠不砍', () => {
      const js = inlineScripts(html).join('\n');
      const body = js.slice(js.indexOf('function layoutBand()'), js.indexOf('// 點前一句'));
      expect(body).toContain('subPrev.textContent = show ?'); // 砍得掉的只有前一句
      expect(body).toContain('classList.add("tight")'); // 再不夠才縮中文
      // **原文與譯註是使用者明確選的，排版讓步時碰都不能碰**
      expect(body).not.toContain('subEn.textContent');
      expect(body).not.toContain('subNote.textContent');
    });

    it('行數用實測而不是拿字數猜（字級、螢幕寬、語言都會影響）', () => {
      expect(inlineScripts(html).join('\n')).toContain('getClientRects()');
    });

    // 瀏覽器實測抓到的第二個 bug：getClientRects() 是「一個文字框一個 rect」，
    // 「食品儲藏室（Pantry）」這種中夾英的句子會在同一行切成好幾個框 ——
    // 直接數 rects 個數會把一行算成兩三行，前一句就被誤判成沒空間
    it('行數按 y 座標分群，不是數 rect 個數（中夾英會在同一行切成多個文字框）', () => {
      const js = inlineScripts(html).join('\n');
      expect(js).not.toContain('getClientRects().length');
      expect(js).toContain('lh * 0.5');
    });

    // 瀏覽器實測抓到的 bug：max-width 是 em，字級縮小的同時「一行裝幾個字」完全不變 ——
    // 縮字級如果沒有搭配放寬 em 上限，就只是把字變小，行數一行都沒少
    it('縮字級一定要搭配放寬 em 上限，否則減不了行數', () => {
      expect(html).toContain('body.tight #subZh { max-width: min(96%, 21em); }');
      expect(html).toContain('body.tight #subEn { max-width: min(96%, 31em); }');
    });
  });
});

// 安全：字幕與 status.json 都是**外部可控**的內容 ——
// 字幕來自任何人都能上傳的 YouTube 影片，status.failReason 會帶模型輸出的開頭。
// 這一組測試釘住「可執行內容」的邊界（docs/privacy-hardening.md §5）
describe('XSS 邊界', () => {
  const html = watchPage('ksfm6jeTg3Q');
  const js = inlineScripts(html).join('\n');

  it('字幕本體一律走 textContent，不進 innerHTML', () => {
    // 逐句稿的骨架是**固定字串**（沒有插值），文字另外用 textContent 填
    expect(js).toContain('d.querySelector(".zh").textContent = c.zh');
    expect(js).toContain('d.querySelector(".en").textContent = c.en');
    expect(js).toContain('subZh.textContent = c.zh');
    expect(js).toContain('d.textContent = c.zh'); // 字卡層
    expect(js).not.toMatch(/innerHTML\s*=[^;]*c\.(zh|en|note)/);
  });

  it('status.json 進 innerHTML 前一定先 escape（模型輸出會走這條路）', () => {
    expect(js).toContain('esc(st.failReason');
    expect(js).toContain('esc(st.stage)');
    expect(js).not.toMatch(/\+\s*\(?st\.failReason\s*\|\|/); // 未 escape 的舊寫法
  });

  // 路由的 regex 已經把 videoId 限死成 11 碼，但 watchPage 是 export 的函式 ——
  // 它不該依賴呼叫端的驗證。JSON.stringify **不會** escape `<`，
  // 所以 videoId 裡的 `</script>` 會直接關掉 script 標籤（縱深防禦，不是現存漏洞）
  it('videoId 插進 <script> 前會把 < 轉義，不靠呼叫端把關', () => {
    const out = watchPage('</script><img src=x onerror=alert(1)>');
    expect(out).not.toContain('</script><img');
    expect(out).toContain('\\u003c/script>');
  });
});
