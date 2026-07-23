#!/usr/bin/env node
// ============================================================
// 数据验证脚本 - 韩国游戏股价看板
// 用途：数据更新后自动检查内容是否符合规则
// 触发方式：GitHub Actions workflow 中调用
// ============================================================

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const DATA_DIR = join(import.meta.dirname || '.', '..', 'data');
let errors = 0;
let warnings = 0;

function fail(msg) {
  console.error(`❌ FAIL: ${msg}`);
  errors++;
}
function warn(msg) {
  console.warn(`⚠️  WARN: ${msg}`);
  warnings++;
}
function pass(msg) {
  console.log(`✅ PASS: ${msg}`);
}

// ====== KRX 休市日（2026年）======
const KRX_HOLIDAYS_2026 = [
  '20260101', '20260216', '20260217', '20260218',
  '20260302', '20260501', '20260505', '20260525',
  '20260603', '20260717', '20260817',
  '20260924', '20260925', '20261005',
  '20261009', '20261225', '20261231'
];

// ====== 跟踪公司 ======
const TRACKED = {
  '462870': 'Shift Up',
  '225570': 'Nexon Games',
  '251270': 'Netmarble',
  '036570': 'NC',
  '259960': 'Krafton',
  '263750': 'Pearl Abyss',
};

// ====== Shift Up 分析中不应出现的其他公司关键词 ======
const SU_FORBIDDEN_KEYWORDS = [
  { keyword: 'Nexon', owner: 'Nexon' },
  { keyword: 'Crimson Desert', owner: 'Pearl Abyss' },
  { keyword: 'PUBG', owner: 'Krafton' },
  { keyword: 'Aion 2', owner: 'NC' },
  { keyword: 'Aion2', owner: 'NC' },
  { keyword: '天堂', owner: 'NC' },
  { keyword: '剑灵', owner: 'NC' },
];

// ====== 1. 读取 latest.json ======
console.log('\n=== 1. 数据文件结构检查 ===');
let data;
try {
  data = JSON.parse(readFileSync(join(DATA_DIR, 'latest.json'), 'utf8'));
  pass('latest.json 可正常读取和解析');
} catch (e) {
  fail(`latest.json 读取或解析失败: ${e.message}`);
  process.exit(1);
}

// ====== 2. meta 字段检查 ======
console.log('\n=== 2. Meta 字段检查 ===');
const meta = data.meta;
if (!meta?.date) fail('meta.date 缺失');
else pass(`meta.date = ${meta.date}`);

if (!meta?.dateDisplay) warn('meta.dateDisplay 缺失');
else pass(`meta.dateDisplay = ${meta.dateDisplay}`);

if (!meta?.updateCount) warn('meta.updateCount 缺失');
else pass(`meta.updateCount = ${meta.updateCount}`);

// 检查日期是否为休市日
if (meta?.date && KRX_HOLIDAYS_2026.includes(meta.date)) {
  fail(`meta.date ${meta.date} 是 KRX 休市日，不应生成数据`);
} else if (meta?.date) {
  pass('meta.date 不是 KRX 休市日');
}

