// generate-analysis.mjs
// 韩国游戏股价看板 —— 月度分析文字生成器（量化 + LLM 混合架构）
//
// 设计原则：
//   1) 本地量化层：从 data/2026MMDD.json 历史快照中精确计算月内累计涨跌幅、6 家排名、
//      最佳/最差交易日、与大盘(KOSPI/KOSDAQ)同向/逆势统计、当前价与估值等"100% 准确事实"。
//   2) LLM 叙事层：将上述事实作为"不可更改事实清单"注入 Prompt，由模型只做基于事实的中文
//      叙事（不做任何算术），杜绝数字幻觉。模型默认 DeepSeek-V3（OpenAI 兼容端点，可配置）。
//   3) 护栏：生成后校验输出中的百分比是否均来自事实清单（带容差），含韩文则降级；
//      失败/超时/无密钥时回退到基于事实的规则模板（同样是叙事式，而非逐日罗列）。
//   4) 人工数据保护：仅当目标日期键不存在（或 --force）时才写入；--force 还会迁移同月内
//      仍是"逐日罗列"旧格式的条目。
//
// 触发：仅当当日个股波动 >= STOCK_THRESHOLD 或大盘出现极端波动时才生成，避免无谓写入；
//      渲染端 index.html 会取 <= 当日的最新一条，故平日展示最近一次显著波动日的月度回顾。
//
// 用法：
//   node scripts/generate-analysis.mjs            # 常规：仅当日、按需生成
//   node scripts/generate-analysis.mjs --force    # 强制重算当日并迁移同月旧条目
//
// 数据源：data/latest.json（当日快照）+ data/2026MMDD.json（历史）+ data/content.json（写入 analysis）

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { callLLM, llmConfig } from './llm-client.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const DATA_DIR = path.join(ROOT, 'data');
const LATEST_PATH = path.join(DATA_DIR, 'latest.json');
const CONTENT_PATH = path.join(DATA_DIR, 'content.json');

const STOCK_THRESHOLD = 2.0;       // 个股单日波动阈值(%)，达到才生成
const INDEX_EXTREME = 3.0;         // 大盘单日极端波动阈值(%)
const SU_CODE = '462870';
const SU_NAME = 'Shift Up';
const TRACKED_COMPANY = {
  '225570': 'Nexon Games',
  '251270': 'Netmarble',
  '036570': 'NCsoft',
  '259960': 'Krafton',
  '263750': 'Pearl Abyss',
};

// ---------- 工具函数 ----------

// 把 "32,900" / "+2.65%" / "-3.86%" / "3.05" 转成数字；非法返回 NaN
function parseNum(v) {
  if (v === undefined || v === null) return NaN;
  const s = String(v).replace(/,/g, '').replace(/%/g, '').replace(/\+/g, '').trim();
  if (s === '' || s === '-' || s === '--') return NaN;
  return parseFloat(s);
}

// 把数字格式化为带符号百分比文本，如 +2.65% / -3.86% / 0.00%
function fmtPct(n, digits = 2) {
  if (Number.isNaN(n)) return '0.00%';
  const sign = n > 0 ? '+' : '';
  return `${sign}${n.toFixed(digits)}%`;
}

// 日期字符串(YYYYMMDD) -> "MM.DD"
function mmddOf(dateStr) {
  return `${dateStr.slice(4, 6)}.${dateStr.slice(6, 8)}`;
}

// 读取某日快照（优先 data/YYYYMMDD.json，否则回退 latest）
function readSnapshot(dateStr) {
  const p = path.join(DATA_DIR, `${dateStr}.json`);
  if (fs.existsSync(p)) {
    try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { /* ignore */ }
  }
  return null;
}

// 收集某月（截至 asOfDate，含）内的所有交易日快照，按日期升序
function loadMonthSnapshots(asOfDate) {
  const ym = asOfDate.slice(0, 6);
  const snaps = [];
  if (fs.existsSync(DATA_DIR)) {
    for (const f of fs.readdirSync(DATA_DIR)) {
      const m = f.match(/^(\d{8})\.json$/);
      if (!m) continue;
      const d = m[1];
      if (d.slice(0, 6) === ym && d <= asOfDate) snaps.push(d);
    }
  }
  snaps.sort();
  const list = snaps.map(readSnapshot).filter(Boolean);
  // 确保当日（asOfDate）快照存在：若文件缺失，用 latest 顶替
  const hasToday = snaps.includes(asOfDate);
  if (!hasToday && fs.existsSync(LATEST_PATH)) {
    try {
      const latest = JSON.parse(fs.readFileSync(LATEST_PATH, 'utf8'));
      if (latest?.meta?.date === asOfDate) list.push(latest);
    } catch { /* ignore */ }
  }
  return list;
}

// 从单日快照取某实体的当日涨跌幅(%)
function getStockPct(entity, snap) {
  if (entity.isSU) return parseNum(snap?.shiftUp?.changePercent);
  const c = (snap?.companies || []).find((x) => x.code === entity.code);
  return parseNum(c?.change);
}

// 从单日快照取大盘涨跌幅(%)
function getIndexPct(snap, key) {
  const idx = (snap?.indices || []).find((x) => x.name === key);
  return parseNum(idx?.changePercent);
}

// 连乘每日涨跌幅得到区间累计收益率(%)
function chainReturn(pcts) {
  let prod = 1;
  for (const p of pcts) {
    const n = parseNum(p);
    if (!Number.isNaN(n)) prod *= 1 + n / 100;
  }
  return (prod - 1) * 100;
}

// ---------- 量化层 ----------

function buildEntities() {
  const entities = [{ code: SU_CODE, name: SU_NAME, isSU: true }];
  for (const [code, name] of Object.entries(TRACKED_COMPANY)) {
    entities.push({ code, name, isSU: false });
  }
  return entities;
}

