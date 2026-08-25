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

import { readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
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

// ====== 读取本月内（截至 dateStr 当天）所有交易日的历史快照文件 ======
// 用途：让"本月变动原因分析"真正基于全月已发生的显著交易日拼装叙事，
//      而不是每次只重复"当日"这一天的数据（那样套在"本月"标题下会显得
//      前后矛盾：标题说月累计X%，正文却只解释今天一天的0%涨跌）。
function loadMonthSnapshots(dateStr) {
  const month = dateStr.slice(0, 6);
  let files = [];
  try {
    files = readdirSync(DATA_DIR).filter(f => /^\d{8}\.json$/.test(f) && f.slice(0, 6) === month && f.slice(0, 8) <= dateStr);
  } catch {
    return [];
  }
  files.sort();
  const snapshots = [];
  for (const f of files) {
    try {
      snapshots.push(JSON.parse(readFileSync(join(DATA_DIR, f), 'utf-8')));
    } catch {
      // 忽略读取失败的单个快照，不影响其余月度叙事
    }
  }
  return snapshots;
}

// 韩语残留二次校验：过滤掉 title 中仍含韩语字符的事件
// （fetch-news.mjs 的本地词典翻译偶尔产出中韩混杂病句，此处作为最终防线）
function stripInvalidEvents(events) {
  return events.filter(e => !/[가-힣]/.test(e.title.replace(/<[^>]+>/g, '')));
}

// ====== 规则引擎：基于"全月已发生的显著交易日"拼装真正的月度叙事文本 ======
// isSU: 是否为 Shift Up（用于从快照中取对应字段）；key: 公司代码（SU 时忽略）
function buildMonthlyNarrativeText({ companyName, isSU, key, monthSnapshots, allEvents, monthLabel }) {
  const validEvents = stripInvalidEvents(allEvents);

  function eventFor(mmdd) {
    const evt = validEvents.find(e => e.date === mmdd && (e.company === companyName || e.company === '六大游戏公司'));
    return evt ? evt.title.replace(/<[^>]+>/g, '') : null;
  }

  const notableDays = [];
  for (const snap of monthSnapshots) {
    const dS = snap?.meta?.date;
    if (!dS) continue;
    const kospiP = parseFloat(snap.indices?.find(i => i.code === 'KOSPI')?.changePercent) || 0;
    const kosdaqP = parseFloat(snap.indices?.find(i => i.code === 'KOSDAQ')?.changePercent) || 0;
    const idxBig = Math.abs(kospiP) >= INDEX_EXTREME_THRESHOLD || Math.abs(kosdaqP) >= INDEX_EXTREME_THRESHOLD;
    let stockPct = 0;
    if (isSU) {
      stockPct = parseFloat(snap.shiftUp?.changePercent) || 0;
    } else {
      const c = (snap.companies || []).find(cc => cc.code === key);
      stockPct = parseFloat(c?.change) || 0;
    }
    if (Math.abs(stockPct) >= STOCK_THRESHOLD || idxBig) {
      const biggerCode = Math.abs(kospiP) >= Math.abs(kosdaqP) ? 'KOSPI' : 'KOSDAQ';
      const biggerPct = biggerCode === 'KOSPI' ? kospiP : kosdaqP;
      notableDays.push({ mmdd: mmddOf(dS), stockPct, idxBig, biggerCode, biggerPct });
    }
  }

  if (notableDays.length === 0) return '';

  // 最多展示近 5 个显著交易日，避免叙事过长；保留时间顺序（早→晚）
  const shown = notableDays.slice(-5);
  const clauses = shown.map(d => {
    const dir = d.stockPct > 0 ? '涨' : d.stockPct < 0 ? '跌' : '平';
    let clause = `${d.mmdd}${dir}${fmtPct(d.stockPct)}`;
    if (d.idxBig) {
      const sameDirection = (d.stockPct >= 0 && d.biggerPct >= 0) || (d.stockPct <= 0 && d.biggerPct <= 0);
      const tag = d.stockPct === 0 ? '大盘剧烈波动中持平' : (sameDirection ? '同向' : '逆势');
      clause += `（大盘${d.biggerCode}${fmtPct(d.biggerPct)}，${tag}）`;
    }
    const evt = eventFor(d.mmdd);
    if (evt) clause += `「${evt}」`;
    return clause;
  });

  const omittedNote = notableDays.length > shown.length ? `（另有${notableDays.length - shown.length}个早期显著交易日未列出）` : '';
  return `${companyName}${monthLabel}内主要交易日：${clauses.join('；')}${omittedNote}。`;
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
  const indices = latest.indices || [];
  const kospiPct = parseFloat(indices.find(i => i.code === 'KOSPI')?.changePercent) || 0;
  const kosdaqPct = parseFloat(indices.find(i => i.code === 'KOSDAQ')?.changePercent) || 0;
  const isBigIndexMove = Math.abs(kospiPct) >= INDEX_EXTREME_THRESHOLD || Math.abs(kosdaqPct) >= INDEX_EXTREME_THRESHOLD;

  const allEvents = [...(content.events || []), ...(content.industryNews || [])];

  // 当月标签（如 "7月"）
  const monthLabel = dateStr ? `${parseInt(dateStr.slice(4, 6), 10)}月` : '本月';

  // 本月内（截至今天）所有交易日快照，用于拼装真正的"月度"叙事，
  // 而非只重复"当日"这一天的数据（详见 buildMonthlyNarrativeText 注释）。
  const monthSnapshots = loadMonthSnapshots(dateStr);
  // 兜底：若当日快照文件因时序原因尚未写入磁盘，仍用内存中的 latest.json 补上，
  // 确保"月度叙事"一定覆盖到今天（否则会出现触发了生成、却因今天不在
  // notableDays 里而返回空文本的边界情况）。
  if (!monthSnapshots.some(s => s?.meta?.date === dateStr)) {
    monthSnapshots.push(latest);
  }

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
      let text = buildMonthlyNarrativeText({
        companyName: SU_NAME, isSU: true, key: null,
        monthSnapshots, allEvents, monthLabel,
      });
      const polished = text ? await polishWithLLM(text, SU_NAME) : null;
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
      let text = buildMonthlyNarrativeText({
        companyName: name, isSU: false, key: code,
        monthSnapshots, allEvents, monthLabel,
      });
      const polished = text ? await polishWithLLM(text, name) : null;
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
