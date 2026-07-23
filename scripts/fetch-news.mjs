#!/usr/bin/env node
/**
 * 韩国游戏行业新闻自动抓取 + AI 翻译脚本
 *
 * 数据源:
 *   1. Google News RSS (韩语新闻搜索)
 *   2. Naver Finance 新闻 RSS
 *
 * 输出: data/content.json 的 events + industryNews 字段（追加模式，不覆盖人工数据）
 *
 * 合并策略（关键设计）:
 *   - content.json 中已有的数据（尤其是人工编写的高质量分析）永不覆盖
 *   - 仅追加抓取到的新日期新闻
 *   - AI 翻译为中文输出，确保 index.html 韩语过滤器不会丢弃
 *
 * 用法: node scripts/fetch-news.mjs
 * 环境变量:
 *   OPENAI_API_KEY - OpenAI API Key（用于翻译，可选；无则跳过翻译输出原文）
 */

import { writeFileSync, readFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = join(__dirname, '..');
const DATA_DIR = join(ROOT_DIR, 'data');
const CONTENT_FILE = join(DATA_DIR, 'content.json');

// 公司配置（用于检测新闻归属）
const COMPANIES = {
  'Shift Up':     { code: '462870', color: '#ff6b9d', keywords: ['Shift Up', 'NIKKE', 'Stellar Blade', '이블', '스텔라이드'] },
  'Nexon':        { code: '3659',   color: '#22c55e', keywords: ['Nexon', '넥슨', 'Blue Archive', '블루아카이브'] },
  'Netmarble':    { code: '251270', color: '#ef4444', keywords: ['Netmarble', '넷마블', 'Monster Striker', '몬스터스트라이커'] },
  // 注意：不能用裸 "NC" 作为关键词——会误命中 "LG-NC"(棒球队)、"First Bancorp NC"(北卡罗来纳州)等无关内容
  'NC':           { code: '036570', color: '#3b82f6', keywords: ['NC소프트', 'NCSoft', '엔씨소프트', '엔씨(NC)', 'Aion', '아이온'] },
  'Krafton':      { code: '344760', color: '#f59e0b', keywords: ['Krafton', '크래프톤', 'PUBG', 'Battlegrounds', '배틀그라운드'] },
  'Pearl Abyss':  { code: '263750', color: '#a855f7', keywords: ['Pearl Abyss', '펄어비스', 'Crimson Desert', 'Black Desert', '검은사막'] },
};

// ============================================================
// 工具函数
// ============================================================

function getCurrentDateKST() {
  // 使用 UTC+9 (韩国时间)
  const now = new Date();
  const kstOffset = 9 * 60 * 60 * 1000;
  const kst = new Date(now.getTime() + kstOffset + (now.getTimezoneOffset() * 60000));
  return {
    yyyyMMdd: `${kst.getUTCFullYear()}${String(kst.getUTCMonth() + 1).padStart(2, '0')}${String(kst.getUTCDate()).padStart(2, '0')}`,
    mmdd: `${String(kst.getUTCMonth() + 1).padStart(2, '0')}.${String(kst.getUTCDate()).padStart(2, '0')}`,
    yyyymmdd_num: kst.getUTCFullYear() * 10000 + (kst.getUTCMonth() + 1) * 100 + kst.getUTCDate(),
  };
}

function formatDate(dateStr) {
  // ISO 格式: 2026-06-30T10:00:00+09:00
  const m = dateStr.match(/(\d{4})-(\d{2})-(\d{2})/);
  if (m) return `${parseInt(m[2])}.${parseInt(m[3])}`;
  // RFC 822: Mon, 30 Jun 2026 10:00:00 +0900
  const rfc = dateStr.match(/\d{1,2}\s+(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+\d{4}/i);
  if (rfc) {
    const months = { jan:'01', feb:'02', mar:'03', apr:'04', may:'05', jun:'06', jul:'07', aug:'08', sep:'09', oct:'10', nov:'11', dec:'12' };
    const mm = months[rfc[1].toLowerCase()];
    const dd = rfc[0].match(/^\d{1,2}/)[0].padStart(2, '0');
    return `${mm}.${dd}`;
  }
  return '';
}

/**
 * 解析新闻发布日期为可比较的 Date 对象（用于时效性过滤）
 * Google News RSS 会返回历史文章（如去年10月），必须过滤掉旧闻，
 * 否则会违反"不能把旧闻当新闻"的规则。
 */
function parseFullDate(dateStr) {
  if (!dateStr) return null;
  const iso = dateStr.match(/(\d{4})-(\d{2})-(\d{2})/);
  if (iso) return new Date(`${iso[1]}-${iso[2]}-${iso[3]}T00:00:00Z`);
  const rfc = dateStr.match(/(\d{1,2})\s+(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+(\d{4})/i);
  if (rfc) {
    const months = { jan:0, feb:1, mar:2, apr:3, may:4, jun:5, jul:6, aug:7, sep:8, oct:9, nov:10, dec:11 };
    return new Date(Date.UTC(parseInt(rfc[3], 10), months[rfc[2].toLowerCase()], parseInt(rfc[1], 10)));
  }
  return null;
}

// 新闻时效性窗口：只保留最近 N 天内发布的新闻，避免旧闻被当作新闻展示
const NEWS_FRESHNESS_DAYS = 14;
function isFreshNews(pubDateStr) {
  const d = parseFullDate(pubDateStr);
  if (!d) return true; // 无法解析日期时不过滤（保留原有行为，避免误删）
  const now = new Date();
  const diffDays = (now.getTime() - d.getTime()) / (1000 * 60 * 60 * 24);
  return diffDays >= -1 && diffDays <= NEWS_FRESHNESS_DAYS; // 允许1天的时区误差
}

function cleanHTML(html) {
  return html
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// 行业综合关键词搜索（如"한국 게임 주식"）范围较宽，Google News 有时会混入完全不相关的内容
// （如体育新闻等只是碰巧命中某个宽泛词）。用游戏/股票相关关键词做二次相关性校验。
const RELEVANCE_KEYWORDS = [
  '게임', 'game', '주식', '股', 'KOSPI', 'KOSDAQ', '코스피', '코스닥',
  'Shift Up', 'NIKKE', 'Stellar Blade', 'Nexon', '넥슨', 'Netmarble', '넷마블',
  'NCSoft', 'NC소프트', 'Aion', '아이온', 'Krafton', '크래프톤', 'PUBG', 'Battlegrounds',
  'Pearl Abyss', '펄어비스', 'Crimson Desert', 'Black Desert', '검은사막',
];
function isRelevantToGaming(title, desc = '') {
  const text = (title + ' ' + desc).toLowerCase();
  return RELEVANCE_KEYWORDS.some(kw => text.includes(kw.toLowerCase()));
}

function detectCompany(title, desc = '') {
  const text = title + ' ' + desc;
  // 优先匹配长关键词（避免短关键词如 "NC" 提前误命中，例如覆盖 Pearl Abyss 的新闻）
  const candidates = [];
  for (const [name, cfg] of Object.entries(COMPANIES)) {
    for (const kw of cfg.keywords) {
      // 短关键词（≤3个字符的纯拉丁字母，如 "NC"）容易在英文单词内部产生子串误匹配
      // （如 "announce"/"France" 都包含 "nc"），必须用词边界严格匹配
      const isShortLatin = /^[A-Za-z]{1,3}$/.test(kw);
      const re = isShortLatin
        ? new RegExp(`\\b${escapeRegExp(kw)}\\b`, 'i')
        : new RegExp(escapeRegExp(kw), 'i');
      if (re.test(text)) {
        candidates.push({ name, len: kw.length });
      }
    }
  }
  if (candidates.length === 0) return null;
  // 取匹配到的最长关键词对应的公司，更可靠（如同时匹配到 "NC" 和 "Crimson Desert" 时优先后者）
  candidates.sort((a, b) => b.len - a.len);
  return candidates[0].name; // 无法匹配任何公司 → 归入 industryNews 而非 events
}

// ============================================================
// AI 翻译（OpenAI API）
// ============================================================

async function translateToChinese(texts) {
  /* texts: string[] — 待翻译的韩语/英语标题数组
     返回: string[] — 翻译后的中文标题数组
     翻译策略（三级降级）：
       1. OPENAI_API_KEY 存在 → AI 翻译（质量最好）
       2. 无 Key → 本地关键词映射替换（免费，基本可读）
  */
  const apiKey = process.env.OPENAI_API_KEY;

  // ===== Level 1: AI 翻译 =====
  if (apiKey) {

  try {
    const resp = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: 'gpt-4o-mini',
        messages: [
          {
            role: 'system',
            content: `你是韩国游戏行业新闻翻译专家。将以下韩语/英语新闻标题翻译为简洁的中文。
规则：
1. 保留公司名原文（如 Shift Up、NC、Krafton、Pearl Abyss、Netmarble、Nexon）
2. 保留游戏名原文（如 NIKKE、Stellar Blade、PUBG、Blue Archive、Aion、Crimson Desert）
3. 保留数字和百分比不变
4. 翻译要简洁有力，适合作为股票看板的新闻摘要
5. 输出格式：每行一条翻译结果，严格按顺序对应输入
6. 不要添加任何前缀、编号或解释`,
          },
          {
            role: 'user',
            content: texts.map((t, i) => `[${i + 1}] ${t}`).join('\n'),
          },
        ],
        temperature: 0.3,
        max_tokens: 2000,
      }),
    });

    if (!resp.ok) {
      console.log(`  ⚠️ OpenAI API 错误: ${resp.status}`);
      return fallbackLocalTranslate(texts);
    }

    const data = await resp.json();
    const translated = data.choices?.[0]?.message?.content || '';
    const lines = translated.split('\n').filter(l => l.trim()).map(l => l.replace(/^\[\d+\]\s*/, '').trim());

    // 确保返回数量一致
    while (lines.length < texts.length) lines.push(texts[lines.length]);
    return lines.slice(0, texts.length);
  } catch (err) {
    console.log(`  ⚠️ AI 翻译失败: ${err.message}, 降级到本地翻译`);
    return fallbackLocalTranslate(texts);
  }

  // ===== Level 2: 本地关键词映射翻译（免费，无需 API Key）======
  } else {
    console.log('  ℹ️ OPENAI_API_KEY 未设置，使用本地关键词映射翻译');
    return fallbackLocalTranslate(texts);
  }
}

