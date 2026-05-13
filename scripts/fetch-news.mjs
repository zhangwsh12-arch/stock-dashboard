#!/usr/bin/env node
/**
 * 韩国财经新闻自动抓取脚本
 * 
 * 数据来源:
 *   1. Naver Finance 股票新闻页 (需要 CORS 代理或服务器端执行)
 *   2. Google News RSS (公开数据，无 CORS)
 *   3. 韩国经济新闻 RSS
 * 
 * 输出: data/news-content.json (与 content.json 格式兼容)
 * 
 * 用法: node scripts/fetch-news.mjs
 */

import { writeFileSync, readFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = join(__dirname, '..');
const DATA_DIR = join(ROOT_DIR, 'data');
const CONTENT_FILE = join(DATA_DIR, 'content.json');

// 公司配置
const COMPANIES = {
  'Shift Up': { code: '462870', color: '#ff6b9d', keywords: ['Shift Up', 'NIKKE', 'Stellar Blade', ' Evel'] },
  'Nexon': { code: '3659', color: '#22c55e', keywords: ['Nexon', '넥슨', 'Blue Archive'] },
  'Netmarble': { code: '251270', color: '#ef4444', keywords: ['Netmarble', '넷마블', 'Monster Striker'] },
  'NC': { code: '036570', color: '#3b82f6', keywords: ['NC', 'NC소프트', 'NCSoft', 'Aion'] },
  'Krafton': { code: '344760', color: '#f59e0b', keywords: ['Krafton', '크래프톤', 'PUBG'] },
  'Pearl Abyss': { code: '263750', color: '#a855f7', keywords: ['Pearl Abyss', '펄어비스', 'Crimson Desert', 'Black Desert'] },
};

// ============================================================
// 工具函数
// ============================================================

function getCurrentDate() {
  const d = new Date();
  return {
    yyyyMMdd: `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`,
    mmdd: `${String(d.getMonth() + 1).padStart(2, '0')}.${String(d.getDate()).padStart(2, '0')}`,
    display: `${d.getMonth() + 1}月${d.getDate()}日`,
  };
}

function formatDate(dateStr) {
  // 处理 2026-05-12T10:00:00+09:00 格式
  const match = dateStr.match(/(\d{4})-(\d{2})-(\d{2})/);
  if (match) {
    return `${parseInt(match[2])}.${parseInt(match[3])}`;
  }
  // 处理 RFC 822 格式: Mon, 12 May 2026 10:00:00 +0900
  const rfcMatch = dateStr.match(/\d{1,2}\s+(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+\d{4}/i);
  if (rfcMatch) {
    const months = { jan: '01', feb: '02', mar: '03', apr: '04', may: '05', jun: '06', jul: '07', aug: '08', sep: '09', oct: '10', nov: '11', dec: '12' };
    const month = months[rfcMatch[1].toLowerCase()];
    const day = rfcMatch[0].match(/^\d{1,2}/)[0].padStart(2, '0');
    return `${month}.${day}`;
  }
  return '';
}

function detectCompany(title, description = '') {
  const text = (title + ' ' + description).toLowerCase();
  const detected = [];
  
  // 检查排除关键词
  const excludePatterns = ['비트코인', '암호화폐', 'cryptocurrency', '주식', '코인'];
  for (const pattern of excludePatterns) {
    if (text.includes(pattern) && !text.includes('게임')) {
      // 如果包含"股票/加密货币"但不含"游戏"，跳过
    }
  }
  
  for (const [name, config] of Object.entries(COMPANIES)) {
    for (const keyword of config.keywords) {
      if (text.includes(keyword.toLowerCase())) {
        if (!detected.includes(name)) {
          detected.push(name);
        }
        break;
      }
    }
  }
  
  return detected.length > 0 ? detected : ['六大游戏公司'];
}

function cleanText(html) {
  return html
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, ' ')
    .trim();
}

// ============================================================
// 数据源抓取
// ============================================================

async function fetchWithRetry(url, options = {}, retries = 3) {
  const defaultHeaders = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
    'Accept': 'application/rss+xml, application/xml, text/xml, */*',
    'Accept-Language': 'ko-KR,ko;q=0.9,en;q=0.8',
  };

  for (let i = 0; i < retries; i++) {
    try {
      const resp = await fetch(url, { ...options, headers: { ...defaultHeaders, ...options.headers } });
      if (resp.ok) return resp;
      
      if (resp.status !== 429 && resp.status !== 503) {
        throw new Error(`HTTP ${resp.status}`);
      }
      
      await new Promise(r => setTimeout(r, 2000 * (i + 1)));
    } catch (err) {
      if (i === retries - 1) throw err;
      await new Promise(r => setTimeout(r, 1500 * (i + 1)));
    }
  }
}

