#!/usr/bin/env node
// ============================================================
// 涨跌分析自动生成 - 韩国游戏股价看板
// 用途：每日数据更新后，基于当日股价涨跌幅 + 大盘指数异动 + 当日事件，
//       自动生成/追加一条"涨跌原因"分析文本，写入 data/content.json 的
//       analysis.su / analysis.company[code] 结构（index.html 的
//       generateSUAnalysis()/findCompanyReason() 会按日期优先读取这里）。
//
// 触发条件：默认只在"大盘或个股出现>=2%异动"时生成，避免每天都写入
//          意义不大的"正常波动"文案，保持 content.json 干净。
//
// 幂等性：同一 dateStr 已存在对应分析文本时跳过，不会覆盖已有内容
//        （人工修正过的文本不会被自动脚本覆盖）。
//
// 环境变量（可选，未配置时使用规则引擎兜底，不影响主流程）：
//   OPENAI_API_KEY / ANTHROPIC_API_KEY - 用于润色规则引擎生成的事实文本
//   OPENAI_BASE_URL - OpenAI 兼容网关地址（默认 https://api.openai.com/v1）
//                     可指向 DeepSeek / 通义千问 / 智谱 / 月之暗面 / 混元等兼容服务
//   OPENAI_MODEL    - 模型名（默认 gpt-4o-mini；换厂商时必须一并指定）
//
// 用法: node scripts/generate-analysis.mjs
// ============================================================

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const DATA_DIR = join(import.meta.dirname || '.', '..', 'data');
const LATEST_PATH = join(DATA_DIR, 'latest.json');
const CONTENT_PATH = join(DATA_DIR, 'content.json');

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
// OpenAI 官方 API 在部分地区注册/支付门槛较高，因此把网关与模型抽成环境变量，
// 使其可直接复用任何"OpenAI 兼容"服务（DeepSeek、通义千问、智谱、Kimi、混元等），
// 无需改代码。未配置时行为与之前完全一致。
const OPENAI_BASE_URL = (process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1').replace(/\/+$/, '');
const OPENAI_MODEL = process.env.OPENAI_MODEL || 'gpt-4o-mini';

// 跟踪公司：code -> name（与 validate-data.mjs 保持一致）
const TRACKED_COMPANY = {
  '225570': 'Nexon Games',
  '251270': 'Netmarble',
  '036570': 'NC',
  '259960': 'Krafton',
  '263750': 'Pearl Abyss',
};
const SU_CODE = '462870';
const SU_NAME = 'Shift Up';

// 触发阈值：个股涨跌幅超过此值才生成分析
const STOCK_THRESHOLD = 2;
// 大盘异动阈值：KOSPI/KOSDAQ 涨跌幅超过此值视为"极端波动"
const INDEX_EXTREME_THRESHOLD = 3;

function fmtPct(v) {
  const n = parseFloat(v);
  if (isNaN(n)) return '0.00%';
  return `${n >= 0 ? '+' : ''}${n.toFixed(2)}%`;
}

function mmddOf(dateStr) {
  // dateStr: YYYYMMDD -> MM.DD（与 content.json 中 events.date 格式一致）
  if (!dateStr || dateStr.length < 8) return '';
  return `${dateStr.slice(4, 6)}.${dateStr.slice(6, 8)}`;
}

// ====== 可选：调用 LLM 对规则引擎生成的事实文本进行润色（不改变事实，只优化表达）======
async function polishWithLLM(factsText, companyName) {
  const apiKey = OPENAI_API_KEY || ANTHROPIC_API_KEY;
  if (!apiKey) return null;
  const systemPrompt = '你是韩国游戏行业股票分析师。你会收到一段已核实的事实性文本，只能在不改变任何数字、事件、公司名的前提下，让语言更流畅、专业。禁止编造、禁止删减关键事实。若无需改动，原样返回。';
  const userPrompt = `请润色以下关于 ${companyName} 的涨跌分析文本（保留所有<strong>标签和数字）：\n\n${factsText}`;
  try {
    if (OPENAI_API_KEY) {
      const resp = await fetch(`${OPENAI_BASE_URL}/chat/completions`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${OPENAI_API_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: OPENAI_MODEL,
          messages: [{ role: 'system', content: systemPrompt }, { role: 'user', content: userPrompt }],
          temperature: 0.2,
          max_tokens: 500,
        }),
      });
      const data = await resp.json();
      return data.choices?.[0]?.message?.content?.trim() || null;
    }
    if (ANTHROPIC_API_KEY) {
      const resp = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'x-api-key': ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01', 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: 'claude-sonnet-4-20250514',
          max_tokens: 500,
          system: systemPrompt,
          messages: [{ role: 'user', content: userPrompt }],
        }),
      });
      const data = await resp.json();
      return data.content?.[0]?.text?.trim() || null;
    }
  } catch (err) {
    console.warn(`  ⚠️ LLM 润色失败 (${companyName}): ${err.message}，使用规则引擎原文`);
  }
  return null;
}