/**
 * 免费兜底翻译 —— 用关键词映射将韩语标题转换为中英混合可读格式
 * 目标：生成的文本包含足够多的中文/英文字符以通过 index.html 的韩语过滤器
 */
function fallbackLocalTranslate(texts) {
  // 韩语金融/游戏关键词 → 中文/英文 映射表
  const DICT = [
    // 市场行情
    [/상승/g, '上涨'], [/급등/g, '暴涨'], [/강세/g, '走强'], [/상장/g, '上市'],
    [/하락/g, '下跌'], [/급락/g, '暴跌'], [/약세/g, '走弱'], [/조정/g, '回调'],
    [/반등/g, '反弹'], [/등락/g, '涨跌'], [/변동/g, '波动'], [/보합/g, '平盘'],
    [/사이드카/g, 'Sidecar(熔断)'], [/거래정지/g, '交易暂停'],
    [/기관/g, '机构'], [/외국인/g, '外资'], [/개인/g, '散户'],
    [/순매수/g, '净买入'], [/순매도/g, '净卖出'], [/매수/g, '买入'], [/매도/g, '卖出'],
    [/시가총액/g, '市值'], [/주가/g, '股价'], [/주식/g, '股票'],
    [/KOSPI/g, 'KOSPI'], [/KOSDAQ/g, 'KOSDAQ'], [/코스닥/g, 'KOSDAQ'],
    [/코스피/g, 'KOSPI'], [/사이드카/g, '熔断'],

    // 公司名（保留原文但加中文标记）
    [/Shift Up/gi, 'Shift Up(剑星)'], [/NIKKE/gi, 'NIKKE(胜利女神)'],
    [/Stellar Blade/gi, 'Stellar Blade(剑星)'], [/이블/g, 'Eve(剑星女主)'],
    [/넥슨/g, 'Nexon'], [/넷마블/g, 'Netmarble'], [/NC소프트/g, 'NCsoft'],
    [/크래프톤/g, 'Krafton'], [/펄어비스/g, 'Pearl Abyss'],
    [/PUBG/gi, 'PUBG'], [/배틀그라운드/gi, 'Battlegrounds'],

    // 游戏名
    [/블루아카이브/g, 'Blue Archive(碧蓝档案)'], [/아이온/g, 'Aion(永恒之塔)'],
    [/검은사막/g, 'Black Desert(黑色沙漠)'], [/크림슨데저트/g, 'Crimson Desert(红沙漠)'],
    [/몬스트라이커/g, 'Monster Striker'], [/오리진/g, 'Origin'],

    // 财务指标
    [/실적/g, '业绩'], [/매출/g, '营收'], [/영업이익/g, '营业利润'],
    [/순이익/g, '净利润'], [/전년/g, '同比'], [/전분기/g, '环比'],
    [/역대/g, '历史'], [/최대/g, '最大'], [/최고/g, '最高'], [/최소/g, '最低'],
    [/억원/g, '亿韩元'], [/조원/g, '万亿韩元'],

    // 业务动作
    [/출시/g, '发布'], [/런칭/g, '上线'], [/업데이트/g, '更新'],
    [/협약/g, '合作/签约'], [/인수/g, '收购'], [/투자/g, '投资'],
    [/배당/g, '分红'], [/증자/g, '增资'], [/상장/g, '上市'],
    [/발표/g, '公布/宣布'], [/예정/g, '计划/预计'], [/연기/g, '延期'],

    // 行业词
    [/게임주/g, '游戏股'], [/게임업계/g, '游戏行业'], [/게임相关주/g, '游戏关联股'],
    [/AI|인공지능/g, 'AI(人工智能)'], [/메타버스/g, '元宇宙'],
    [/블록체인/g, '区块链'], [/플랫폼/g, '平台'],
    [/글로벌/g, '全球'], [/해외/g, '海外'], [/중국/g, '中国'], [/일본/g, '日本'],
    [/북미/g, '北美'], [/동남아/g, '东南亚'],

    // 时间
    [/올해/g, '今年'], [/내년/g, '明年'], [/작년/g, '去年'],
    [/분기/g, '季度'], [/1분기/g, 'Q1'], [/2분기/g, 'Q2'], [/3분기/g, 'Q3'], [/4분기/g, 'Q4'],

    // 连接词（替换为空格或标点）—— 注意：必须转义句点，否则 /.../ 会匹配任意3个字符导致乱码
    [/\.\.\./g, '…'], [/~/g, '~'],
  ];

  return texts.map(text => {
    let result = text;
    for (const [pattern, replacement] of DICT) {
      result = result.replace(pattern, replacement);
    }
    // 翻译质量校验：
    // 1) 韩文字符占主导 → 关键词映射不够，翻译失败
    // 2) 英文字符占主导且几乎没有中文 → 本地词典只处理韩语，
    //    纯英文/主要英文的标题（如英文媒体标题）完全没被翻译，
    //    之前的判断漏了这种情况，导致英文原文直接展示（违反"中文展示"要求）
    const korean = (result.match(/[가-힣]/g) || []).length;
    const chinese = (result.match(/[\u4e00-\u9fff]/g) || []).length;
    const english = (result.match(/[a-zA-Z]/g) || []).length;
    if (korean > chinese && korean > 5) {
      return null; // 韩语未译，标记为翻译失败，上层过滤掉
    }
    if (english > 10 && chinese < 3) {
      return null; // 英文未译，标记为翻译失败，上层过滤掉
    }
    return result;
  });
}

