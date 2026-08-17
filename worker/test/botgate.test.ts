// 爬蟲閘門（docs/privacy-hardening.md）：UA 分流的判斷邏輯
import { describe, it, expect } from 'vitest';
import { botVerdict } from '../src/index';

describe('botVerdict', () => {
  it('正牌搜尋引擎放行 —— 擋住它們反而讀不到 noindex（robots.txt 陷阱的同一個坑）', () => {
    expect(botVerdict('Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)')).toBe('search-engine');
    expect(botVerdict('Mozilla/5.0 (compatible; bingbot/2.0)')).toBe('search-engine');
    expect(botVerdict('Mozilla/5.0 (compatible; DuckDuckBot-Https/1.1)')).toBe('search-engine');
  });

  it('語料/SEO/通用爬蟲擋下', () => {
    for (const ua of [
      'Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko); compatible; GPTBot/1.2',
      'CCBot/2.0 (https://commoncrawl.org/faq/)',
      'Mozilla/5.0 (compatible; ClaudeBot/1.0)',
      'Mozilla/5.0 (compatible; Bytespider)',
      'Mozilla/5.0 (compatible; AhrefsBot/7.0)',
      'Scrapy/2.11 (+https://scrapy.org)',
      'python-requests/2.32.3',
      'Go-http-client/2.0',
      'HeadlessChrome/125.0.0.0',
    ]) {
      expect(botVerdict(ua), ua).toBe('block');
    }
  });

  it('沒有 UA 一律擋（瀏覽器不會這樣）', () => {
    expect(botVerdict('')).toBe('block');
    expect(botVerdict('   ')).toBe('block');
  });

  it('真人瀏覽器與自家工具放行', () => {
    expect(botVerdict('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/139.0 Safari/537.36')).toBe('allow');
    expect(botVerdict('Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Version/18.0 Mobile/15E148 Safari/604.1')).toBe('allow');
    expect(botVerdict('curl/8.7.1')).toBe('allow'); // 自己 debug 用，不擋
  });
});
