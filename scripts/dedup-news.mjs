#!/usr/bin/env node
/**
 * 一次性数据清理脚本：去除 content.json 中 events/industryNews 的重复新闻
 *
 * 问题背景：历史上同一天同一公司的同一事件常被同时写入 events 和 industryNews
 * 两个数组（措辞略有差异），导致 index.html 的"游戏公司相关资讯"表格合并两个
 * 数组后展示了大量重复内容，挤占了固定10条的展示位。
 *
 * 判重规则：
 *   0. 【最高优先】原文 URL 规范化后相同 —— 无视日期/公司/译文差异直接判重。
 *      2026-08-19 新增：换用不同翻译引擎（免费机翻 → DeepSeek）后，同一条新闻
 *      产生两种措辞的译文，相似度低于 0.4 阈值而被判为"新新闻"，一次性造成
 *      37 组重复。URL 是新闻的天然唯一标识，不受翻译影响。
 *   以下规则在"同公司 + 日期相差 <= DATE_WINDOW_DAYS 天"的分组内生效（用于无 URL 的人工条目，
 *   2026-09-01 由"同日期"放宽为"日期窗口"——同一事件常被 Google News 在不同日期重新收录，
 *   或人工从不同来源摘录时标注了略有差异的日期，原"同日期"判重完全放过了这类跨日重复）：
 *   1. 去除数字/标点后的中文字符 bigram 相似度 >= 0.4
 *   2. 提取的关键数字（百分比/点位等，≥2位）重叠比例 >= 0.5（如果双方都有数字特征）
 *   窗口限定"同公司"是关键防呆：不同公司即使模板化标题相似（如"在线游戏_A,B(M.DD)"这类
 *   同源报告条目）也不会被误判为重复。
 *
 * 聚类方式：并查集（Union-Find），避免同组内既有重复对、又有不同事件时的误判
 * （如 06.09 Shift Up 组：3条中2条重复+1条完全不同的 Nintendo Direct 新闻）
 *
 * 保留策略（每个重复聚类保留一条，依次比较）：
 *   1. 非 translationStatus=fallback 优先（即中文译文优先于英文原标题）
 *   2. 中文字符更多者优先（AI 译文通常比机翻/英文原文更完整地中文化）
 *   3. 标题更长者优先（信息更完整）
 *
 * 用法: node scripts/dedup-news.mjs
 */
