// 专名归一 / 拼写防线（共享模块）
//
// 背景（2026-09-21）：Nexon Games 新作《Pareidolia》（原代号 Project RX）在看板
// 个股驱动因素与多条资讯标题里被写成《Paradolia》。根因是翻译环节缺少统一的
// 专名校正——fetch-news.mjs 只有"免费机翻"分支调用了品牌归一化，AI 翻译分支
// （DeepSeek）直接返回译文，于是韩媒标题里的正确拼写被"创造性"改错；随后
// generate-analysis.mjs 把这些标题当作白名单素材喂给 LLM，错拼被复述进分析文案。
//
// 本模块提供三层能力，供 fetch-news / generate-analysis / validate-data 共用：
//   1. SPELLING_FIXES  已知错拼 → 正确写法（人工维护，命中即改）
//   2. BRAND_ALIASES  机翻常见中文别名 → 项目通用写法（沿用原 BRAND_NORMALIZE）
//   3. alignProperNouns() 原文锚定校正：译文里"原文不存在的拉丁词"若与原文某个
//      拉丁词编辑距离很近，判定为错拼并回改为原文拼写。这条规则不依赖词典，
//      因此未来出现词典未收录的新作品名时也能自动纠正。
//
// 约定（沿用 BRAND_NORMALIZE 的教训）：BRAND_ALIASES 只收"歧义极低"的映射。
// 诸如「移位/换档/上移」这类词在普通句子里也会自然出现（如"股价上移"），
// 一旦纳入映射会把正常句子改坏，故一律不收。

// ===== 1. 已知错拼修正表（新增错拼时在此追加，validate-data 会自动告警）=====
export const SPELLING_FIXES = [
  [/Paradolia/gi, 'Pareidolia'],
  // NCSoft 新作《Astrae Oratio》（简称 AsOla）：2026-09-22 的资讯标题与分析文案被
  // 写成《Asura》（同一作品在 9/17、9/18 均写作 Astrae Oratio）。Asura（阿修罗）
  // 本身是常见词，故只在书名号内限定替换，避免误伤正常语句。
  [/《Asura》/g, '《Astrae Oratio》'],
];

// ===== 2. 机翻中文别名 → 项目通用写法 =====
export const BRAND_ALIASES = [
  [/网石游戏|网石/g, 'Netmarble'],
  [/珍珠深渊|珍珠阿比斯|珀尔阿比斯/g, 'Pearl Abyss'],
  [/奈克森|耐克森/g, 'Nexon'],
  [/恩西软件|NC ?soft/gi, 'NCSoft'],
  [/克拉夫顿|克拉夫特顿/g, 'Krafton'],
  [/绝地求生|战地求生/g, 'PUBG'],
  [/胜利女神：?妮姬|妮姬/g, 'NIKKE'],
  [/星刃/g, 'Stellar Blade(剑星)'],
  [/赤红沙漠|红色沙漠|绯红沙漠/g, 'Crimson Desert(红色沙漠)'],
  [/永恒之塔/g, 'Aion(永恒之塔)'],
  [/碧蓝档案|蓝色档案/g, 'Blue Archive(碧蓝档案)'],
  // 机翻常把 게임업계(游戏行业) 误译为"博彩业/赌博业"，需纠正
  [/博彩业|赌博业|赌博行业/g, '游戏行业'],
];

// 全部归一规则（顺序应用）
export const CANONICAL_TERMS = [...SPELLING_FIXES, ...BRAND_ALIASES];

// 注入 LLM / 翻译 prompt 的专名拼写表，减少"模型自行造词"的概率
export const TERM_GLOSSARY_LINES = [
  'Pareidolia（Nexon Games 新作，原代号 Project RX；正确拼写 P-a-r-e-i-d-o-l-i-a，不是 Paradolia）',
  'Astrae Oratio（NCSoft 二次元新作，简称 AsOla；不要写成 Asura 或 Astra）',
  'Blue Archive（碧蓝档案）',
  'NIKKE（胜利女神：妮姬）',
  'Stellar Blade（剑星）',
  'Crimson Desert（红色沙漠）',
  'Aion（永恒之塔）',
  'PUBG（绝地求生）',
  'NCSoft / Netmarble / Krafton / Pearl Abyss / Nexon Games',
];

export function glossaryBlock() {
  return TERM_GLOSSARY_LINES.map((l) => `- ${l}`).join('\n');
}

/** 按 CANONICAL_TERMS 顺序应用全部归一/修正规则 */
export function applyCanonicalTerms(text) {
  let out = text == null ? '' : String(text);
  if (!out) return out;
  for (const [pattern, replacement] of CANONICAL_TERMS) {
    out = out.replace(pattern, replacement);
  }
  return out;
}