// ============================================================
// 数据源抓取
// ============================================================

async function fetchWithRetry(url, opts = {}, retries = 3) {
  const headers = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Accept': 'application/rss+xml, application/xml, text/xml, */*',
    'Accept-Language': 'ko-KR,ko;q=0.9,en;q=0.8',
    ...opts.headers,
  };

  for (let i = 0; i < retries; i++) {
    try {
      const r = await fetch(url, { ...opts, headers });
      if (r.ok) return r;
      if (r.status !== 429 && r.status !== 503) throw new Error(`HTTP ${r.status}`);
      await new Promise(r => setTimeout(r, 2000 * (i + 1)));
    } catch (e) {
      if (i === retries - 1) throw e;
      await new Promise(r => setTimeout(r, 1500 * (i + 1)));
    }
  }
}

function parseRSSXML(xmlText) {
  const items = [];
  const itemMatches = xmlText.matchAll(/<(?:item|entry)>([\s\S]*?)<\/(?:item|entry)>/gi);

  for (const m of itemMatches) {
    const c = m[1];
    const titleM = c.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
    const linkM = c.match(/<link[^>]*>([\s\S]*?)<\/link>/i);
    const dateM = c.match(/<(?:pubDate|published|updated)>([\s\S]*?)<\/(?:pubDate|published|updated)>/i);
    const descM = c.match(/<(?:description|summary|content)[^>]*>([\s\S]*?)<\/(?:description|summary|content)>/i);
    const srcM = c.match(/<source[^>]*>([\s\S]*?)<\/source>/i);

    const title = titleM ? cleanHTML(titleM[1]) : '';
    if (!title) continue;

    items.push({
      title,
      link: linkM ? cleanHTML(linkM[1]).trim() : '',
      pubDate: dateM ? dateM[1].trim() : '',
      description: descM ? cleanHTML(descM[1]).slice(0, 300) : '',
      source: srcM ? cleanHTML(srcM[1]) : '',
    });
  }

  return items;
}

/**
 * Google News RSS 抓取 —— 按公司关键词搜索
 */
async function fetchGoogleNewsForCompany(companyName, keywords) {
  console.log(`  📰 [Google] ${companyName}: ${keywords.slice(0, 2).join(', ')}`);
  const entries = [];

  const query = encodeURIComponent(keywords.join(' OR '));
  const url = `https://news.google.com/rss/search?q=${query}&hl=ko-KR&gl=KR&ceid=KR:ko`;

  try {
    const resp = await fetchWithRetry(url);
    const xml = await resp.text();
    const items = parseRSSXML(xml);
    const dateInfo = getCurrentDateKST();

    let skippedStale = 0;
    for (const item of items) {
      if (!isFreshNews(item.pubDate)) { skippedStale++; continue; } // 过滤旧闻
      entries.push({
        rawTitle: item.title,
        description: item.description,
        source: item.source || 'Google News',
        date: formatDate(item.pubDate) || dateInfo.mmdd,
        url: item.link || '',
      });
      if (entries.length >= 8) break;
    }
    if (skippedStale > 0) console.log(`    ⏭️ 过滤旧闻 ${skippedStale} 条（超过${NEWS_FRESHNESS_DAYS}天）`);
  } catch (err) {
    console.log(`    ⚠️ 失败: ${err.message}`);
  }

  return entries;
}

/**
 * Google News RSS —— 行业综合新闻（韩国游戏板块大盘）
 */
async function fetchGoogleNewsIndustry() {
  console.log(`  📰 [Google] 行业综合: 한국 게임 주식`);
  const entries = [];

  const industryQueries = [
    '한국 게임 주식 OR 게임업계 OR 게임주',
    'KOSPI 게임 OR KOSDAQ 게임 OR 게임 관련주',
  ];

  for (const q of industryQueries) {
    try {
      const url = `https://news.google.com/rss/search?q=${encodeURIComponent(q)}&hl=ko-KR&gl=KR&ceid=KR:ko`;
      const resp = await fetchWithRetry(url);
      const xml = await resp.text();
      const items = parseRSSXML(xml);
      const dateInfo = getCurrentDateKST();

      let count = 0;
      for (const item of items) {
        if (!isFreshNews(item.pubDate)) continue; // 过滤旧闻
        // 宽泛关键词搜索容易混入无关内容（如体育新闻），必须二次校验相关性
        if (!isRelevantToGaming(item.title, item.description)) continue;
        entries.push({
          rawTitle: item.title,
          description: item.description,
          source: item.source || 'Google News',
          date: formatDate(item.pubDate) || dateInfo.mmdd,
          url: item.link || '',
          isIndustry: true,
        });
        count++;
        if (count >= 5) break;
      }
    } catch (err) {
      console.log(`    ⚠️ 行业新闻失败: ${err.message}`);
    }
  }

  return entries;
}

// ============================================================
// 去重
// ============================================================

function deduplicateEntries(entries) {
  const seen = new Set();
  return entries.filter(e => {
    // 用原始标题前60字符去重（避免翻译后重复）
    const key = e.rawTitle.slice(0, 60).toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

// ============================================================
// 主流程
// ============================================================

async function main() {
  console.log('='.repeat(55));
  console.log('📰 韩国游戏行业新闻自动抓取 + AI 翻译');
  console.log(`🕒 KST: ${new Date().toISOString()}`);
  console.log('='.repeat(55));

  const allRawEntries = [];

  // ===== Step 1: 按公司抓取 Google News =====
  console.log('\n[1/3] Google News — 按公司抓取...');
  for (const [name, cfg] of Object.entries(COMPANIES)) {
    const entries = await fetchGoogleNewsForCompany(name, cfg.keywords);
    for (const e of entries) {
      e.detectedCompany = detectCompany(e.rawTitle, e.description);
    }
    allRawEntries.push(...entries);
    await new Promise(r => setTimeout(r, 800)); // 礼貌延迟
  }

  // ===== Step 2: 抓取行业综合新闻 =====
  console.log('\n[2/3] Google News — 行业综合...');
  const industryEntries = await fetchGoogleNewsIndustry();
  allRawEntries.push(...industryEntries);

  // ===== Step 3: 去重 =====
  console.log('\n[处理] 去重...');
  const uniqueEntries = deduplicateEntries(allRawEntries);
  console.log(`   原始: ${allRawEntries.length} 条 → 去重后: ${uniqueEntries.length} 条`);

  if (uniqueEntries.length === 0) {
    console.log('\n⚠️ 未获取到任何新闻，退出');
    return;
  }

  // ===== Step 4: AI 批量翻译 =====
  console.log('\n[处理] AI 翻译中...');
  const titlesToTranslate = uniqueEntries.map(e => e.rawTitle);
  const translatedTitles = await translateToChinese(titlesToTranslate);

  for (let i = 0; i < uniqueEntries.length; i++) {
    uniqueEntries[i].translatedTitle = translatedTitles[i];
  }

  // ===== Step 5: 智能合并到 content.json（关键！不覆盖人工数据）=====
  console.log('\n[处理] 合并到 content.json...');

  let contentData = { events: [], industryNews: [], meta: {}, compareChart: { labels: [], datasets: [] } };

  if (existsSync(CONTENT_FILE)) {
    try {
      contentData = JSON.parse(readFileSync(CONTENT_FILE, 'utf-8'));
      console.log(`   现有 data: events=${contentData.events?.length || 0}, industryNews=${contentData.industryNews?.length || 0}`);
    } catch (err) {
      console.log(`   ⚠️ 读取现有 content.json 失败: ${err.message}，将创建新文件`);
    }
  }

  // 确保 arrays 存在
  if (!Array.isArray(contentData.events)) contentData.events = [];
  if (!Array.isArray(contentData.industryNews)) contentData.industryNews = [];

  const dateInfo = getCurrentDateKST();

  // 收集已存在的日期集合（避免重复添加同日新闻）
  const existingEventKeys = new Set(
    contentData.events.map(e => `${e.date}:${cleanHTML(e.title).slice(0, 40)}`)
  );
  const existingIndustryKeys = new Set(
    contentData.industryNews.map(n => `${n.date}:${cleanHTML(n.title).slice(0, 40)}`)
  );

  let addedEvents = 0;
  let addedIndustry = 0;

  let skippedUntranslated = 0;
  for (const entry of uniqueEntries) {
    // translateToChinese 对翻译质量不达标的条目返回 null，此时不应展示原始韩文
    // （之前用 [원문]/[KR] 标记强行绕过韩语过滤器是错误做法，违反"韩语内容过滤"规则）
    if (entry.translatedTitle == null) {
      skippedUntranslated++;
      continue;
    }
    // 翻译结果等于原文，说明关键词映射没有命中任何替换（无论是韩语还是英文原文均未被翻译）。
    // 此时需要用同 translateToChinese 一致的规则判断是否达标——不能想当然认为"等于原文=已是可展示内容"，
    // 纯英文媒体标题（如英文媒体标题）经过韩语词典处理后也会等于原文，但用户要求全部展示中文。
    if (entry.translatedTitle === entry.rawTitle) {
      const korean = (entry.rawTitle.match(/[가-힣]/g) || []).length;
      const chinese = (entry.rawTitle.match(/[\u4e00-\u9fff]/g) || []).length;
      const english = (entry.rawTitle.match(/[a-zA-Z]/g) || []).length;
      if ((korean > chinese && korean > 5) || (english > 10 && chinese < 3)) {
        skippedUntranslated++;
        continue;
      }
    }
    const displayTitle = `<strong>${entry.translatedTitle}</strong>`;

    const record = {
      company: entry.detectedCompany || '六大游戏公司',
      color: entry.detectedCompany ? COMPANIES[entry.detectedCompany]?.color || '#6b7280' : '#6b7280',
      title: displayTitle,
      source: entry.source,
      date: entry.date,
      url: entry.url || '',
    };

    const key = `${record.date}:${cleanHTML(entry.translatedTitle).slice(0, 40)}`;

    if (entry.isIndustry || !entry.detectedCompany) {
      // → 归入 industryNews
      record.company = '六大游戏公司';
      if (!existingIndustryKeys.has(key)) {
        contentData.industryNews.unshift(record);
        existingIndustryKeys.add(key);
        addedIndustry++;
      }
    } else {
      // → 归入 events（个股新闻）
      if (!existingEventKeys.has(key)) {
        contentData.events.unshift(record);
        existingEventKeys.add(key);
        addedEvents++;
      }
    }
  }

  // 限制数组大小（阈值调高，避免截断人工维护的历史高质量资讯；
  // 当前 events/industryNews 已各有 50~80+ 条人工数据，50 太小会导致误删）
  const MAX_ARRAY_SIZE = 200;
  if (contentData.events.length > MAX_ARRAY_SIZE) {
    console.log(`   ⚠️ events 超过 ${MAX_ARRAY_SIZE} 条 (${contentData.events.length})，裁剪最旧的记录`);
    contentData.events = contentData.events.slice(0, MAX_ARRAY_SIZE);
  }
  if (contentData.industryNews.length > MAX_ARRAY_SIZE) {
    console.log(`   ⚠️ industryNews 超过 ${MAX_ARRAY_SIZE} 条 (${contentData.industryNews.length})，裁剪最旧的记录`);
    contentData.industryNews = contentData.industryNews.slice(0, MAX_ARRAY_SIZE);
  }

  // 更新 meta（注意：不覆写 updatedAt 的人工标记）
  contentData.meta = {
    ...(contentData.meta || {}),
    newsAutoUpdatedAt: new Date().toISOString(),
    newsAutoCount: { events: addedEvents, industryNews: addedIndustry, skippedUntranslated },
    note: '此文件由人工维护 + 自动抓取混合更新。自动抓取内容经中文翻译/关键词映射，翻译质量不达标（韩语字符仍占主导）的条目会被跳过，不展示未翻译原文。',
  };

  // 写回
  writeFileSync(CONTENT_FILE, JSON.stringify(contentData, null, 2), 'utf-8');

  console.log(`\n✅ 更新完成!`);
  console.log(`   新增 events: ${addedEvents} 条 (总计 ${contentData.events.length})`);
  console.log(`   新增 industryNews: ${addedIndustry} 条 (总计 ${contentData.industryNews.length})`);
  console.log(`   文件: ${CONTENT_FILE}`);

  return contentData;
}

main().catch(err => {
  console.error('❌ 致命错误:', err);
  process.exit(1);
});