async function parseXML(xml) {
  // 简单的 XML 解析器（处理 RSS 格式）
  const items = [];
  
  // 提取 <item>...</item> 或 <entry>...</entry>
  const itemMatches = xml.matchAll(/<(?:item|entry)>([\s\S]*?)<\/(?:item|entry)>/gi);
  
  for (const match of itemMatches) {
    const itemContent = match[1];
    
    let title = '', link = '', pubDate = '', description = '', source = '';
    
    const titleMatch = itemContent.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
    if (titleMatch) title = cleanText(titleMatch[1]);
    
    const linkMatch = itemContent.match(/<link[^>]*>([\s\S]*?)<\/link>/i);
    if (linkMatch) link = linkMatch[1].trim();
    
    const dateMatch = itemContent.match(/<(?:pubDate|published|updated)>([\s\S]*?)<\/(?:pubDate|published|updated)>/i);
    if (dateMatch) pubDate = dateMatch[1].trim();
    
    const descMatch = itemContent.match(/<(?:description|summary|content)>([\s\S]*?)<\/(?:description|summary|content)>/i);
    if (descMatch) description = cleanText(descMatch[1]);
    
    const sourceMatch = itemContent.match(/<source[^>]*>([\s\S]*?)<\/source>/i);
    if (sourceMatch) source = cleanText(sourceMatch[1]);
    
    if (title) {
      items.push({ title, link, pubDate, description, source });
    }
  }
  
  return items;
}

async function fetchGoogleNews(company, keywords) {
  console.log(`  📰 [Google] Fetching news for: ${company}`);
  const entries = [];
  
  // Google News RSS (无需 API key)
  const query = encodeURIComponent(keywords.join(' OR '));
  const url = `https://news.google.com/rss/search?q=${query}&hl=ko-KR&gl=KR&ceid=KR:ko`;
  
  try {
    const resp = await fetchWithRetry(url);
    const xml = await resp.text();
    const items = await parseXML(xml);
    
    const dateInfo = getCurrentDate();
    
    for (const item of items.slice(0, 10)) {
      const parsedDate = formatDate(item.pubDate) || dateInfo.mmdd;
      const companies = detectCompany(item.title, item.description);
      
      for (const companyName of companies) {
        entries.push({
          company: companyName,
          color: COMPANIES[companyName]?.color || '#6b7185',
          title: `<strong>${item.title.slice(0, 200)}</strong>`,
          source: item.source || '구글 뉴스',
          date: parsedDate,
          url: item.link || '',
        });
      }
    }
  } catch (err) {
    console.log(`  ⚠️ [Google] Failed: ${err.message}`);
  }
  
  return entries;
}

async function fetchKoreanNewsRSS() {
  console.log(`  📰 [Korean RSS] Fetching Korean economic news...`);
  const entries = [];
  
  // 韩国经济新闻 RSS
  const rssSources = [
    { name: '한국경제', url: 'https://www.hankyung.com/feed/stock' },
    { name: '이데일리', url: 'https://www.edaily.co.kr/feed/sitemap.xml' },
    { name: '머니S', url: 'https://m.money.chosun.com/svc/rss/news_list.htm?type=stock&genre=1' },
  ];
  
  const dateInfo = getCurrentDate();
  
  for (const source of rssSources) {
    try {
      const resp = await fetchWithRetry(source.url);
      const xml = await resp.text();
      const items = await parseXML(xml);
      
      for (const item of items.slice(0, 15)) {
        const parsedDate = formatDate(item.pubDate) || dateInfo.mmdd;
        const companies = detectCompany(item.title, item.description);
        
        // 过滤：只要包含游戏公司关键词的新闻
        if (companies.length > 0 && companies[0] !== '六大游戏公司') {
          for (const companyName of companies) {
            entries.push({
              company: companyName,
              color: COMPANIES[companyName]?.color || '#6b7185',
              title: `<strong>${item.title.slice(0, 200)}</strong>`,
              source: source.name,
              date: parsedDate,
              url: item.link || '',
            });
          }
        }
      }
    } catch (err) {
      console.log(`  ⚠️ [${source.name}] Failed: ${err.message}`);
    }
  }
  
  return entries;
}