/** 返回文本中命中的已知错拼（原文片段数组），供校验脚本告警 */
export function findTermTypos(text) {
  const s = text == null ? '' : String(text);
  if (!s) return [];
  const hits = [];
  for (const [pattern] of SPELLING_FIXES) {
    const re = new RegExp(pattern.source, pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`);
    for (const m of s.matchAll(re)) hits.push(m[0]);
  }
  return [...new Set(hits)];
}

// ---------- 原文锚定校正（不依赖词典的通用防线）----------

const LATIN_TOKEN_RE = /[A-Za-z][A-Za-z0-9'’.\-]{3,}/g;

// 常见英文词：译文里出现、原文没有，也不该被"回锚"改写
// （如原文 Update → 译文 Updated，距离 1 但属正常词形变化）
const COMMON_WORDS = new Set([
  'update', 'updated', 'updates', 'release', 'released', 'releases', 'launch', 'launched',
  'official', 'officially', 'global', 'announce', 'announced', 'announcement', 'reveal',
  'revealed', 'trailer', 'teaser', 'event', 'events', 'showcase', 'interview', 'preview',
  'version', 'server', 'servers', 'client', 'mobile', 'console', 'consoles', 'online',
  'offline', 'beta', 'closed', 'open', 'opening', 'free', 'first', 'second', 'third',
  'world', 'series', 'studio', 'studios', 'game', 'games', 'company', 'report', 'reports',
  'sales', 'revenue', 'record', 'records', 'chart', 'charts', 'rank', 'ranking', 'number',
  'million', 'billion', 'users', 'player', 'players', 'content', 'service', 'services',
  'platform', 'platforms', 'schedule', 'scheduled', 'summer', 'winter', 'spring', 'autumn',
  'season', 'festival', 'expo', 'award', 'awards', 'price', 'stock', 'shares', 'market',
  'korea', 'korean', 'japan', 'japanese', 'tokyo', 'seoul', 'exhibition', 'conference',
  'develop', 'developer', 'developers', 'development', 'confirmed', 'confirm', 'digital',
  'physical', 'package', 'edition', 'standard', 'deluxe', 'limited', 'special',
  'collaboration', 'original', 'soundtrack', 'character', 'characters', 'story', 'chapter',
  'episode', 'test', 'testing', 'stream', 'streaming', 'video', 'image', 'images',
]);

function latinTokens(s) {
  return [...String(s || '').matchAll(LATIN_TOKEN_RE)].map((m) => m[0]);
}

/** 编辑距离（超过 cap 提前返回，避免无谓开销） */
function levenshtein(a, b, cap = 3) {
  if (a === b) return 0;
  if (Math.abs(a.length - b.length) > cap) return cap + 1;
  let prev = new Array(b.length + 1);
  let cur = new Array(b.length + 1);
  for (let j = 0; j <= b.length; j++) prev[j] = j;
  for (let i = 1; i <= a.length; i++) {
    cur[0] = i;
    let rowMin = cur[0];
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
      if (cur[j] < rowMin) rowMin = cur[j];
    }
    if (rowMin > cap) return cap + 1;
    const tmp = prev; prev = cur; cur = tmp;
  }
  return prev[b.length];
}

/**
 * 把译文中的拉丁专名"回锚"到原文拼写。
 *
 * 规则：译文里长度 ≥5 的拉丁词，若原文中不存在同形词、且能找到编辑距离 ≤2
 * （短词 ≤1）且首字母相同的原文拉丁词，则判定为错拼，回改为原文拼写。
 * 典型命中：Paradolia → Pareidolia。
 *
 * @param {string} rawTitle 原文（韩语/英语）标题
 * @param {string} translatedTitle 译文标题
 * @returns {string} 校正后的译文
 */
export function alignProperNouns(rawTitle, translatedTitle) {
  const zh = String(translatedTitle || '');
  const raw = String(rawTitle || '');
  if (!zh || !raw) return zh;

  const rawTokens = latinTokens(raw);
  if (rawTokens.length === 0) return zh;
  const rawLower = new Set(rawTokens.map((t) => t.toLowerCase()));

  const candidates = [...new Set(latinTokens(zh))].filter((t) => t.length >= 5);
  let out = zh;
  const fixes = [];

  for (const cand of candidates) {
    const cl = cand.toLowerCase();
    if (rawLower.has(cl)) continue;              // 原文已有同形词 -> 正常
    if (COMMON_WORDS.has(cl)) continue;          // 常见英文词 -> 不改写
    if (/^\d/.test(cand)) continue;              // 数字/日期类 -> 不改写

    const cap = cand.length <= 6 ? 1 : 2;
    let best = null;
    let bestDist = Infinity;
    for (const rt of rawTokens) {
      if (rt.length < 5) continue;
      if (rt[0].toLowerCase() !== cl[0]) continue;   // 首字母不同 -> 多半不是同一专名
      const d = levenshtein(cl, rt.toLowerCase(), cap);
      if (d <= cap && d < bestDist) {
        best = rt;
        bestDist = d;
      }
    }
    if (!best) continue;
    out = out.split(cand).join(best);
    fixes.push(`${cand} → ${best}`);
  }

  if (fixes.length) {
    console.log(`  🔤 专名回锚: ${fixes.join('，')}`);
  }
  return out;
}