// ====== 3. Shift Up 数据检查 ======
console.log('\n=== 3. Shift Up 核心数据检查 ===');
const su = data.shiftUp;
if (!su) {
  fail('shiftUp 字段缺失');
} else {
  // 基本字段
  for (const field of ['code', 'name', 'price', 'changePercent', 'changeClass', 'per']) {
    if (su[field] === undefined || su[field] === '') {
      warn(`shiftUp.${field} 缺失或为空`);
    }
  }
  pass(`shiftUp 基本字段完整 (code=${su.code}, price=${su.price})`);

  // 价格合理性
  const priceNum = parseInt(String(su.price).replace(/,/g, ''), 10);
  if (priceNum > 0 && priceNum < 500000) {
    pass(`Shift Up 价格合理: ₩${su.price}`);
  } else if (priceNum === 0) {
    fail(`Shift Up 价格为 0，数据异常`);
  } else if (priceNum >= 500000) {
    warn(`Shift Up 价格偏高: ₩${su.price}，请确认`);
  }

  // PER 检查
  if (su.per === 'N/A' || su.per === undefined) {
    pass('Shift Up PER = N/A（可能为负值，属正常）');
  } else {
    const perNum = parseFloat(su.per);
    if (isNaN(perNum)) fail(`Shift Up PER 无法解析: ${su.per}`);
    else if (perNum < 0) pass(`Shift Up PER 为负值: ${perNum}，属正常`);
    else if (perNum > 100) warn(`Shift Up PER 异常偏高: ${perNum}`);
    else pass(`Shift Up PER 合理: ${perNum}`);
  }

  // changeClass 一致性
  const pctStr = String(su.changePercent);
  const pctNum = parseFloat(pctStr);
  if (pctNum > 0 && su.changeClass !== 'up') {
    fail(`Shift Up changePercent=${pctStr} 但 changeClass=${su.changeClass}，不一致`);
  } else if (pctNum < 0 && su.changeClass !== 'down') {
    fail(`Shift Up changePercent=${pctStr} 但 changeClass=${su.changeClass}，不一致`);
  } else if (pctNum === 0 && su.changeClass !== 'neutral') {
    warn(`Shift Up changePercent=0 但 changeClass=${su.changeClass}`);
  } else {
    pass('Shift Up changeClass 与 changePercent 一致');
  }
}

// ====== 4. 其他公司数据检查 ======
console.log('\n=== 4. 其他公司数据检查 ===');
const companies = data.companies || [];
if (companies.length === 0) {
  warn('companies 数组为空');
} else {
  pass(`共 ${companies.length} 家公司数据`);
  const expectedCount = Object.keys(TRACKED).length - 1; // 减去 Shift Up
  if (companies.length !== expectedCount) {
    warn(`预期 ${expectedCount} 家公司，实际 ${companies.length} 家`);
  }

  for (const c of companies) {
    // 检查是否为跟踪公司
    if (!TRACKED[c.code]) {
      warn(`未知公司代码: ${c.code} (${c.name})`);
    }
    // 价格检查
    const p = parseInt(String(c.price).replace(/,/g, ''), 10);
    if (p <= 0) fail(`${c.name} 价格异常: ${c.price}`);
    // changeClass 一致性
    const cp = parseFloat(String(c.change));
    if (cp > 0 && c.changeClass !== 'up') fail(`${c.name} change=${c.change} 但 changeClass=${c.changeClass}`);
    if (cp < 0 && c.changeClass !== 'down') fail(`${c.name} change=${c.change} 但 changeClass=${c.changeClass}`);
  }
  pass('所有公司价格和涨跌方向检查完成');
}

// ====== 5. 大盘指数检查 ======
console.log('\n=== 5. 大盘指数检查 ===');
const indices = data.indices || [];
if (indices.length === 0) {
  warn('indices 数组为空');
} else {
  for (const idx of indices) {
    const p = parseFloat(idx.price);
    if (isNaN(p) || p <= 0) fail(`${idx.name} 价格异常: ${idx.price}`);
    else pass(`${idx.name} = ${idx.price} (${idx.changePercent}%)`);
  }
}

// ====== 6. K线图数据检查 ======
console.log('\n=== 6. K线图数据检查 ===');
const chartData = data.chartData || [];
if (chartData.length === 0) {
  warn('chartData 为空');
} else {
  pass(`chartData 共 ${chartData.length} 条`);
  // 检查是否包含休市日
  for (const item of chartData) {
    if (KRX_HOLIDAYS_2026.includes(item.date)) {
      fail(`chartData 包含 KRX 休市日: ${item.date} (${item.label})`);
    }
  }
  // 检查价格合理性
  for (const item of chartData) {
    if (item.price <= 0) fail(`chartData 价格异常: date=${item.date}, price=${item.price}`);
  }
  pass('chartData 日期和价格检查完成');
}