async function fetchNaverStockNews() {
  console.log(`  📰 [Naver] Fetching stock news...`);
  const entries = [];
  const dateInfo = getCurrentDate();
  
  // Naver 股票新闻 RSS (部分可用)
  // 注意：Naver 对某些端点有 CORS 限制
  
  for (const [name, config] of Object.entries(COMPANIES)) {
    // 尝试 Naver 搜索 RSS
    const query = encodeURIComponent(name);
    const url = `https://search.naver.com/search.naver?where=rss&fr=rss&ie=utf8&query=${query}%20주식`;
    
    try {
      const resp = await fetchWithRetry(url);
      const xml = await resp.text();
      
      // 从 HTML 中提取 RSS 链接
      const rssMatch = xml.match(/href="(https:\/\/rss\.naver\.com[^"]+)"/);
      if (rssMatch) {
        const rssResp = await fetchWithRetry(rssMatch[1]);
        const rssXml = await rssResp.text();
        const items = await parseXML(rssXml);
        
        for (const item of items.slice(0, 5)) {
          const parsedDate = formatDate(item.pubDate) || dateInfo.mmdd;
          entries.push({
            company: name,
            color: config.color,
            title: `<strong>${cleanText(item.title).slice(0, 200)}</strong>`,
            source: '네이버',
            date: parsedDate,
            url: item.link || '',
          });
        }
      }
    } catch (err) {
      // 静默失败，切换到其他源
    }
    
    // 避免请求过快
    await new Promise(r => setTimeout(r, 500));
  }
  
  return entries;
}

function deduplicate(entries) {
  const seen = new Set();
  const result = [];
  
  for (const entry of entries) {
    const key = `${entry.company}:${cleanText(entry.title).slice(0, 50)}`;
    if (!seen.has(key)) {
      seen.add(key);
      result.push(entry);
    }
  }
  
  return result;
}

// ============================================================
// 主流程
// ============================================================

async function main() {
  console.log('='.repeat(55));
  console.log('📰 韩国财经新闻自动抓取脚本');
  console.log(`🕒 执行时间: ${new Date().toISOString()}`);
  console.log('='.repeat(55));

  const allEntries = [];
  
  // 1. 从 Google News 抓取各公司新闻
  console.log('\n[1/3] 从 Google News 抓取...');
  for (const [name, config] of Object.entries(COMPANIES)) {
    const entries = await fetchGoogleNews(name, config.keywords);
    allEntries.push(...entries);
    await new Promise(r => setTimeout(r, 1000));
  }
  
  // 2. 从韩国经济新闻 RSS 抓取
  console.log('\n[2/3] 从韩国经济新闻 RSS 抓取...');
  const koreanEntries = await fetchKoreanNewsRSS();
  allEntries.push(...koreanEntries);
  
  // 3. 从 Naver 股票新闻抓取
  console.log('\n[3/3] 从 Naver 股票新闻抓取...');
  const naverEntries = await fetchNaverStockNews();
  allEntries.push(...naverEntries);
  
  // 去重
  console.log('\n[处理] 去重...');
  const uniqueEntries = deduplicate(allEntries);
  
  // 按日期排序（最新的在前）
  uniqueEntries.sort((a, b) => b.date.localeCompare(a.date));
  
  console.log(`\n✅ 抓取完成！共获取 ${uniqueEntries.length} 条新闻`);
  
  // 更新 content.json
  let contentData = { events: [], industryNews: [], meta: {} };
  
  if (existsSync(CONTENT_FILE)) {
    try {
      contentData = JSON.parse(readFileSync(CONTENT_FILE, 'utf-8'));
    } catch (err) {
      console.log(`⚠️ 无法读取现有 content.json: ${err.message}`);
    }
  }
  
  // 合并新新闻（保留现有数据，添加新数据）
  const existingDates = new Set(contentData.events.map(e => e.date));
  const newEvents = uniqueEntries.filter(e => !existingDates.has(e.date));
  
  // 只保留最近 7 天的新闻
  const dateInfo = getCurrentDate();
  const recentEvents = newEvents.filter(e => {
    const eventMonth = parseInt(e.date.split('.')[0]);
    const currentMonth = parseInt(dateInfo.mmdd.split('.')[0]);
    return eventMonth === currentMonth;
  });
  
  // 添加到 events 数组（去重合并）
  const allEvents = [...contentData.events];
  for (const event of recentEvents) {
    if (!allEvents.some(e => e.title === event.title && e.company === event.company)) {
      allEvents.unshift(event);
    }
  }
  
  // 限制 events 数组大小（只保留最近 30 条）
  contentData.events = allEvents.slice(0, 30);
  
  // 更新 meta
  contentData.meta = {
    ...contentData.meta,
    newsUpdatedAt: new Date().toISOString(),
    newsCount: contentData.events.length,
    note: '此文件由自动抓取 + 人工维护，每日需同步更新事件和分析文字',
  };
  
  // 写入文件
  writeFileSync(CONTENT_FILE, JSON.stringify(contentData, null, 2), 'utf-8');
  console.log(`\n✅ 新闻数据已更新: ${CONTENT_FILE}`);
  console.log(`   新增 ${recentEvents.length} 条新闻，总计 ${contentData.events.length} 条`);
  
  return contentData;
}

main().catch(err => {
  console.error('❌ 错误:', err);
  process.exit(1);
});