// 为某个"截至日期"构建全部实体的量化事实
function buildQuantContext(asOfDate, monthSnapshots, latest, content) {
  const entities = buildEntities();

  // 大盘月度序列
  const kospiSeries = monthSnapshots.map((s) => ({ date: s.meta.date, pct: getIndexPct(s, 'KOSPI') }));
  const kosdaqSeries = monthSnapshots.map((s) => ({ date: s.meta.date, pct: getIndexPct(s, 'KOSDAQ') }));
  const kospiMtd = chainReturn(kospiSeries.map((x) => x.pct));
  const kosdaqMtd = chainReturn(kosdaqSeries.map((x) => x.pct));
  let extremeDays = 0;
  for (let i = 0; i < kospiSeries.length; i++) {
    const a = kospiSeries[i].pct;
    const b = kosdaqSeries[i].pct;
    if (Math.max(Math.abs(a), Math.abs(b)) >= INDEX_EXTREME) extremeDays++;
  }

  // 各实体月内序列
  const seriesByEntity = {};
  for (const e of entities) {
    seriesByEntity[e.code] = monthSnapshots.map((s) => ({
      date: s.meta.date,
      pct: getStockPct(e, s),
      kospi: getIndexPct(s, 'KOSPI'),
      kosdaq: getIndexPct(s, 'KOSDAQ'),
    })).filter((x) => !Number.isNaN(x.pct));
  }

  // 排名（按月内累计）
  const mtdByCode = {};
  for (const e of entities) mtdByCode[e.code] = chainReturn(seriesByEntity[e.code].map((x) => x.pct));
  const ranked = [...entities].sort((a, b) => mtdByCode[b.code] - mtdByCode[a.code]);

  const facts = {};
  for (const e of entities) {
    const series = seriesByEntity[e.code];
    const mtd = mtdByCode[e.code];
    const rank = ranked.findIndex((x) => x.code === e.code) + 1;

    let best = null;
    let worst = null;
    let up = 0;
    let down = 0;
    let flat = 0;
    let contrarian = 0;
    for (const x of series) {
      if (x.pct > 0) up++;
      else if (x.pct < 0) down++;
      else flat++;
      const idxAvg = (x.kospi + x.kosdaq) / 2;
      if (Math.abs(x.pct) >= STOCK_THRESHOLD && Math.sign(x.pct) !== Math.sign(idxAvg) && idxAvg !== 0) {
        contrarian++;
      }
      if (best === null || x.pct > best.pct) best = { date: x.date, pct: x.pct };
      if (worst === null || x.pct < worst.pct) worst = { date: x.date, pct: x.pct };
    }

    // 当前价 / 估值
    let price = '';
    let per = '';
    if (e.isSU) {
      price = latest?.shiftUp?.price || '';
      per = latest?.shiftUp?.per || '';
    } else {
      const c = (latest?.companies || []).find((x) => x.code === e.code);
      price = c?.price || '';
      per = c?.per || '';
    }

    facts[e.code] = {
      code: e.code,
      name: e.name,
      isSU: e.isSU,
      mtd,
      rank,
      total: entities.length,
      kospiMtd,
      kosdaqMtd,
      best,
      worst,
      up,
      down,
      flat,
      contrarian,
      price,
      per,
      extremeDays,
    };
  }
  return { asOfDate, facts, entities };
}

// ---------- 新闻上下文（按公司聚合整月） ----------

// 新闻条目 company 字段用简称，脚本用全称；做别名归一
const COMPANY_NAME_MAP = {
  'Nexon': 'Nexon Games',
  'Nexon Games': 'Nexon Games',
  'NC': 'NCsoft',
  'NCsoft': 'NCsoft',
  'Netmarble': 'Netmarble',
  'Krafton': 'Krafton',
  'Pearl Abyss': 'Pearl Abyss',
  'Shift Up': 'Shift Up',
};
// 行业/大盘通用标签（无明确公司归属）
const SECTOR_TAGS = new Set(['', '六大游戏公司', '六大', '업계', '전체', '산업', 'Industry', '전체 게임사']);
const EARNINGS_KW = /(财报|실적|분기|Q[1-4]|OP|영업이익|销售额|营收|收益|业绩|赤[字字]|亏[损损]|营利|扭亏)/;

function titleIncludesAlias(title, aliases) {
  return aliases.some((a) => a && title.includes(a));
}

// ---------- 过期信息护栏 ----------
//
// 根因记录（2026-09-11）：Google News 会把旧稿重新分发（或机翻稿沿用旧发售日），
// 抓取脚本按"入库日"打日期，于是 09.08 入库了一条《红色沙漠》"2026年3月19日发售"的旧闻
// （该作 3 月已上市），LLM 便把半年前的档期当成当日催化剂写进驱动因素。
// 规则：标题含档期类动词（发售/定档/上线…）且其中的明确日期比分析日早 30 天以上 -> 判定过期，
// 不进入白名单（既不给 LLM 当素材，也不给规则兜底拼接）。未来日期与近 30 天内日期不受影响。
const SCHEDULE_KW = /(发售|上市|上线|定档|公测|首发|开服|推出|登陆|发布|开业|开启)/;
const STALE_DAYS = 30;

function toUTCDay(y, m, d) {
  return Date.UTC(y, m - 1, d) / 86400000;
}

function isStaleNews(title, asOfDate) {
  if (!asOfDate || !/^\d{8}$/.test(String(asOfDate))) return false;
  const t = String(title || '');
  if (!SCHEDULE_KW.test(t)) return false;
  const asOfY = parseInt(asOfDate.slice(0, 4), 10);
  const asOfDay = toUTCDay(asOfY, parseInt(asOfDate.slice(4, 6), 10), parseInt(asOfDate.slice(6, 8), 10));
  const dates = [];
  for (const m of t.matchAll(/(20\d{2})\s*年\s*(\d{1,2})\s*月\s*(\d{1,2})\s*日/g)) {
    dates.push(toUTCDay(+m[1], +m[2], +m[3]));
  }
  for (const m of t.matchAll(/(?:^|[^\d年])(\d{1,2})\s*月\s*(\d{1,2})\s*日/g)) {
    dates.push(toUTCDay(asOfY, +m[1], +m[2]));   // 无年份 -> 按分析日所在年推断
  }
  if (!dates.length) return false;
  // 只要存在"未来或近 30 天内"的档期，就认为标题仍有时效性；全部都是远期过往才判过期
  return dates.every((d) => asOfDay - d > STALE_DAYS);
}