// ====== 7. content.json 规则检查 ======
console.log('\n=== 7. content.json 规则检查 ===');
let content;
try {
  content = JSON.parse(readFileSync(join(DATA_DIR, 'content.json'), 'utf8').replace(/^\uFEFF/, ''));
  pass('content.json 可正常读取和解析');
} catch (e) {
  fail(`content.json 读取或解析失败: ${e.message}`);
}

if (content) {
  // 7a. compareChart labels 不含休市日
  const labels = content.compareChart?.labels || [];
  if (labels.length > 0) {
    const holidayLabels = labels.filter(l => {
      // 将 "M/D" 格式转换为日期字符串检查
      const match = l.match(/(\d+)\/(\d+)/);
      if (!match) return false;
      const m = parseInt(match[1], 10);
      const d = parseInt(match[2], 10);
      const dateStr = `2026${String(m).padStart(2, '0')}${String(d).padStart(2, '0')}`;
      return KRX_HOLIDAYS_2026.includes(dateStr);
    });
    if (holidayLabels.length > 0) {
      fail(`compareChart.labels 包含休市日: ${holidayLabels.join(', ')}`);
    } else {
      pass('compareChart.labels 不包含 KRX 休市日');
    }
  }

  // 7b. Shift Up 事件分析中不应包含其他公司信息
  const events = content.events || [];
  for (const evt of events) {
    if (evt.company === 'Shift Up' && evt.analysis) {
      for (const { keyword, owner } of SU_FORBIDDEN_KEYWORDS) {
        if (evt.analysis.includes(keyword)) {
          fail(`Shift Up 事件分析中包含其他公司信息: "${keyword}"（属于${owner}），事件: ${evt.date} - ${evt.title || evt.analysis.slice(0, 30)}`);
        }
      }
    }
  }
  pass('Shift Up 事件分析中未包含其他公司信息');

  // 7c. 韩语/英语内容过滤检查（覆盖 events 和 industryNews 两个数组）
  // 背景：曾发生 fetch-news.mjs 的翻译质量判断只检测"韩语占主导"，
  // 漏检了"英文标题未翻译"的情况（本地词典只处理韩语，纯英文媒体标题直接展示未译），
  // 导致资讯板块混入未翻译的英文原文。此检查同时覆盖两种语言 + 两个数组作为兜底防线。
  const koreanRegex = /[\uAC00-\uD7AF\u1100-\u11FF]/g;
  const chineseRegex = /[\u4E00-\u9FFF]/g;
  const englishRegex = /[a-zA-Z]/g;
  const industryNews = content.industryNews || [];
  const eventsForLangCheck = content.events || [];
  for (const [label, list] of [['industryNews', industryNews], ['events', eventsForLangCheck]]) {
    for (const news of list) {
      const koreanCount = (news.title?.match(koreanRegex) || []).length;
      const chineseCount = (news.title?.match(chineseRegex) || []).length;
      const englishCount = (news.title?.match(englishRegex) || []).length;
      if (koreanCount > chineseCount && koreanCount > 5) {
        warn(`${label} 韩语内容过多: "${news.title?.slice(0, 40)}" (韩${koreanCount}/中${chineseCount})`);
      }
      if (englishCount > 10 && chineseCount < 3) {
        warn(`${label} 存在未翻译的英文标题: "${news.title?.slice(0, 60)}" (英${englishCount}/中${chineseCount})`);
      }
      // 检查 JS 字符串引号问题
      if (news.title?.includes("'") && news.title?.startsWith("'")) {
        warn(`${label} 标题可能存在引号问题: "${news.title?.slice(0, 40)}"`);
      }
    }
  }
  pass('events/industryNews 韩语、英语和引号检查完成');

  // 7d. 销量数据来源标注
  for (const news of industryNews) {
    if (news.title && (news.title.includes('万套') || news.title.includes('万份') || news.title.includes('销量'))) {
      if (!news.title.includes('截至') && !news.title.match(/\d+月/) && !news.source) {
        warn(`销量数据未标注来源日期: "${news.title?.slice(0, 50)}"`);
      }
    }
  }
  pass('销量数据来源标注检查完成');

  // 7e. 资讯新鲜度检查（避免 fetch-news.mjs 静默失败导致资讯长期停更却无人发现）
  // 背景：2026-06-30 引入的语法错误导致 fetch-news.mjs 崩溃超过3周未被发现，
  // 因为 workflow 用 `|| echo "skipped"` 吞掉了错误。此检查作为兜底防线。
  const allNews = [...events, ...industryNews];
  function parseNewsDateToDayOfYear(dateStr) {
    // 格式: "07.16" 或 "07.16~20"（取起始日期）
    const m = String(dateStr).match(/^(\d{1,2})\.(\d{1,2})/);
    if (!m) return null;
    const month = parseInt(m[1], 10);
    const day = parseInt(m[2], 10);
    // 用 2026 年构造日期用于比较（本项目数据均为 2026 年）
    return new Date(Date.UTC(2026, month - 1, day));
  }
  const newsDates = allNews.map(n => parseNewsDateToDayOfYear(n.date)).filter(Boolean);
  if (newsDates.length > 0) {
    const latestNewsDate = new Date(Math.max(...newsDates.map(d => d.getTime())));
    // 用 latest.json 的 meta.date（数据当前所处日期）作为基准，而非机器当前时间，
    // 避免脏跑校验脚本时因为"今天"日期而产生误报
    const baseDateStr = data?.meta?.date; // "20260721"
    let baseDate = null;
    if (baseDateStr && /^\d{8}$/.test(baseDateStr)) {
      baseDate = new Date(Date.UTC(
        parseInt(baseDateStr.slice(0, 4), 10),
        parseInt(baseDateStr.slice(4, 6), 10) - 1,
        parseInt(baseDateStr.slice(6, 8), 10)
      ));
    }
    if (baseDate) {
      const diffDays = (baseDate.getTime() - latestNewsDate.getTime()) / (1000 * 60 * 60 * 24);
      const STALE_THRESHOLD_DAYS = 5; // 超过5天未更新资讯视为异常（正常应每日/隔日更新）
      if (diffDays > STALE_THRESHOLD_DAYS) {
        fail(`资讯已停更 ${Math.round(diffDays)} 天！最新资讯日期=${allNews.find(n => parseNewsDateToDayOfYear(n.date)?.getTime() === latestNewsDate.getTime())?.date}，股价数据日期=${baseDateStr}。请检查 fetch-news.mjs 是否正常运行（历史上曾因语法错误静默失败超过3周未被发现）`);
      } else {
        pass(`资讯新鲜度正常（最新资讯距股价数据日期 ${Math.round(diffDays)} 天）`);
      }
    } else {
      warn('无法解析 meta.date，跳过资讯新鲜度检查');
    }
  } else {
    warn('events/industryNews 中没有可解析的日期，跳过资讯新鲜度检查');
  }
}

// ====== 8. 每日JSON文件日期检查 ======
console.log('\n=== 8. 历史数据文件日期检查 ===');
const { readdirSync } = await import('node:fs');
const jsonFiles = readdirSync(DATA_DIR).filter(f => /^\d{8}\.json$/.test(f));
let holidayFileCount = 0;
for (const f of jsonFiles) {
  const dateStr = f.replace('.json', '');
  if (KRX_HOLIDAYS_2026.includes(dateStr)) {
    warn(`存在休市日数据文件: ${f}`);
    holidayFileCount++;
  }
}
if (holidayFileCount === 0) pass('历史数据文件不包含休市日');
else pass(`发现 ${holidayFileCount} 个休市日文件（需人工确认）`);

// ====== 汇总 ======
console.log('\n' + '='.repeat(50));
console.log(`验证完成: ${errors} 错误, ${warnings} 警告`);
console.log('='.repeat(50));

if (errors > 0) {
  console.error('\n🚨 存在错误，请修复后重新运行！');
  process.exit(1);
} else {
  console.log('\n✅ 所有检查通过，数据可正常发布。');
  process.exit(0);
}
