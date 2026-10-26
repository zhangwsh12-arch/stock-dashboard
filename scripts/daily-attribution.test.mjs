import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import rules from './daily-attribution.js';
import { generateDailyAll, getDayNews } from './generate-analysis.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const indices = (kospi, kosdaq) => [{ name: 'KOSPI', changePercent: kospi }, { name: 'KOSDAQ', changePercent: kosdaq }];
const c = (code, pct, kp = -1.46, kq = -3.26) => rules.context(code, pct, indices(kp, kq));
const news = (title, date = '10.26', extra = {}) => ({ title, date, ...extra });

test('市场归属及精确基点，不吞掉0.14pp或0.33pp', () => {
  assert.equal(c('462870', 3.3, 2.05, 4.46).market, 'KOSPI');
  assert.equal(c('251270', -1.32).diffBp, 14);
  assert.equal(c('259960', -1.13).diffBp, 33);
  assert.match(rules.relativeText(c('251270', -1.32)), /相对抗跌/);
  assert.equal(c('263750', 1.95, 1.76, 1.78).diffBp, 17);
  assert.equal(c('225570', 2.03, 2.05, 4.46).market, 'KOSDAQ');
});

test('软营销不能升级，正式新品与运营数据分类独立', () => {
  assert.equal(rules.newsKind(news('《剑星》联动上线时间与角色阵容公开')), 'soft');
  assert.equal(rules.newsKind(news('Raon-1 mini语言模型预览版公开')), 'soft');
  assert.equal(rules.newsKind(news('NC当日正式推出手游《星球大破坏喵喵喵》')), 'launch');
  assert.equal(rules.newsKind(news('《Aion 2》累计创建角色超过630万个')), 'operating');
  assert.equal(rules.newsKind(news('NC《Aion 2》获好评，用户谈游戏魅力')), 'background');
  assert.equal(rules.newsKind(news('券商下调盈利预测和目标价')), 'material');
});

test('跨月周末、跨年、未来消息和发布时间KST转换', () => {
  const entries = [news('周末新增', '10.31'), news('太早', '10.28'), news('未来', '11.03')];
  assert.deepEqual(rules.selectRecentNews(entries, '20261102').map(n => n.title), ['周末新增']);
  assert.equal(rules.newsDate(news('跨年', '12.31'), '20270102'), '20261231');
  assert.equal(rules.newsDate(news('完整日期', '10.26', { publishedAt: '2026-10-25T16:00:00Z' }), '20261026'), '20261026');
  assert.equal(rules.selectRecentNews([news('去年的完整旧闻', '10.26', { publishedAt: '2025-10-26T00:00:00Z' })], '20261026').length, 0);
  assert.equal(rules.selectRecentNews([news('无效日期', '02.30')], '20260301').length, 0);
});

test('去重和排序在截取之前，消息增量不因同一游戏被删除', () => {
  const entries = [news('官宣联动', '10.23'), news('公布角色阵容', '10.25'), news('新作发布', '10.26')];
  assert.deepEqual(rules.selectRecentNews(entries, '20261026', 2).map(n => n.title), ['新作发布', '公布角色阵容']);
  assert.equal(rules.selectRecentNews([news('同一稿', '10.25', { url: 'https://example.test/a' }), news('译文不同', '10.26', { url: 'https://example.test/a' })], '20261026').length, 1);
});

test('未核对数值不作为素材，优先技术产品背景', () => {
  assert.equal(rules.selectRecentNews([news('PUBG使用时长增长17.5%')], '20261026').length, 0);
  const verified = news('角色630万个', '10.26', { rawTitle: '캐릭터 630만', source: '公开新闻', url: 'https://example.test/metrics', publishedAt: '2026-10-26T00:00:00Z' });
  assert.equal(rules.selectRecentNews([verified], '20261026').length, 1);
  const selected = rules.selectRecentNews([news('近期营销背景'), news('公开自研LLM Raon-1 mini预览', '10.25')], '20261026');
  assert.match(rules.fallback(c('259960', -1.13), selected), /Raon-1 mini/);
});

test('拒绝错误指数、数字、相对强弱及循环归因', () => {
  const ctx = c('462870', 3.3, 2.05, 4.46);
  assert.ok(rules.validate('KOSDAQ大涨带动股价上涨', ctx).includes('wrong-benchmark'));
  assert.ok(rules.validate('KOSPI上涨2.15%', ctx).includes('index-number'));
  assert.ok(rules.validate('六家标的普涨带动上涨', ctx).includes('circular-or-ranking'));
  assert.ok(rules.validate('跌幅大于KOSPI', c('251270', -1.32)).includes('relative-direction'));
  assert.ok(rules.validate('表现低于KOSPI', c('251270', -1.32)).includes('relative-direction'));
  assert.deepEqual(rules.validate('KOSPI下跌1.46%，股价相对抗跌。', c('251270', -1.32)), []);
  assert.ok(rules.validate('KOSPI上涨-1.46%', c('251270', -1.32)).includes('index-number'));
  assert.ok(rules.validate('难敌系统性抛压主导盘面', c('259960', -1.13)).includes('exaggeration'));
  assert.ok(rules.validate('随市回升', c('225570', -0.52, 1.76, 1.78)).includes('market-direction'));
});