// 聚合某公司在"截至日所在月份、月初→截至日"的全部相关新闻
// 返回 { company:[{date,title}], sector:[{date,title}] }
function getMonthNews(content, canonicalName, asOfMmdd, asOfDate) {
  const asOfMM = asOfMmdd.slice(0, 2);
  const asOfDD = asOfMmdd.slice(3, 5);
  const aliases = [canonicalName, ...Object.keys(COMPANY_NAME_MAP).filter((k) => COMPANY_NAME_MAP[k] === canonicalName)];
  const companyNews = [];
  const sectorNews = [];
  const pools = [content?.events || [], content?.industryNews || []];
  for (const pool of pools) {
    for (const e of pool) {
      const date = String(e?.date || '').trim();
      const m = date.match(/^(\d{2})\.(\d{2})$/);
      if (!m) continue;
      if (m[1] !== asOfMM) continue;      // 仅同月（催化剂时效性）
      if (m[2] > asOfDD) continue;        // 仅截至日及之前
      const rawCompany = e?.company || e?.target || '';
      const title = String(e.title || '').replace(/<[^>]+>/g, '').trim();
      if (!title) continue;
      if (isStaleNews(title, asOfDate)) continue;  // 过期档期旧稿 -> 不做素材
      const resolved = COMPANY_NAME_MAP[rawCompany] || rawCompany;
      // 明确归属其他公司 -> 跳过（避免串味）
      if (rawCompany && COMPANY_NAME_MAP[rawCompany] && COMPANY_NAME_MAP[rawCompany] !== canonicalName) continue;
      if (resolved === canonicalName || titleIncludesAlias(title, [canonicalName])) {
        if (companyNews.length < 6) companyNews.push({ date, title });
      } else if (!rawCompany || SECTOR_TAGS.has(rawCompany)) {
        if (sectorNews.length < 3) sectorNews.push({ date, title });
      } else {
        // 未知公司标签且无专属命中 -> 视为行业/宏观通用
        if (sectorNews.length < 3) sectorNews.push({ date, title });
      }
    }
  }
  companyNews.sort((a, b) => a.date.localeCompare(b.date));
  sectorNews.sort((a, b) => a.date.localeCompare(b.date));
  return { company: companyNews, sector: sectorNews };
}

function hasEarningsNews(news) {
  return [...(news.company || []), ...(news.sector || [])].some((n) => EARNINGS_KW.test(n.title));
}

// ---------- 事实清单文本（供 Prompt 与护栏使用） ----------

function buildFactsSheet(fact, news) {
  const lines = [];
  lines.push(`公司/标的：${fact.name}`);
  lines.push(`截至日期：${fact.asOfDate ? fact.asOfDate : ''}`);
  lines.push(`大盘月内表现（背景）：KOSPI ${fmtPct(fact.kospiMtd)}，KOSDAQ ${fmtPct(fact.kosdaqMtd)}`);
  const dir = fact.mtd > 0 ? '上涨' : fact.mtd < 0 ? '下跌' : '持平';
  lines.push(`月内整体方向：${dir}（具体幅度界面已展示，请勿复述数字）`);
  const cNews = news.company || [];
  const sNews = news.sector || [];
  if (cNews.length) {
    lines.push(`本月该公司相关新闻/事件（按时间，仅可引用这些，不得自创）：`);
    for (const n of cNews) lines.push(`- [${n.date}] ${n.title}`);
  } else {
    lines.push(`（本月无该公司专属新闻，仅可基于行情背景分析，不得编造具体事件）`);
  }
  if (sNews.length) {
    lines.push(`本月行业/大盘通用动向（背景，可酌情引用）：`);
    for (const n of sNews) lines.push(`- [${n.date}] ${n.title}`);
  }
  if (hasEarningsNews(news)) lines.push(`（注：本月含财报相关动向，是重要主线，请纳入因果链）`);
  lines.push(`（严禁引入上述白名单外的任何事实或数字）`);
  return lines.join('\n');
}

function rankWordOf(rank, total) {
  if (rank === 1) return '领先';
  if (rank <= 2) return '靠前';
  if (rank === total) return '垫底';
  if (rank >= total - 1) return '靠后';
  return '居中';
}

function marketContrastText(fact) {
  const diff = fact.mtd - fact.kospiMtd;
  if (diff >= 3) return `显著跑赢大盘(KOSPI ${fmtPct(fact.kospiMtd)})`;
  if (diff <= -3) return `明显跑输大盘(KOSPI ${fmtPct(fact.kospiMtd)})`;
  return `与大盘基本同步(KOSPI ${fmtPct(fact.kospiMtd)})`;
}

// 提取事实中所有百分比数值（供护栏容差比对）
function factsPctValues(sheet) {
  const nums = [...sheet.matchAll(/[+-]?\d+(?:\.\d+)?%/g)].map((m) => parseNum(m[0]));
  return nums.filter((n) => !Number.isNaN(n));
}

// ---------- LLM 叙事 ----------

const SYSTEM_PROMPT = `你是一名严谨的韩国游戏股二级市场分析师。你的任务：基于用户提供的"已核实事实清单"（含该公司整月的相关新闻/事件白名单），为某只韩国游戏股撰写一段中文【原因分析】，用于展示在股价看板上。

硬性规则：
1. 只做原因分析：解释"为什么涨/跌"，围绕事件、催化剂、新闻驱动展开因果链条。禁止写：公司间排名、PER/估值、最佳日↔最差日对比、"上涨X天下跌X天"等趋势性数据罗列。
2. 必须基于"本月该公司相关新闻/事件"白名单展开；若该公司有专属新闻，应以这些真实事件为主因，严禁套用与其他公司雷同的通用行业套话（例如不要把"议长访 Gamescom""某同业海外营收破50%"这类通用议程，当成每一家公司的主因）。
3. 所有事实（数字与事件）只能来自"已核实事实清单"与白名单。严禁引入清单外知识或自行编造，清单外的任何断言一律不得出现。
4. 不要复述"本月累计X%"等已在界面单独展示的数字，聚焦驱动逻辑本身。
5. 用 <strong> 标签标注关键数字（如 <strong>+2.65%</strong>）。
6. 语言：简体中文，80~150 字，专业、克制、有洞察，不要口号式抒情。
7. 不要出现韩文。`;

// 单日驱动因素系统提示（用于 analysis.daily 生成）
const DAILY_SYSTEM_PROMPT = `你是一名严谨的韩国游戏股二级市场分析师。你的任务：基于用户提供的"已核实事实清单"（含该公司当日及近3日相关新闻/事件白名单），为某只韩国游戏股撰写一句中文【单日驱动因素】，用于股价看板"今日总结"板块的单行展示。

硬性规则：
1. 只解释"为什么这一天涨/跌"，围绕当日/近三日新闻、催化剂展开因果链条。禁止写：公司间排名、PER/估值、最佳日↔最差日对比、"上涨X天下跌X天"等趋势性数据罗列。
2. 必须基于"当日及近3日相关新闻/事件"白名单展开；若该公司有专属新闻，应以这些真实事件为主因，严禁套用与其他公司雷同的通用行业套话。
3. 所有事实（数字与事件）只能来自"已核实事实清单"与白名单。严禁引入清单外知识或自行编造。
4. 不要写"本月累计"等字眼；不要复述已在界面单独展示的当日涨跌幅数字，聚焦驱动逻辑本身。
5. 不要以公司名开头（公司名已在界面单独显示）；直接写驱动逻辑，如"受XX事件提振…"。
6. 用 <strong> 标签标注关键数字（如 <strong>+2.65%</strong>）。
7. 语言：简体中文，40~80 字，专业、克制、有洞察，一句到位，不要标题，不要口号式抒情。
8. 不要出现韩文。`;