import { readFileSync, writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CONTENT_FILE = join(__dirname, '..', 'data', 'content.json');

function stripHtml(t) { return (t || '').replace(/<[^>]+>/g, ''); }
function stripForCompare(title) {
  return stripHtml(title)
    .replace(/[0-9a-zA-Z%.,()（）\-+/\s，。！？：；、“”‘’「」『』——…~]/g, '')
    .trim();
}
function bigrams(str) {
  const set = new Set();
  for (let i = 0; i < str.length - 1; i++) set.add(str.slice(i, i + 2));
  return set;
}
function similarity(a, b) {
  const sa = bigrams(a), sb = bigrams(b);
  if (sa.size === 0 || sb.size === 0) return 0;
  let inter = 0;
  sa.forEach(x => { if (sb.has(x)) inter++; });
  return inter / (sa.size + sb.size - inter);
}
function extractNumbers(t) {
  const s = stripHtml(t).replace(/,/g, '');
  const nums = s.match(/\d+(\.\d+)?/g) || [];
  return new Set(nums.filter(n => n.length >= 2));
}
function numOverlap(a, b) {
  const na = extractNumbers(a), nb = extractNumbers(b);
  if (na.size === 0 || nb.size === 0) return null;
  let inter = 0;
  na.forEach(x => { if (nb.has(x)) inter++; });
  return inter / Math.min(na.size, nb.size);
}

// 日期窗口容差（天）：同事件不同来源常出现 1~3 天的日期差异
const DATE_WINDOW_DAYS = 4;

// 将 "MM.DD" 或跨日期 "MM.DD~DD" / "MM.DD~MM.DD" 解析为起始日的绝对天数序号（非闰年基准 2026）
function toDayIndex(dateStr) {
  const s = String(dateStr || '').split('~')[0].trim();
  const m = s.match(/^(\d{1,2})\.(\d{1,2})/);
  if (!m) return null;
  const mm = parseInt(m[1], 10), dd = parseInt(m[2], 10);
  if (!mm || !dd) return null;
  return Math.floor(Date.UTC(2026, mm - 1, dd) / 86400000);
}
function dateDiffDays(a, b) {
  const da = toDayIndex(a), db = toDayIndex(b);
  if (da === null || db === null) return Infinity;
  return Math.abs(da - db);
}
// diff: 两条新闻的日期相差天数。
// 数字重叠规则(numOverlap)门槛很松（如两条标题都出现"2026"这类泛化数字即可判重），
// 这在"同日期+同公司"场景下候选池很小、风险可控；但放宽到日期窗口后同公司候选池显著
// 变大（一周内同公司可能有多条完全不同主题的新闻），若继续对跨日期的两条新闻套用该
// 松规则，会把"办公楼建设"和"游戏更新公告"这类毫不相关的新闻误判为重复。
// 因此：跨日期(diff>0)比较只信标题相似度，数字重叠规则仅在同日期(diff===0)时生效。
function isDuplicate(a, b, diff = 0) {
  const sim = similarity(stripForCompare(a.title), stripForCompare(b.title));
  if (sim >= 0.4) return true;
  if (diff === 0) {
    const numOv = numOverlap(a.title, b.title);
    if (numOv !== null && numOv >= 0.5) return true;
  }
  return false;
}

// URL 规范化：去锚点、去追踪参数、去末尾斜杠，统一小写
function normalizeUrl(u) {
  if (!u) return '';
  return String(u)
    .split('#')[0]
    .split('?')[0]
    .replace(/\/+$/, '')
    .toLowerCase();
}

// 保留优先级：中文译文 > 中文字符多 > 标题长
function isBetterThan(a, b) {
  const aFallback = a.translationStatus === 'fallback' ? 1 : 0;
  const bFallback = b.translationStatus === 'fallback' ? 1 : 0;
  if (aFallback !== bFallback) return aFallback < bFallback;

  const zh = t => (stripHtml(t).match(/[\u4e00-\u9fff]/g) || []).length;
  const aZh = zh(a.title), bZh = zh(b.title);
  if (aZh !== bZh) return aZh > bZh;

  return stripHtml(a.title).length > stripHtml(b.title).length;
}

// 并查集
class UnionFind {
  constructor(n) { this.parent = Array.from({ length: n }, (_, i) => i); }
  find(x) { while (this.parent[x] !== x) x = this.parent[x] = this.parent[this.parent[x]]; return x; }
  union(a, b) { const ra = this.find(a), rb = this.find(b); if (ra !== rb) this.parent[ra] = rb; }
}

function dedupeArrayPair(events, industryNews) {
  const tagged = [];
  events.forEach((e, i) => tagged.push({ ...e, _src: 'events', _idx: i }));
  industryNews.forEach((e, i) => tagged.push({ ...e, _src: 'industryNews', _idx: i }));

  // 按公司分组（日期窗口判重在组内两两比较时再做，见下方规则1循环）
  const byCompany = {};
  tagged.forEach((e, globalIdx) => {
    if (!e.date) return;
    const key = e.company || '';
    if (!byCompany[key]) byCompany[key] = [];
    byCompany[key].push(globalIdx);
  });

  const uf = new UnionFind(tagged.length);
  let dupPairCount = 0;

  // ===== 规则 0：URL 相同直接判重（跨日期、跨公司、跨译文均生效）=====
  const byUrl = {};
  tagged.forEach((e, globalIdx) => {
    const u = normalizeUrl(e.url);
    if (!u) return;
    if (!byUrl[u]) byUrl[u] = [];
    byUrl[u].push(globalIdx);
  });
  let urlDupGroups = 0;
  Object.values(byUrl).forEach(indices => {
    if (indices.length < 2) return;
    urlDupGroups++;
    for (let i = 1; i < indices.length; i++) {
      uf.union(indices[0], indices[i]);
      dupPairCount++;
    }
  });

  Object.values(byCompany).forEach(indices => {
    if (indices.length < 2) return;
    for (let i = 0; i < indices.length; i++) {
      for (let j = i + 1; j < indices.length; j++) {
        const a = tagged[indices[i]], b = tagged[indices[j]];
        const diff = dateDiffDays(a.date, b.date);
        if (diff > DATE_WINDOW_DAYS) continue;
        if (isDuplicate(a, b, diff)) {
          uf.union(indices[i], indices[j]);
          dupPairCount++;
        }
      }
    }
  });

  // 按聚类分组，每组保留标题最长的一条
  const clusters = {};
  tagged.forEach((_, idx) => {
    const root = uf.find(idx);
    if (!clusters[root]) clusters[root] = [];
    clusters[root].push(idx);
  });

  const keepGlobalIdx = new Set();
  let removedCount = 0;
  Object.values(clusters).forEach(idxs => {
    if (idxs.length === 1) {
      keepGlobalIdx.add(idxs[0]);
      return;
    }
    // 多条聚类 -> 按"中文译文 > 中文字符多 > 标题长"选出最优的一条
    let best = idxs[0];
    for (const idx of idxs) {
      if (isBetterThan(tagged[idx], tagged[best])) best = idx;
    }
    keepGlobalIdx.add(best);
    removedCount += idxs.length - 1;
  });

  const newEvents = [];
  const newIndustryNews = [];
  tagged.forEach((e, globalIdx) => {
    if (!keepGlobalIdx.has(globalIdx)) return;
    const clean = { ...e };
    delete clean._src;
    delete clean._idx;
    if (e._src === 'events') newEvents.push(clean);
    else newIndustryNews.push(clean);
  });

  return { newEvents, newIndustryNews, dupPairCount, removedCount, urlDupGroups };
}

function main() {
  const content = JSON.parse(readFileSync(CONTENT_FILE, 'utf8'));
  const { newEvents, newIndustryNews, dupPairCount, removedCount, urlDupGroups } = dedupeArrayPair(
    content.events || [],
    content.industryNews || []
  );

  console.log(`原始: events=${content.events.length}, industryNews=${content.industryNews.length}`);
  console.log(`URL 相同的重复组: ${urlDupGroups}`);
  console.log(`检测到重复对: ${dupPairCount}`);
  console.log(`清理后: events=${newEvents.length}, industryNews=${newIndustryNews.length}（移除 ${removedCount} 条重复）`);

  content.events = newEvents;
  content.industryNews = newIndustryNews;

  writeFileSync(CONTENT_FILE, JSON.stringify(content, null, 2), 'utf8');
  console.log('已写回', CONTENT_FILE);
}

main();