// ====== 规则引擎：基于真实数据拼装事实性分析文本 ======
function buildRuleBasedText({ companyName, changePercent, kospiPct, kosdaqPct, matchedEvents, isBigIndexMove, indexHeadline, monthChange, monthLabel }) {
  const pct = parseFloat(changePercent) || 0;
  const direction = pct > 0 ? '上涨' : pct < 0 ? '下跌' : '平盘';
  let text = '';

  // 月度累计涨跌背景（当累计变动≥1%时展示，体现"本月变动分析"而非纯"当日分析"）
  if (monthChange != null && Math.abs(monthChange) >= 1) {
    const monthDir = monthChange >= 0 ? '上涨' : '下跌';
    const monthStr = monthLabel || '本月';
    text += `${companyName}${monthStr}累计${monthDir}${fmtPct(monthChange)}，`;
  }

  if (isBigIndexMove) {
    // 修复：原逻辑只在个股下跌(pct<0)时才做"强于/弱于大盘"的相对比较，
    // 个股上涨时无条件写"跟随大盘走势"——但若此时大盘（更大异动的那个指数）
    // 恰好是下跌的，"个股上涨+跟随大盘下跌走势"自相矛盾（逆势上涨被误写成跟随）。
    // 这里改为先比较个股涨跌方向与大盘（取较大异动的指数）方向是否一致，
    // 一致时才谈"强于/弱于/同步大盘"，不一致时明确写"逆势"。
    const biggerIndexPct = Math.abs(kospiPct) >= Math.abs(kosdaqPct) ? kospiPct : kosdaqPct;
    const sameDirection = (pct >= 0 && biggerIndexPct >= 0) || (pct <= 0 && biggerIndexPct <= 0);
    let relative;
    if (pct === 0) {
      relative = '在大盘剧烈波动中保持相对平稳';
    } else if (!sameDirection && biggerIndexPct !== 0) {
      relative = pct > 0 ? '逆势上涨，走势与大盘方向相反' : '逆势下跌，走势与大盘方向相反';
    } else {
      const absPct = Math.abs(pct);
      const absIndexMin = Math.min(Math.abs(kospiPct), Math.abs(kosdaqPct));
      const absIndexMax = Math.max(Math.abs(kospiPct), Math.abs(kosdaqPct));
      if (absPct < absIndexMin) {
        relative = pct < 0 ? '表现明显抗跌，跌幅远小于大盘' : '涨幅不及大盘整体水平';
      } else if (absPct > absIndexMax) {
        relative = pct < 0 ? '跌幅超过大盘整体水平，波动被进一步放大' : '涨幅超过大盘整体水平，跟随大盘走势并进一步放大';
      } else {
        relative = pct < 0 ? '跌幅与大盘基本同步' : '涨幅与大盘基本同步，跟随大盘走势';
      }
    }
    text += `${indexHeadline}中，${companyName}当日${direction}${fmtPct(changePercent)}，${relative}。`;
  } else {
    text += `当日${direction}${fmtPct(changePercent)}，`;
  }

  // 韩语残留二次校验：过滤掉 title 中仍含韩语字符的事件
  // （fetch-news.mjs 的本地词典翻译偶尔产出中韩混杂病句，
  //   即使已有收紧的质量校验，仍有历史脏数据可能留在 content.json 中，
  //   此处作为最终防线，保证分析文案不会出现韩语字符）
  const validEvents = matchedEvents.filter(e => {
    const cleaned = e.title.replace(/<[^>]+>/g, '');
    return !/[가-힣]/.test(cleaned);
  });

  if (validEvents.length > 0) {
    const evt = validEvents[0];
    const evtTitle = evt.title.replace(/<[^>]+>/g, '');
    text += `叠加当日消息面「${evtTitle}」。`;
  } else if (!isBigIndexMove) {
    text += '未见明确专属事件驱动，波动更多来自板块联动或资金面因素。';
  }

  return text;
}