function buildUserPrompt(fact, news, isSU) {
  const sheet = buildFactsSheet(fact, news);
  return `【已核实事实清单】
${sheet}

【写作要求】
- 为 ${fact.name} 写一段本月（截至 ${fact.asOfDate}）的【原因分析】，只解释"为什么涨/跌"，形成因果链条。
- 必须以"本月该公司相关新闻/事件"为主素材构建因果；若该公司有专属新闻，就以这些真实事件为主因，不要写与其他公司雷同的通用行业套话。若该公司确无专属新闻，才可基于行业/大盘通用动向与行情方向说明，但仍不得编造具体事件。
- 严禁写：公司间排名、PER/估值、最佳↔最差交易日对比、"上涨X天下跌X天"等趋势性数据罗列；不要复述"本月累计X%"等界面已展示的数字。
- 所有事实断言必须来自上面的白名单，不得自行编造或引入外部知识。
- 用 <strong> 标签标注关键数字。
- 仅输出分析正文（不要标题），可直接嵌入看板。`;
}

// 允许提及的事实来源：相关新闻/事件标题 + 公司/市场专名 + 同月所有已知日期（MM.DD 与 中文月日 双形态）
function buildAllowedFacts(fact, news) {
  const names = [SU_NAME, ...Object.values(TRACKED_COMPANY)];
  const items = [...(news.company || []), ...(news.sector || [])];
  const titles = items.map((n) => n.title);
  const dates = items.map((n) => n.date);                     // "08.24"
  const datesZh = items.map((n) => {                          // "8月24日"
    const [mm, dd] = n.date.split('.');
    return `${parseInt(mm, 10)}月${parseInt(dd, 10)}日`;
  });
  const extra = ['KOSPI', 'KOSDAQ', 'Gamescom', 'TGS', 'Q2', '财报', '第二季度', '二季度', 'Stellar Blade', '剑星', 'Blue Archive', 'Pareidolia', 'Crimson Desert', 'Aion', 'Wemade', '金泽辰', 'NC'];
  const flat = [...new Set([...titles, ...names, ...dates, ...datesZh, ...extra])]
    .filter(Boolean).map((s) => String(s).replace(/<[^>]+>/g, ''));
  return { flat, tokens: extractTokens(titles), dates: [...new Set([...dates, ...datesZh])], names };
}

// 从白名单标题中抽取"专名级"片段（作品名、引号内短语、拉丁词、较长中文词组），
// 用于护栏锚定：LLM 改写后不会逐字复述整条标题，但通常会保留这些专名。
function extractTokens(titles) {
  const tokens = new Set();
  for (const raw of titles) {
    const t = cleanNewsTitle(raw);
    for (const m of t.matchAll(/《([^》]{2,})》/g)) tokens.add(m[1]);
    for (const m of t.matchAll(/[“"'‘]([^”"'’]{2,})[”"'’]/g)) tokens.add(m[1]);
    for (const m of t.matchAll(/[A-Za-z][A-Za-z0-9]{2,}(?:\s+[A-Za-z0-9]{2,})?/g)) tokens.add(m[0]);
    for (const seg of t.split(/[^\u4e00-\u9fffA-Za-z0-9]+/)) {
      const cjk = seg.replace(/[^\u4e00-\u9fff]/g, '');
      if (cjk.length >= 4) tokens.add(cjk);
    }
  }
  return [...tokens].filter((x) => x && x.length >= 3);
}

// 事件动词：带这些动词的句子视为"具体事实断言"
// 注意：不要用 `获[批得]?` 这类会退化成单字 "获" 的写法——"获利了结" 是行情描述而非事实断言，
// 之前因此被误判为断言句，进而把合格的 LLM 输出打回规则兜底（2026-09-11 Krafton 残句即源于此）。
const CLAIM_VERBS = /(突破|创[新历]高|首次|官宣|宣布|获批|获得|获评|获奖|获颁|签约|签署|上线|发布|上市|合作|达成|增至|降至|提升至|超越|被[收并购])/;

// 护栏：① 百分比须源自事实清单；② 含韩文降级；③ 具体事实断言须被白名单锚定
//    （命中标题片段 / 标题中的专名 token / "已知日期+公司名" 任一即可放行）
function hasHallucination(text, sheet, facts) {
  const factsPcts = factsPctValues(sheet);
  const used = [...text.matchAll(/[+-]?\d+(?:\.\d+)?%/g)].map((m) => parseNum(m[0]));
  for (const u of used) {
    if (Number.isNaN(u)) continue;
    const ok = factsPcts.some((f) => Math.abs(f - u) <= 0.3);
    if (!ok) return true; // 出现清单外百分比 -> 疑似幻觉
  }
  if (/[가-힣]/u.test(text)) return true; // 含韩文 -> 降级

  // 事件断言校验：要求"白名单片段/专名" 或 "已知日期 + 公司名" 锚定，避免误杀真实改写，也拦截凭空捏造
  if (facts && facts.flat && facts.flat.length) {
    const dateRe = /\d{1,2}月\d{1,2}日|\d{2}\.\d{2}/;
    const sentences = text.split(/[。；;]/).map((s) => s.trim()).filter(Boolean);
    for (const s of sentences) {
      if (!CLAIM_VERBS.test(s)) continue; // 仅检查具体事实断言句
      if (facts.flat.some((a) => a && s.includes(a))) continue; // 命中白名单片段 -> 放行
      if ((facts.tokens || []).some((a) => a && s.includes(a))) continue; // 命中标题专名 -> 放行
      const dMatch = s.match(dateRe);
      const dOk = dMatch && facts.dates.includes(dMatch[0]);
      const nOk = facts.names.some((n) => n && s.includes(n));
      if (dOk && nOk) continue; // 含已知日期且锚定公司 -> 视为真实改写，放行
      return true; // 既无白名单锚点、又缺日期/公司锚定 -> 疑似凭空捏造
    }
  }
  return false;
}

