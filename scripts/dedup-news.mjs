#!/usr/bin/env node
/**
 * 一次性数据清理脚本：去除 content.json 中 events/industryNews 的重复新闻
 *
 * 问题背景：历史上同一天同一公司的同一事件常被同时写入 events 和 industryNews
 * 两个数组（措辞略有差异），导致 index.html 的"游戏公司相关资讯"表格合并两个
 * 数组后展示了大量重复内容，挤占了固定10条的展示位。
 *
 * 判重规则（同日期+同公司分组内，任一条件满足视为重复）：
 *   1. 去除数字/标点后的中文字符 bigram 相似度 >= 0.4
 *   2. 提取的关键数字（百分比/点位等，≥2位）重叠比例 >= 0.5（如果双方都有数字特征）
 *
 * 聚类方式：并查集（Union-Find），避免同组内既有重复对、又有不同事件时的误判
 * （如 06.09 Shift Up 组：3条中2条重复+1条完全不同的 Nintendo Direct 新闻）
 *
 * 保留策略：每个重复聚类保留标题最长（信息最完整）的一条
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
    // 多条聚类 -> 保留标题最长的一条
    let best = idxs[0];
    for (const idx of idxs) {
      if (stripHtml(tagged[idx].title).length > stripHtml(tagged[best].title).length) best = idx;
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

  return { newEvents, newIndustryNews, dupPairCount, removedCount };
}

function main() {
  const content = JSON.parse(readFileSync(CONTENT_FILE, 'utf8'));
  const { newEvents, newIndustryNews, dupPairCount, removedCount } = dedupeArrayPair(
    content.events || [],
    content.industryNews || []
  );

  console.log(`原始: events=${content.events.length}, industryNews=${content.industryNews.length}`);
  console.log(`检测到重复对: ${dupPairCount}`);
  console.log(`清理后: events=${newEvents.length}, industryNews=${newIndustryNews.length}（移除 ${removedCount} 条重复）`);

  content.events = newEvents;
  content.industryNews = newIndustryNews;

  writeFileSync(CONTENT_FILE, JSON.stringify(content, null, 2), 'utf8');
  console.log('已写回', CONTENT_FILE);
}

main();