async function main() {
  console.log('='.repeat(50));
  console.log('📊 涨跌分析自动生成');
  console.log(`🤖 LLM 润色: ${OPENAI_API_KEY ? 'OpenAI 已配置' : ANTHROPIC_API_KEY ? 'Anthropic 已配置' : '未配置（仅规则引擎）'}`);
  console.log('='.repeat(50));

  if (!existsSync(LATEST_PATH)) {
    console.warn('⚠️ latest.json 不存在，跳过');
    return;
  }
  if (!existsSync(CONTENT_PATH)) {
    console.warn('⚠️ content.json 不存在，跳过');
    return;
  }

  const latest = JSON.parse(readFileSync(LATEST_PATH, 'utf-8'));
  const content = JSON.parse(readFileSync(CONTENT_PATH, 'utf-8'));

  const dateStr = latest.meta?.date;
  if (!dateStr) {
    console.warn('⚠️ latest.json 缺少 meta.date，跳过');
    return;
  }
  const mmdd = mmddOf(dateStr);

  const indices = latest.indices || [];
  const kospiPct = parseFloat(indices.find(i => i.code === 'KOSPI')?.changePercent) || 0;
  const kosdaqPct = parseFloat(indices.find(i => i.code === 'KOSDAQ')?.changePercent) || 0;
  const isBigIndexMove = Math.abs(kospiPct) >= INDEX_EXTREME_THRESHOLD || Math.abs(kosdaqPct) >= INDEX_EXTREME_THRESHOLD;
  const biggerCode = Math.abs(kospiPct) >= Math.abs(kosdaqPct) ? 'KOSPI' : 'KOSDAQ';
  const biggerPct = biggerCode === 'KOSPI' ? kospiPct : kosdaqPct;
  const indexHeadline = isBigIndexMove
    ? `<strong>大盘异动：${biggerCode} ${fmtPct(biggerPct)}</strong>`
    : '';

  const allEvents = [...(content.events || []), ...(content.industryNews || [])];
  const todayEvents = allEvents.filter(e => e.date === mmdd);

  // 计算月度累计涨跌：从 chartData 筛选当月数据
  function calcMonthChange(chartData, dateStr) {
    if (!chartData || chartData.length < 2) return null;
    const month = dateStr.slice(0, 6);
    const monthData = chartData
      .filter(d => d.date && d.date.startsWith(month) && d.date <= dateStr)
      .sort((a, b) => a.date.localeCompare(b.date));
    if (monthData.length < 2) return null;
    const firstPrice = monthData[0].price;
    const lastPrice = monthData[monthData.length - 1].price;
    if (!firstPrice || !lastPrice || firstPrice === 0) return null;
    return ((lastPrice - firstPrice) / firstPrice * 100);
  }
  // 当月标签（如 "7月"）
  const monthLabel = dateStr ? `${parseInt(dateStr.slice(4, 6), 10)}月` : '本月';

  // SU 月度涨跌（从 chartData 计算）
  const suMonthChange = calcMonthChange(latest.chartData, dateStr);

  if (!content.analysis) content.analysis = { version: '1.0', su: {}, company: {} };
  if (!content.analysis.su) content.analysis.su = {};
  if (!content.analysis.company) content.analysis.company = {};

  // 注：曾有"月末保护"逻辑（当月已有analysis key时跳过后续写入），用于规避
  // index.html 旧版"按月兜底"bug（取当月最大key，不管是否晚于当前查看日期）。
  // 该bug已在 index.html 的 generateSUAnalysis()/getItemText() 中修复
  // （兜底过滤条件改为 k.startsWith(monthKey) && k <= exactKey，只取"不晚于
  // 当前查看日期"的最新分析）。因此"月末保护"已无必要，且会错误阻止
  // 每月20号之后的新增大幅波动（如7/29、7/31）被记录，导致月末汇总不完整。
  // 已移除该保护逻辑，改为每个交易日独立写入各自日期key，互不覆盖。

  let generatedCount = 0;
  let skippedCount = 0;

  // ====== Shift Up ======
  const su = latest.shiftUp;
  if (su) {
    const pct = Math.abs(parseFloat(su.changePercent) || 0);
    if ((pct >= STOCK_THRESHOLD || isBigIndexMove) && !content.analysis.su[dateStr]) {
      const matchedEvents = todayEvents.filter(e => e.company === SU_NAME || e.company === '六大游戏公司');
      let text = buildRuleBasedText({
        companyName: SU_NAME, changePercent: su.changePercent, kospiPct, kosdaqPct,
        matchedEvents, isBigIndexMove, indexHeadline,
        monthChange: suMonthChange, monthLabel,
      });
      const polished = await polishWithLLM(text, SU_NAME);
      if (polished) text = polished;
      content.analysis.su[dateStr] = text;
      console.log(`  ✅ [SU] 已生成 ${dateStr} 分析: ${text.slice(0, 40)}...`);
      generatedCount++;
    } else if (content.analysis.su[dateStr]) {
      console.log(`  ⏭️ [SU] ${dateStr} 已有分析，跳过`);
      skippedCount++;
    } else {
      console.log(`  ⏭️ [SU] 波动 ${su.changePercent} 未达阈值，跳过`);
    }
  }

  // ====== 其他 5 家公司 ======
  for (const c of (latest.companies || [])) {
    const code = c.code;
    const name = TRACKED_COMPANY[code] || c.name;
    if (!code || !TRACKED_COMPANY[code]) continue;
    const pct = Math.abs(parseFloat(c.change) || 0);
    if (!content.analysis.company[code]) content.analysis.company[code] = {};

    if ((pct >= STOCK_THRESHOLD || isBigIndexMove) && !content.analysis.company[code][dateStr]) {
      const matchedEvents = todayEvents.filter(e => e.company === name || e.company === '六大游戏公司');
      let text = buildRuleBasedText({
        companyName: name, changePercent: c.change, kospiPct, kosdaqPct,
        matchedEvents, isBigIndexMove, indexHeadline,
        monthChange: null, monthLabel,
      });
      const polished = await polishWithLLM(text, name);
      if (polished) text = polished;
      content.analysis.company[code][dateStr] = text;
      console.log(`  ✅ [${name}] 已生成 ${dateStr} 分析: ${text.slice(0, 40)}...`);
      generatedCount++;
    } else if (content.analysis.company[code][dateStr]) {
      console.log(`  ⏭️ [${name}] ${dateStr} 已有分析，跳过`);
      skippedCount++;
    } else {
      console.log(`  ⏭️ [${name}] 波动 ${c.change} 未达阈值，跳过`);
    }
  }

  if (generatedCount > 0) {
    writeFileSync(CONTENT_PATH, JSON.stringify(content, null, 2) + '\n', 'utf-8');
    console.log(`\n✅ content.json 已更新: 新增 ${generatedCount} 条分析（${dateStr}），跳过 ${skippedCount} 条已存在`);
  } else {
    console.log(`\nℹ️ 无新增分析（无公司/大盘达到 ${STOCK_THRESHOLD}% 阈值，或当日分析已存在），content.json 未改动`);
  }
}

main().catch(err => {
  console.error('❌ 涨跌分析生成失败:', err.message);
  process.exit(0); // 非致命错误，不阻断主流程
});