// 规则模板兜底（纯因果，不写排名/PER/趋势罗列）
//
// 根因记录（2026-09-09）：原版本把 news.company（该公司专属新闻）与 news.sector
// （行业/大盘通用新闻，可能来自其它公司或与任何公司都无关的通用报道）无差别拼在
// 一起，统一贴上"相关动向："标签。这会导致"该公司本月本无专属新闻"时，误把毫不
// 相关的行业新闻（甚至是另一家被追踪公司的专属新闻，例如 Netmarble 的人才培养计划
// 被错误地当成 Nexon Games 的"相关动向"）当作该公司自身的事件描述，产生张冠李戴的
// 分析文案。修复：company/sector 分开处理，sector-only 时改用不做归因的行业背景表述，
// 不再用"相关动向"暗示这是该公司自身的新闻。
function ruleFallback(fact, news, isSU) {
  const dir = fact.mtd > 0 ? '上行' : fact.mtd < 0 ? '下行' : '盘整';
  // 仅保留含中文字符的标题，避免把英文新闻原文直接拼进文案
  const hasCJK = (t) => /[가-힣一-鿿]/.test(t);
  const cNews = (news.company || []).map((n) => n.title).filter(hasCJK);
  const sNews = (news.sector || []).map((n) => n.title).filter(hasCJK);

  if (cNews.length) {
    const top = cNews.slice(0, 2).join('；');
    return `<strong>${fact.name}</strong>本月整体${dir}，相关动向：${top}。`;
  }
  if (sNews.length) {
    const top = sNews.slice(0, 1).join('；');
    return `<strong>${fact.name}</strong>本月无专属事件，${dir}主要受行业与大盘氛围驱动（行业背景：${top}）。`;
  }
  return `<strong>${fact.name}</strong>本月整体${dir}，与板块及大盘氛围相关，未见明确独立催化。`;
}

// 为单个实体生成分析文本（LLM 优先，含白名单校验与一次重试，失败回退规则）
async function generateEntityText(fact, news, isSU) {
  const sheet = buildFactsSheet(fact, news);
  const allowedFacts = buildAllowedFacts(fact, news);
  const userPrompt = buildUserPrompt(fact, news, isSU);
  try {
    let raw = await callLLM({
      systemPrompt: SYSTEM_PROMPT,
      userPrompt,
      temperature: 0.35,
      maxTokens: 400,
    });
    let text = raw.replace(/^```(?:json|html)?|```$/g, '').trim();
    if (!text) throw new Error('空回复');
    if (hasHallucination(text, sheet, allowedFacts)) {
      console.warn(`  ↳ ${fact.name} 首次输出疑似含白名单外事实，重试一次`);
      raw = await callLLM({
        systemPrompt: SYSTEM_PROMPT + '\n【警告】上次回答含有白名单外的事实断言。必须严格只使用"允许提及的事实白名单"中的内容，不得添加任何清单外信息。',
        userPrompt,
        temperature: 0.3,
        maxTokens: 400,
      });
      text = raw.replace(/^```(?:json|html)?|```$/g, '').trim();
      if (hasHallucination(text, sheet, allowedFacts)) {
        console.warn(`  ↳ ${fact.name} 重试后仍疑似含白名单外事实，回退规则模板`);
        return ruleFallback(fact, news, isSU);
      }
    }
    return text;
  } catch (err) {
    console.warn(`  ↳ ${fact.name} LLM 调用失败(${err.message})，使用规则模板`);
    return ruleFallback(fact, news, isSU);
  }
}

// 为某个截至日期生成全部实体文本（entityFilter 可选：仅重算指定 code，如 'su' 或 '036570'，
// 用于单独修复某一家的异常分析而不触动其余已生成好的实体，如 2026-08-31 NC 曾因幻觉护栏
// 连续两次拒绝 LLM 输出、回退到规则模板拼接原始新闻标题的degraded case）
async function generateAll(asOfDate, content, entityFilter) {
  const monthSnapshots = loadMonthSnapshots(asOfDate);
  const latest = readSnapshot(asOfDate) || (fs.existsSync(LATEST_PATH) ? JSON.parse(fs.readFileSync(LATEST_PATH, 'utf8')) : null);
  const { facts, entities } = buildQuantContext(asOfDate, monthSnapshots, latest, content);
  const result = { su: null, companies: {} };
  for (const e of entities) {
    if (entityFilter && (e.isSU ? 'su' : e.code) !== entityFilter) continue;
    const fact = { ...facts[e.code], asOfDate };
    const news = getMonthNews(content, e.name, mmddOf(asOfDate), asOfDate);
    const text = await generateEntityText(fact, news, e.isSU);
    if (e.isSU) result.su = text;
    else result.companies[e.code] = text;
  }
  return result;
}

// ---------- 单日生成分支（写入 analysis.daily[code][date]，与月度并行） ----------

// 单日新闻窗口：当日及前 3 日（保证时效性，避免把整月事件混入当日解释）
function getDayNews(content, canonicalName, asOfMmdd, asOfDate) {
  const asOfMM = asOfMmdd.slice(0, 2);
  const asOfDD = parseInt(asOfMmdd.slice(3, 5), 10);
  const companyNews = [];
  const sectorNews = [];
  const pools = [content?.events || [], content?.industryNews || []];
  for (const pool of pools) {
    for (const e of pool) {
      const date = String(e?.date || '').trim();
      const m = date.match(/^(\d{2})\.(\d{2})$/);
      if (!m) continue;
      if (m[1] !== asOfMM) continue;
      const dd = parseInt(m[2], 10);
      if (dd > asOfDD) continue;
      if (asOfDD - dd > 3) continue; // 仅当日及前3日
      const rawCompany = e?.company || e?.target || '';
      const title = String(e.title || '').replace(/<[^>]+>/g, '').trim();
      if (!title) continue;
      if (isStaleNews(title, asOfDate)) continue;  // 过期档期旧稿 -> 不做素材
      const resolved = COMPANY_NAME_MAP[rawCompany] || rawCompany;
      if (rawCompany && COMPANY_NAME_MAP[rawCompany] && COMPANY_NAME_MAP[rawCompany] !== canonicalName) continue;
      if (resolved === canonicalName || titleIncludesAlias(title, [canonicalName])) {
        if (companyNews.length < 6) companyNews.push({ date, title });
      } else if (!rawCompany || SECTOR_TAGS.has(rawCompany)) {
        if (sectorNews.length < 3) sectorNews.push({ date, title });
      } else {
        if (sectorNews.length < 3) sectorNews.push({ date, title });
      }
    }
  }
  companyNews.sort((a, b) => a.date.localeCompare(b.date));
  sectorNews.sort((a, b) => a.date.localeCompare(b.date));
  return { company: companyNews, sector: sectorNews };
}

