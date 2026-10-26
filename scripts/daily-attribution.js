(function (root) {
  'use strict';

  const MARKET_OF = Object.freeze({
    '462870': 'KOSPI', '036570': 'KOSPI', '251270': 'KOSPI',
    '259960': 'KOSPI', '225570': 'KOSDAQ', '263750': 'KOSDAQ',
  });
  const plain = value => String(value ?? '').replace(/<[^>]*>/g, '').trim();
  const escapeHTML = value => String(value).replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[c]);
  function number(value) {
    if (value == null || String(value).trim() === '') return NaN;
    return Number(String(value).replace(/[,％%+]/g, ''));
  }
  const bp = value => Math.round(number(value) * 100);
  const percent = value => `${number(value) > 0 ? '+' : ''}${number(value).toFixed(2)}%`;
  function dayStamp(key) {
    if (!/^\d{8}$/.test(String(key))) return NaN;
    const y = Number(key.slice(0, 4)), m = Number(key.slice(4, 6)), d = Number(key.slice(6));
    const date = new Date(Date.UTC(y, m - 1, d));
    return date.getUTCFullYear() === y && date.getUTCMonth() === m - 1 && date.getUTCDate() === d
      ? date.getTime() : NaN;
  }
  function newsDate(entry, asOfDate) {
    if (entry.publishedAt) {
      const date = new Date(entry.publishedAt);
      if (Number.isFinite(date.getTime())) {
        return new Date(date.getTime() + 9 * 3600000).toISOString().slice(0, 10).replace(/-/g, '');
      }
    }
    const raw = String(entry.date || '');
    if (/^\d{8}$/.test(raw)) return Number.isFinite(dayStamp(raw)) ? raw : '';
    if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return raw.replace(/-/g, '');
    if (!/^\d{2}\.\d{2}$/.test(raw)) return '';
    let year = Number(asOfDate.slice(0, 4));
    const mmdd = raw.replace('.', '');
    if (asOfDate.slice(4, 6) === '01' && raw.startsWith('12.')) year--;
    const key = `${year}${mmdd}`;
    return Number.isFinite(dayStamp(key)) ? key : '';
  }
  function newsKind(entry) {
    const t = plain(entry.title);
    if (/预览版|语言模型|LLM|Raon|联动|周年|庆典|阵容|PvP|内容更新|版本更新|系统优化|裂缝|招聘|ESG|获奖|网吧/.test(t)) return 'soft';
    if (/财报|业绩|利润|盈利|目标价|回购|并购|收购|发行协议/.test(t)) return 'material';
    if (/角色|用户|销量|营收|收入|留存|在线人数/.test(t) && /\d[\d,.]*\s*(?:万|亿|个|名|人|份|套|韩元|美元|%)/.test(t)) return 'operating';
    if (/推出|上线|上市|发售|开服/.test(t) && !/将|即将|预计|定档|预告|预约|试玩|重发|再次/.test(t)) return 'launch';
    return 'background';
  }
  function selectRecentNews(entries, asOfDate, limit = 6) {
    const asOf = dayStamp(asOfDate);
    const seen = new Set();
    return entries.map(entry => ({ ...entry, title: plain(entry.title), dateKey: newsDate(entry, asOfDate) }))
      .filter(entry => {
        const age = (asOf - dayStamp(entry.dateKey)) / 86400000;
        const quantitative = /\d[\d,.]*\s*(?:%|万|亿|分钟|阶段|席|韩元|美元)/.test(entry.title);
        const evidenceReady = entry.rawTitle && entry.source && entry.url && Number.isFinite(Date.parse(entry.publishedAt))
          && !translationIssues(entry.rawTitle, entry.title).length;
        return Number.isFinite(age) && age >= 0 && age <= 3 && entry.title && entry.translationStatus !== 'fallback'
          && (!quantitative || evidenceReady);
      })
      .sort((a, b) => b.dateKey.localeCompare(a.dateKey))
      .filter(entry => {
        const id = entry.url || `${entry.dateKey}:${entry.title}`;
        if (seen.has(id)) return false;
        seen.add(id);
        return true;
      })
      .slice(0, limit)
      .map(entry => ({ ...entry, kind: newsKind(entry), dateEvidence: entry.publishedAt ? 'publication' : 'legacy' }));
  }
  function context(code, dailyPct, indices) {
    const market = MARKET_OF[code];
    const primary = (indices || []).find(i => (i.code || i.name) === market);
    const indexPct = number(primary?.pct ?? primary?.changePercent);
    const stockPct = number(dailyPct);
    const diffBp = bp(stockPct) - bp(indexPct);
    return { code, market, stockPct, indexPct, diffBp, comparable: Number.isFinite(diffBp) };
  }
  function relativeText(ctx) {
    if (!ctx.comparable) return '所属指数数据不完整，暂不判断相对强弱。';
    if (ctx.diffBp === 0) return `涨跌幅与${ctx.market}一致。`;
    if (ctx.stockPct < 0 && ctx.indexPct < 0 && ctx.diffBp > 0) return `跌幅小于${ctx.market}，表现相对抗跌。`;
    if (ctx.stockPct > 0 && ctx.indexPct > 0 && ctx.diffBp < 0) return `涨幅低于${ctx.market}，相对表现偏弱。`;
    return `表现${ctx.diffBp > 0 ? '高' : '低'}于${ctx.market}${Math.abs(ctx.diffBp) < 30 ? '，幅度较小' : ''}。`;
  }
  function marketLink(ctx) {
    if (!ctx.comparable) return '当日独立驱动尚不明确，不能仅凭涨跌倒推原因。';
    if (ctx.stockPct === 0) return `股价当日持平；${relativeText(ctx)}`;
    if (ctx.stockPct * ctx.indexPct > 0) {
      return `股价与${ctx.market}（<strong>${percent(ctx.indexPct)}</strong>）${ctx.stockPct > 0 ? '同向回升' : '同向回调'}；${relativeText(ctx)}`;
    }
    return `股价与${ctx.market}（<strong>${percent(ctx.indexPct)}</strong>）走势不同，独立驱动尚不明确；${relativeText(ctx)}`;
  }
  function fallback(ctx, companyNews = []) {
    const news = companyNews.find(n => ['launch', 'operating', 'material'].includes(n.kind || newsKind(n)))
      || companyNews.find(n => /预览|语言模型|LLM|Raon/.test(plain(n.title))) || companyNews[0];
    if (!news) return `未找到可核实的当日公司专属重大消息。${marketLink(ctx)}`;
    const kind = news.kind || newsKind(news);
    const title = escapeHTML(plain(news.title).replace(/[。；!?！？]+$/, ''));
    const prefix = news.dateEvidence === 'publication' ? `${news.dateKey.slice(4, 6)}月${news.dateKey.slice(6)}日报道：` : '近期公开报道：';
    const caveat = kind === 'soft' ? '属于常规运营或营销型背景，业绩贡献暂难量化，不能据此认定为强催化。'
      : kind === 'launch' ? '产品上线是公司层面的增量消息，实际收入贡献仍待观察。'
      : kind === 'operating' ? '该运营数据可供参考，但不直接等同于收入或持续增长。'
      : '该消息提供公司层面背景，其对当日交易的实际影响尚难确认。';
    return `${prefix}${title}。${caveat}${marketLink(ctx)}`;
  }
  function validate(text, ctx, news = []) {
    const t = plain(text);
    const issues = [];
    const evidence = news.map(n => plain(n.title)).join('\n');
    if (!t) issues.push('empty');
    if (/<(?!\/?strong>)[^>]*>/i.test(text) || /[가-힣]/.test(t)) issues.push('format');
    if (/兑现|获利了结|已.{0,6}消化|提前反映|资金回流|资金回补|机构资金|外资|净卖出|净买入|虹吸|资金轮动|超跌|V形|V型/.test(t)) issues.push('unsupported-causality');
    if (/(六家|标的|板块).{0,10}(普涨|普跌|全线|多数).{0,20}(带动|导致|驱动|提振|拖累)|领涨|表现最强|排名第一/.test(t)) issues.push('circular-or-ranking');
    if (ctx.comparable) {
      const weaker = /弱于|低于.{0,8}(指数|KOSPI|KOSDAQ)|跑输|涨幅低于|跌幅大于/.test(t);
      const stronger = /跑赢|高于.{0,8}(指数|KOSPI|KOSDAQ)|强于KOS|涨幅高于|跌幅小于|相对抗跌/.test(t);
      if ((ctx.diffBp > 0 && weaker) || (ctx.diffBp < 0 && stronger) || (ctx.diffBp === 0 && (weaker || stronger))) issues.push('relative-direction');
      if (ctx.diffBp > 0 && ctx.stockPct < 0 && /重挫|难敌|系统性抛压主导|压倒性/.test(t)) issues.push('exaggeration');
      if (ctx.stockPct * ctx.indexPct <= 0 && /随市|随大盘|大盘.{0,8}(带动|拖累)/.test(t)) issues.push('market-direction');
      const other = ctx.market === 'KOSPI' ? 'KOSDAQ' : 'KOSPI';
      if (new RegExp(`${other}.{0,18}(带动|拖累|主因|基准)`).test(t)) issues.push('wrong-benchmark');
      for (const match of t.matchAll(/(KOSPI|KOSDAQ)[^\d+\-]{0,8}([+\-]?\d+(?:\.\d+)?)%/g)) {
        const down = /下跌|回落|跌/.test(match[0]);
        const up = /上涨|涨/.test(match[0]);
        const value = down ? -Math.abs(number(match[2])) : number(match[2]);
        if (match[1] === ctx.market && (bp(value) !== bp(ctx.indexPct) || (up && value < 0))) issues.push('index-number');
      }
    }
    const onlySoft = !news.some(n => ['launch', 'material', 'operating'].includes(n.kind || newsKind(n)));
    if (onlySoft && /强催化|多重催化|共同提振|利好提振|驱动上涨|主因是.{0,12}(更新|联动)/.test(t) && !/不能|不宜|不得|并非/.test(t)) issues.push('soft-as-strong');
    if (/角色/.test(evidence) && !/用户|玩家/.test(evidence) && /\d[\d,.]*\s*万?\s*(用户|玩家)/.test(t)) issues.push('character-user-unit');
    const quantities = s => [...s.replace(/,/g, '').matchAll(/\d+(?:\.\d+)?\s*(?:亿|万)?\s*(?:个|名|人|席|份|套|阶段|分钟|韩元|美元|用户|玩家|角色)/g)].map(m => m[0].replace(/\s/g, ''));
    const allowed = quantities(evidence);
    for (const q of quantities(t)) if (!allowed.includes(q)) issues.push('unsupported-quantity');
    return [...new Set(issues)];
  }
  function complete(text, ctx) {
    return /相对抗跌|涨幅低于|跌幅小于|弱于|强于|跑赢|跑输|表现[高低]于|一致|数据不完整/.test(plain(text))
      ? text : `${text.replace(/[。；\s]+$/, '')}；${relativeText(ctx)}`;
  }
  function marketBackground(snapshot, previous) {
    const indices = (snapshot?.indices || []).filter(i => ['KOSPI', 'KOSDAQ'].includes(i.code || i.name) && Number.isFinite(number(i.changePercent)));
    if (!indices.length) return '';
    const date = String(snapshot.meta?.date || '');
    const label = /^\d{8}$/.test(date) ? `${Number(date.slice(4, 6))}月${Number(date.slice(6))}日` : '当日';
    const parts = indices.map(i => `${i.code || i.name}${number(i.changePercent) > 0 ? '上涨' : number(i.changePercent) < 0 ? '下跌' : '持平'}<strong>${percent(i.changePercent)}</strong>`);
    const prev = previous?.indices || [];
    const rebound = indices.length === 2 && indices.every(i => number(i.changePercent) > 0 && number(prev.find(p => (p.code || p.name) === (i.code || i.name))?.changePercent) < 0);
    return `${label}韩国股市收盘，${parts.join('、')}。${rebound ? '两指数在前一交易日下跌后回升，属于收盘层面的反弹。' : '以上为当日收盘市场背景。'}仅凭收盘行情不能确认盘中反转、资金流向或宏观事件的影响。`;
  }
  function translationIssues(rawTitle, translatedTitle) {
    const raw = plain(rawTitle), translated = plain(translatedTitle);
    const issues = [];
    const digits = s => [...s.replace(/,/g, '').matchAll(/\d+(?:\.\d+)?/g)].map(m => Number(m[0]));
    const allowed = digits(raw);
    if (digits(translated).some(n => !allowed.includes(n))) issues.push('changed-number');
    if (/캐릭터|角色/.test(raw) && !/유저|이용자|사용자|플레이어|用户|玩家/.test(raw) && /用户|玩家/.test(translated)) issues.push('character-user-unit');
    return issues;
  }
  const api = { MARKET_OF, plain, number, dayStamp, newsDate, newsKind, selectRecentNews, context, relativeText, marketLink, fallback, validate, complete, marketBackground, translationIssues };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.DailyAttribution = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
