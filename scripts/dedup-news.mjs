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
 *   以下规则在"同日期+同公司"分组内生效（用于无 URL 的人工条目）：
 *   1. 去除数字/标点后的中文字符 bigram 相似度 >= 0.4
 *   2. 提取的关键数字（百分比/点位等，≥2位）重叠比例 >= 0.5（如果双方都有数字特征）
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
function isDuplicate(a, b) {
  const sim = similarity(stripForCompare(a.title), stripForCompare(b.title));
  if (sim >= 0.4) return true;
  const numOv = numOverlap(a.title, b.title);
  if (numOv !== null && numOv >= 0.5) return true;
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

  const byDateCompany = {};
  tagged.forEach((e, globalIdx) => {
    if (!e.date) return;
    // 注意：跨日期范围（如"07.09~10"）字符串完全相同时也应参与判重——
    // 实测发现同一跨日期事件也会被同时写入 events 和 industryNews 两个数组
    const key = e.date + '|' + e.company;
    if (!byDateCompany[key]) byDateCompany[key] = [];
    byDateCompany[key].push(globalIdx);
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

  Object.values(byDateCompany).forEach(indices => {
    if (indices.length < 2) return;
    for (let i = 0; i < indices.length; i++) {
      for (let j = i + 1; j < indices.length; j++) {
        if (isDuplicate(tagged[indices[i]], tagged[indices[j]])) {
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