function buildDailyFactsSheet(fact, news, dailyPct) {
  const lines = [];
  lines.push(`公司/标的：${fact.name}`);
  lines.push(`日期：${fact.asOfDate}`);
  const dir = Number.isNaN(dailyPct) ? '（数据缺失）' : (dailyPct > 0 ? '上涨' : dailyPct < 0 ? '下跌' : '持平');
  lines.push(`当日涨跌幅：${Number.isNaN(dailyPct) ? '数据缺失' : fmtPct(dailyPct)}（${dir}）`);
  lines.push(`（严禁引入白名单外的任何事实或数字；不要复述已在界面展示的当日涨跌幅）`);
  const cNews = news.company || [];
  const sNews = news.sector || [];
  if (cNews.length) {
    lines.push(`该公司当日及近3日相关新闻/事件（按时间，仅可引用这些，不得自创）：`);
    for (const n of cNews) lines.push(`- [${n.date}] ${n.title}`);
  } else {
    lines.push(`（当日及近3日无该公司专属新闻，仅可基于行情背景与行业通用动向分析，不得编造具体事件）`);
  }
  if (sNews.length) {
    lines.push(`行业/大盘通用动向（背景，可酌情引用）：`);
    for (const n of sNews) lines.push(`- [${n.date}] ${n.title}`);
  }
  if (hasEarningsNews(news)) lines.push(`（注：含财报相关动向，是重要主线，请纳入因果链）`);
  lines.push(`（严禁引入上述白名单外的任何事实或数字）`);
  return lines.join('\n');
}

function buildDailyUserPrompt(fact, news, dailyPct) {
  const sheet = buildDailyFactsSheet(fact, news, dailyPct);
  return `【已核实事实清单】
${sheet}

【写作要求】
- 为 ${fact.name} 在 ${fact.asOfDate} 这一天写一句【单日驱动因素】，只解释"为什么这一天涨/跌"，形成因果链条。
- 【方向一致性硬约束】因果必须与当日涨跌方向严格一致：当日下跌时，所列事件必须是下跌的合理解释（利空事件 / 利好兑现后的获利了结 / 大盘或板块系统性拖累）；严禁用纯利好事件直接当作下跌原因，除非明确表述为"利好不敌系统性抛压 / 获利了结"。当日上涨同理，不得用利空事件直接解释上涨。如当日仅有利好新闻却仍下跌，应表述为"利好未能抵挡板块/大盘回调"，而非"受利好影响下跌"。
- 必须以"当日及近3日相关新闻/事件"为主素材构建因果；若该公司有专属新闻，就以这些真实事件为主因，不要写与其他公司雷同的通用行业套话。若确无专属新闻，才可基于行业/大盘通用动向与行情方向说明，但仍不得编造具体事件。
- 严禁写：公司间排名、PER/估值、最佳↔最差交易日对比、"上涨X天下跌X天"等趋势性数据罗列；不要写"本月累计"等字眼，不要复述界面已展示的当日涨跌幅。
- 不要以公司名开头（公司名已在界面单独显示）；直接写驱动逻辑，如"受XX事件提振…"。
- 所有事实断言必须来自上面的白名单，不得自行编造或引入外部知识。
- 用 <strong> 标签标注关键数字。
- 仅输出分析正文（不要标题），可直接嵌入看板。`;
}

// 轻量情感分类：用于规则兜底时判断新闻偏多/偏空，避免“利好被当成下跌原因”的逻辑矛盾
function classifySentiment(title) {
  const neg = ['下跌','抛售','减持','下调','延迟','推迟','取消','承压','下滑','亏损','诉讼','调查','处罚','警告','降级','做空','崩盘','暴跌','回落','利空','不及预期','裁员','终止','失败','暂停','流出','赎回','缩水','腰斩','破发','套牢','踩雷','推迟','推迟上映'];
  const pos = ['公开','上线','亮相','首发','提名','获奖','入围','利好','提振','增长','创新高','突破','合作','签约','加码','加价','关注','支持','预期','订单','扭亏','超预期','扩张','发布','定名','试玩','预告','续作','新版','更新','免费','上调','回购','中标','获批','放量','大涨','走强','反弹','加码','看好','红利'];
  let p = 0, n = 0;
  for (const w of pos) if (title.includes(w)) p++;
  for (const w of neg) if (title.includes(w)) n++;
  if (n > p) return -1;
  if (p > n) return 1;
  return 0;
}
// 韩媒标题清洗：去掉 [栏目]/【独家】 前缀与 <strong> 等标签
function cleanNewsTitle(t) {
  return String(t || '')
    .replace(/<[^>]+>/g, '')
    .replace(/^\s*[[【(（][^\]】)）]{0,14}[\]】)）]\s*/, '')
    .trim();
}