test('禁用无证据兑现、资金行为，软催化不过度归因', () => {
  const ctx = c('462870', -2.64);
  for (const t of ['利好已在前期兑现', '利空已被市场消化', '机构资金回补', '超跌修复', '前期获利了结']) {
    assert.ok(rules.validate(t, ctx).includes('unsupported-causality'));
  }
  assert.ok(rules.validate('联动利好提振股价', ctx, [news('联动更新')]).includes('soft-as-strong'));
});

test('数字和角色/用户口径从翻译到正文双重校验', () => {
  const entry = news('《Aion 2》累计创建角色超过630万个');
  assert.ok(rules.validate('630万用户', c('036570', -1.71), [entry]).includes('character-user-unit'));
  assert.ok(rules.validate('销量达700万份', c('036570', -1.71), [entry]).includes('unsupported-quantity'));
  assert.deepEqual(rules.translationIssues('캐릭터 630만', '累计创建角色630万个'), []);
  assert.ok(rules.translationIssues('캐릭터 630만', '630万用户').includes('character-user-unit'));
  assert.ok(rules.translationIssues('630만', '700万').includes('changed-number'));
});

test('安全模板与模型正文共用校验；不按空格截断作品名', () => {
  const ctx = c('259960', -1.13);
  const selected = rules.selectRecentNews([news('Raon-1 mini预览版公开', '10.25')], '20261026');
  const text = rules.fallback(ctx, selected);
  assert.match(text, /Raon-1 mini/);
  assert.match(text, /相对抗跌/);
  assert.deepEqual(rules.validate(text, ctx, selected), []);
  assert.ok(rules.validate('<strong onclick="alert(1)">错误</strong>', ctx).includes('format'));
  assert.match(rules.fallback(c('225570', -1.1, 1.76, 1.78)), /走势不同，独立驱动尚不明确/);
  assert.match(rules.fallback(c('251270', -1.32, NaN, NaN)), /数据不完整|不能仅凭/);
});

test('市场共同背景自动生成，但不猜盘中V形或机构回补', () => {
  const text = rules.marketBackground({ meta: { date: '20261019' }, indices: indices(1.76, 1.78) }, { indices: indices(-2.05, -4.46) });
  assert.match(text, /收盘层面的反弹/);
  assert.doesNotMatch(text, /机构资金回补|V形|V型|超跌/);
});

test('共享模块可在浏览器加载，不依赖Node', () => {
  const sandbox = {};
  vm.runInNewContext(fs.readFileSync(path.join(root, 'scripts/daily-attribution.js'), 'utf8'), sandbox);
  assert.equal(sandbox.DailyAttribution.MARKET_OF['462870'], 'KOSPI');
});

test('导入不写盘，已有人工个股及宏观文本与空值均保留', async () => {
  const file = path.join(root, 'data/content.json');
  const before = fs.readFileSync(file);
  const daily = Object.fromEntries(['su', '036570', '251270', '259960', '225570', '263750'].map(code => [code, { '20261026': code === 'su' ? null : '人工文案' }]));
  const result = await generateDailyAll('20261026', { analysis: { daily, dailyMacro: { '20261026': '人工宏观' } } }, undefined, { rulesOnly: true });
  assert.deepEqual(result.companies, {});
  assert.equal(result.macro, '人工宏观');
  const blank = await generateDailyAll('20261026', { analysis: { daily, dailyMacro: { '20261026': '' } } }, undefined, { rulesOnly: true });
  assert.equal(blank.macro, '');
  assert.deepEqual(fs.readFileSync(file), before);
  await assert.rejects(generateDailyAll('20261025', {}, undefined, { rulesOnly: true }), /缺少日期匹配/);
});

test('10/16、19、26历史回归：真实行情+人工文案不被覆盖', async () => {
  const content = JSON.parse(fs.readFileSync(path.join(root, 'data/content.json'), 'utf8'));
  for (const date of ['20261016', '20261019', '20261026']) {
    const snap = JSON.parse(fs.readFileSync(path.join(root, `data/${date}.json`), 'utf8'));
    const result = await generateDailyAll(date, content, undefined, { force: true, rulesOnly: true });
    const stocks = [{ code: '462870', name: 'Shift Up', change: snap.shiftUp.changePercent }, ...snap.companies];
    for (const stock of stocks) {
      const text = stock.code === '462870' ? result.su : result.companies[stock.code];
      if (!text) continue;
      const evidence = getDayNews(content, stock.name === 'NC' ? 'NCsoft' : stock.name, '', date).company;
      assert.deepEqual(rules.validate(text, rules.context(stock.code, stock.change, snap.indices), evidence), [], `${date}:${stock.code}`);
    }
  }
});