// 收尾清理：去掉悬空标点，并截掉未闭合的书名号/引号/括号片段，避免 "《红色沙漠" 之类残句
function tidyTail(s) {
  let out = String(s || '').replace(/[\s，,、·:：;；\-–—…‥(（[【《“‘]+$/g, '');
  const pairs = [['《', '》'], ['（', '）'], ['(', ')'], ['“', '”'], ['‘', '’'], ['[', ']'], ['【', '】']];
  for (const [open, close] of pairs) {
    const o = out.lastIndexOf(open);
    if (o >= 0 && out.indexOf(close, o) < 0) {
      out = out.slice(0, o).replace(/[\s，,、·:：;；\-–—…‥]+$/g, '');
    }
  }
  return out;
}

// 超长片段的安全截断：只在中文标点或"成对括号结束处"断开；
// 绝不按空格断（拉丁作品名如《RF Online Next》会被切成半个词，再经 tidyTail 只剩 "Netmarble"）
function safeCut(s, max) {
  if (s.length <= max) return s;
  const head = s.slice(0, max);
  const punct = ['，', ',', '、', '·', '：', ':', '；', ';'].map((ch) => head.lastIndexOf(ch));
  const p = Math.max(...punct);
  if (p >= 8) return head.slice(0, p);
  const closeIdx = Math.max(
    head.lastIndexOf('》'), head.lastIndexOf('”'), head.lastIndexOf('’'),
    head.lastIndexOf('）'), head.lastIndexOf(')'), head.lastIndexOf('】'),
  );
  if (closeIdx >= 8) return head.slice(0, closeIdx + 1);
  return head;
}

// 把新闻标题压成可嵌入句子的短语。
//
// 根因记录（2026-09-11）：原实现只做 `t.slice(0, 34) + '…'` 的硬截断，而韩媒标题
// 本身惯用 "…" 连接主句与补充说明（如 "每名子女最高1亿·AI 支持300亿…Krafton 获评最佳就业企业"），
// 于是兜底文案出现双重省略号 + 断在词中间的残句："受每名子女最高1亿·AI 支持300亿…Krafton 获评最佳就业企…等利好提振"。
// 现改为：按 "…" 切片 → 优选含主体名且长度合适的片段 → 超长时只在安全边界截断 → 收尾清理。
function trimNews(t, max = 30, prefer = '') {
  let s = cleanNewsTitle(t);
  const segs = s.split(/[…‥]+/).map((x) => x.trim()).filter(Boolean);
  if (segs.length) {
    const fit = segs.filter((x) => x.length >= 8 && x.length <= max);
    const named = prefer ? fit.find((x) => x.includes(prefer)) : null;
    s = named || fit[0] || [...segs].sort((a, b) => b.length - a.length)[0];
  }
  return tidyTail(safeCut(s, max));
}

function dailyRuleFallback(fact, news, isSU, dailyPct) {
  const dir = Number.isNaN(dailyPct) ? '震荡' : (dailyPct > 0 ? '上行' : dailyPct < 0 ? '下行' : '盘整');
  const hasCJK = (t) => /[가-힣一-鿿]/.test(t);
  const cNews = (news.company || []).map((n) => n.title).filter(hasCJK).map((t) => ({ t, s: classifySentiment(t) }));
  const sNews = (news.sector || []).map((n) => n.title).filter(hasCJK).map((t) => ({ t, s: classifySentiment(t) }));
  const posNews = [...cNews, ...sNews].filter((x) => x.s > 0).map((x) => x.t);
  const negNews = [...cNews, ...sNews].filter((x) => x.s < 0).map((x) => x.t);
  const brief = (t) => trimNews(t, 30, fact.name);
  if (dir === '下行') {
    if (negNews.length) return `受${brief(negNews[0])}等利空拖累，当日下行。`;
    if (posNews.length) return `当日下行，虽有${brief(posNews[0])}等利好，但未能抵挡板块/大盘回调压力。`;
    return `当日下行，与板块及大盘氛围相关，未见明确独立催化。`;
  }
  if (dir === '上行') {
    if (posNews.length) return `受${brief(posNews[0])}等利好提振，当日上行。`;
    if (negNews.length) return `当日逆势上行，虽有${brief(negNews[0])}等利空，但已被市场消化。`;
    return `当日上行，板块情绪回暖带动，未见明确独立催化。`;
  }
  return `当日盘整，多空均衡，方向性催化有限。`;
}

async function generateDailyEntityText(fact, news, isSU, dailyPct) {
  const sheet = buildDailyFactsSheet(fact, news, dailyPct);
  const allowedFacts = buildAllowedFacts(fact, news);
  const userPrompt = buildDailyUserPrompt(fact, news, dailyPct);
  try {
    let raw = await callLLM({
      systemPrompt: DAILY_SYSTEM_PROMPT,
      userPrompt,
      temperature: 0.35,
      maxTokens: 300,
    });
    let text = raw.replace(/^```(?:json|html)?|```$/g, '').trim();
    if (!text) throw new Error('空回复');
    if (hasHallucination(text, sheet, allowedFacts)) {
      console.warn(`  ↳ ${fact.name} 首次输出疑似含白名单外事实，重试一次`);
      raw = await callLLM({
        systemPrompt: DAILY_SYSTEM_PROMPT + '\n【警告】上次回答含有白名单外的事实断言。必须严格只使用"允许提及的事实白名单"中的内容，不得添加任何清单外信息。',
        userPrompt,
        temperature: 0.3,
        maxTokens: 300,
      });
      text = raw.replace(/^```(?:json|html)?|```$/g, '').trim();
      if (hasHallucination(text, sheet, allowedFacts)) {
        console.warn(`  ↳ ${fact.name} 重试后仍疑似含白名单外事实，回退规则模板`);
        return dailyRuleFallback(fact, news, isSU, dailyPct);
      }
    }
    return text;
  } catch (err) {
    console.warn(`  ↳ ${fact.name} LLM 调用失败(${err.message})，使用规则模板`);
    return dailyRuleFallback(fact, news, isSU, dailyPct);
  }
}

// entityFilter 可选：仅重算指定 code（'su' 或股票代码），用于单点修复某一家的异常驱动因素，
// 不触动同日其余已生成好的实体（如 2026-09-11 仅需重算 Krafton/Pearl Abyss）
async function generateDailyAll(asOfDate, content, entityFilter) {
  const monthSnapshots = loadMonthSnapshots(asOfDate);
  const snap = readSnapshot(asOfDate) || (fs.existsSync(LATEST_PATH) ? JSON.parse(fs.readFileSync(LATEST_PATH, 'utf8')) : null);
  const { facts, entities } = buildQuantContext(asOfDate, monthSnapshots, snap, content);
  const result = { su: null, companies: {} };
  for (const e of entities) {
    if (entityFilter && (e.isSU ? 'su' : e.code) !== entityFilter) continue;
    const dailyPct = getStockPct(e, snap);
    // 当日波动 <1% 的股票不会在「今日总结」个股驱动中展示，跳过 LLM 调用以节省额度
    if (Number.isNaN(dailyPct) || Math.abs(dailyPct) < 1) continue;
    const fact = { ...facts[e.code], asOfDate };
    const news = getDayNews(content, e.name, mmddOf(asOfDate), asOfDate);
    const text = await generateDailyEntityText(fact, news, e.isSU, dailyPct);
    if (e.isSU) result.su = text;
    else result.companies[e.code] = text;
  }
  return result;
}

// 枚举某月全部快照日期（data/YYYYMMDD.json）
function collectMonthDates(monthPrefix) {
  const dates = [];
  if (fs.existsSync(DATA_DIR)) {
    for (const f of fs.readdirSync(DATA_DIR)) {
      const m = f.match(/^(\d{8})\.json$/);
      if (!m) continue;
      if (m[1].startsWith(monthPrefix)) dates.push(m[1]);
    }
  }
  return dates.sort();
}

// ---------- 主流程 ----------

function isOldListing(text) {
  // 旧"逐日罗列"签名：含"走势回顾"或大量 "MM.DD涨/跌+..%；" 结构
  if (/走势回顾/.test(text)) return true;
  const dayEntries = (text.match(/\d{2}\.\d{2}(?:涨|跌|平)\s*[+-]?\d+\.?\d*%/g) || []).length;
  return dayEntries >= 3;
}

async function main() {
  const force = process.argv.includes('--force');
  const dailyMode = process.argv.includes('--daily');
  const cfg = llmConfig();
  console.log(`[generate-analysis] LLM: model=${cfg.model} base=${cfg.baseUrl} key=${cfg.apiKey ? '已配置' : '缺失(将用规则兜底)'}`);

  const latest = JSON.parse(fs.readFileSync(LATEST_PATH, 'utf8'));
  const dateStr = latest.meta.date;
  const content = JSON.parse(fs.readFileSync(CONTENT_PATH, 'utf8'));
  if (!content.analysis) content.analysis = {};
  if (!content.analysis.su) content.analysis.su = {};
  if (!content.analysis.company) content.analysis.company = {};
  if (dailyMode && !content.analysis.daily) content.analysis.daily = {};

  // ===== 单日模式：生成 analysis.daily[code][date]，跳过月度逻辑 =====
  if (dailyMode) {
    const targetMonths = force ? new Set(['202607', '202608']) : new Set([dateStr.slice(0, 6)]);
    const targetDates = new Set();
    for (const m of targetMonths) for (const d of collectMonthDates(m)) targetDates.add(d);
    targetDates.add(dateStr);
    const dateArgIdx = process.argv.indexOf('--date');
    if (dateArgIdx >= 0 && process.argv[dateArgIdx + 1]) {
      targetDates.clear();
      targetDates.add(process.argv[dateArgIdx + 1]);
    }
    const allCodes = ['su', ...Object.keys(TRACKED_COMPANY)];
    // 单点修复：--code <su|股票代码> 仅重算该实体，其余实体当日已有文案保持不变
    const codeArgIdxD = process.argv.indexOf('--code');
    const entityFilterD = codeArgIdxD >= 0 && process.argv[codeArgIdxD + 1] ? process.argv[codeArgIdxD + 1] : undefined;
    let wrote = 0;
    for (const td of [...targetDates].sort()) {
      const hasAll = allCodes.every((c) => content.analysis.daily[c] && content.analysis.daily[c][td]);
      if (!force && !entityFilterD && hasAll) continue;
      console.log(`[generate-analysis] 生成单日 ${td} ...`);
      const gen = await generateDailyAll(td, content, entityFilterD);
      if (!content.analysis.daily.su) content.analysis.daily.su = {};
      // gen.su 在 --code 过滤到其它实体时为 null，须排除，否则会误清空已有 SU 文案
      if (!entityFilterD || entityFilterD === 'su') {
        content.analysis.daily.su[td] = gen.su;
        if (gen.su) wrote++;
        console.log(`  ✓ SU: ${gen.su ? gen.su.slice(0, 60) : '(波动<1%，跳过)'}`);
      }
      for (const [code, text] of Object.entries(gen.companies)) {
        if (!content.analysis.daily[code]) content.analysis.daily[code] = {};
        content.analysis.daily[code][td] = text;
        wrote++;
        console.log(`  ✓ ${TRACKED_COMPANY[code]}: ${text.slice(0, 50)}...`);
      }
      fs.writeFileSync(CONTENT_PATH, JSON.stringify(content, null, 2));
      console.log(`  → 已落盘（累计 ${wrote} 条）`);
    }
    console.log(`[generate-analysis] 单日分析完成，共写入 ${wrote} 条到 content.json`);
    return;
  }

  // 决定要生成的日期集合
  const targetMonths = force ? new Set(['202607', '202608']) : new Set([dateStr.slice(0, 6)]);
  const targetDates = new Set();
  if (force) {
    // 重刷目标月份内所有已有条目 + 当日
    for (const k of Object.keys(content.analysis.su)) {
      if (targetMonths.has(k.slice(0, 6))) targetDates.add(k);
    }
    for (const code of Object.keys(content.analysis.company)) {
      for (const k of Object.keys(content.analysis.company[code] || {})) {
        if (targetMonths.has(k.slice(0, 6))) targetDates.add(k);
      }
    }
    targetDates.add(dateStr);
  } else {
    targetDates.add(dateStr);
  }
  // 调试/单日验证：--date YYYYMMDD 仅处理该日
  const dateArgIdx = process.argv.indexOf('--date');
  if (dateArgIdx >= 0 && process.argv[dateArgIdx + 1]) {
    targetDates.clear();
    targetDates.add(process.argv[dateArgIdx + 1]);
  }
  // 调试/单点修复：--code <su|股票代码> 仅重算该实体，不触动同日其余已生成好的实体
  const codeArgIdx = process.argv.indexOf('--code');
  const entityFilter = codeArgIdx >= 0 && process.argv[codeArgIdx + 1] ? process.argv[codeArgIdx + 1] : undefined;

  let wrote = 0;
  for (const td of [...targetDates].sort()) {
    // 触发判断（非 force 时）：当日波动达标或大盘极端才生成
    if (!force) {
      const snap = readSnapshot(td) || latest;
      const suPct = parseNum(snap?.shiftUp?.changePercent);
      let bigIndex = false;
      for (const idx of snap?.indices || []) {
        if (Math.abs(parseNum(idx.changePercent)) >= INDEX_EXTREME) bigIndex = true;
      }
      const anyStock = buildEntities().some((e) => {
        const p = getStockPct(e, snap);
        return !Number.isNaN(p) && Math.abs(p) >= STOCK_THRESHOLD;
      });
      const suExists = !!content.analysis.su[td];
      const allCompanyExists = buildEntities().filter((e) => !e.isSU).every((e) => content.analysis.company[e.code]?.[td]);
      if (!((!Number.isNaN(suPct) && Math.abs(suPct) >= STOCK_THRESHOLD) || bigIndex || anyStock) && suExists && allCompanyExists) {
        continue; // 无显著波动且已存在 -> 跳过
      }
    }

    console.log(`[generate-analysis] 生成 ${td} ...`);
    const gen = await generateAll(td, content, entityFilter);

    // 写回（--force 全量覆盖；否则仅当不存在或为旧"逐日罗列"格式时覆盖，保留人工精修）
    // gen.su 在指定 --code 过滤且非 su 时为 null，须排除，否则会误将已有 su 分析清空
    const suExisting = content.analysis.su[td];
    if (gen.su != null && (force || !suExisting || isOldListing(suExisting || ''))) {
      content.analysis.su[td] = gen.su;
      wrote++;
      console.log(`  ✓ SU: ${gen.su.slice(0, 60)}...`);
    }
    for (const [code, text] of Object.entries(gen.companies)) {
      if (!content.analysis.company[code]) content.analysis.company[code] = {};
      const existing = content.analysis.company[code][td];
      if (force || !existing || isOldListing(existing || '')) {
        content.analysis.company[code][td] = text;
        wrote++;
        console.log(`  ✓ ${TRACKED_COMPANY[code]}: ${text.slice(0, 50)}...`);
      }
    }
  }

  if (wrote > 0) {
    fs.writeFileSync(CONTENT_PATH, JSON.stringify(content, null, 2));
    console.log(`[generate-analysis] 已写入 ${wrote} 条分析到 content.json`);
  } else {
    console.log('[generate-analysis] 无新增/待迁移条目，content.json 未改动');
  }
}

main().catch((err) => {
  console.error('[generate-analysis] 致命错误：', err);
  process.exit(1);
});
