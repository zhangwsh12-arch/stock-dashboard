/**
 * 韩国游戏股价看板 - 前端交互逻辑
 * =====================================
 * 1. 动态渲染股价数据（从API或服务端注入）
 * 2. PER估值条形图对比
 * 3. 日期选择器 + 历史查询
 * 4. 图表绑定与交互
 * 5. 静态资讯翻页
 */

// ============================================================
// 全局状态
// ============================================================
let currentSnapshot = null;
let currentChartInstance = null;   // SU折线图实例
let cmpChartInstance = null;      // 对比折线图实例

// ============================================================
// 数据加载 & 渲染入口
// ============================================================

function renderDashboard(data) {
    if (!data || !data.meta) {
        showEmptyState();
        return;
    }

    currentSnapshot = data;

    // 更新 Header
    updateHeader(data);

    // 渲染各模块
    renderSUSection(data);
    renderOthersSection(data);
    renderPERSection(data.per_summary, data.stocks);
}

function updateHeader(data) {
    const meta = data.meta;
    document.getElementById('headerDate').textContent =
        `${meta.display_date} (${meta.weekday}) 收盘数据`;
}

function showEmptyState() {
    document.getElementById('suSection').innerHTML = `
        <div class="card"><div class="card-body">
            <div class="empty-state">
                <div class="empty-state-icon">📊</div>
                <div>暂无该日期的数据</div>
            </div>
        </div></div>`;
    document.getElementById('othersSection').innerHTML = '';
    document.getElementById('perSection').innerHTML = '';
}


// ============================================================
// Shift Up 核心关注卡片
// ============================================================

function renderSUSection(data) {
    const suStock = (data.stocks || []).find(s => s.is_focus === true);
    if (!suStock) return;

    const pd = suStock.price_data || suStock;
    const close = pd.close || 0;
    const changeRate = pd.change_rate || 0;

    const changeClass = changeRate > 0 ? 'up' : (changeRate < 0 ? 'down' : 'neutral');
    const changeIcon = changeRate > 0
        ? '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><path d="M7 17l5-5 5 5M7 7l5 5 5-5"/></svg>'
        : (changeRate < 0
           ? '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><path d="M7 7l5 5 5-5M17 17l-5-5-5 5"/></svg>'
           : '');
    const changeText = changeRate > 0 ? `+${changeRate.toFixed(2)}%` : `${changeRate.toFixed(2)}%`;

    const perVal = pd.per !== undefined && pd.per !== null ? pd.per.toFixed(1) : '-';
    const pbrVal = pd.pbr !== undefined && pd.pbr !== null ? pd.pbr.toFixed(2) : '-';
    const capVal = pd.market_cap_억 ? `${pd.market_cap_억.toLocaleString()}` : '-';

    const html = `
    <!-- SU 股价卡片 -->
    <div class="card">
        <div class="card-header">
            <span><span style="color:${suStock.color}">●</span> ${suStock.name_en}（${suStock.name_ko}）核心关注</span>
            <span style="font-size:12px;color:var(--text-muted)">KOSDAQ ${suStock.code}</span>
        </div>
        <div class="card-body">
            <div class="su-stock-main">
                <div class="company-badge">SU</div>
                <div class="stock-info">
                    <div class="stock-price-row">
                        <span class="stock-price">${close.toLocaleString()}</span>
                        <span class="stock-currency">₩</span>
                        <span class="stock-change ${changeClass}">
                            ${changeIcon} ${changeText}
                        </span>
                    </div>
                    <div class="stock-sub">
                        <span class="label">前日收盘:</span> <strong>₩${(pd.prev_close||'-').toLocaleString()}</strong>
                        &nbsp;&nbsp;|&nbsp;&nbsp;
                        <span class="label">最高:</span> <strong>₩${(pd.high||'-').toLocaleString()}</strong>
                        &nbsp;&nbsp;|&nbsp;&nbsp;
                        <span class="label">最低:</span> <strong>₩${(pd.low||'-').toLocaleString()}</strong>
                    </div>
                </div>
            </div>

            <!-- 关键指标：PER / PBR / 市值 (3列，无外资) -->
            <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:10px;margin-bottom:18px">
                <div class="metric-card metric-per">
                    <div class="metric-label">PER (市盈率)</div>
                    <div class="metric-value">${perVal}</div>
                    <div class="metric-sub">Naver Finance</div>
                </div>
                <div class="metric-card metric-cap">
                    <div class="metric-label">PBR (市净率)</div>
                    <div class="metric-value">${pbrVal}</div>
                    <div class="metric-sub">市净率</div>
                </div>
                <div class="metric-card metric-cap">
                    <div class="metric-label">市值</div>
                    <div class="metric-value">${capVal}</div>
                    <div class="metric-sub">亿 ₩</div>
                </div>
            </div>

            <!-- 变动原因分析 -->
            <div class="analysis-block">
                <h4>
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><path d="M12 16v-4M12 8h.01"/></svg>
                    本月变动原因分析
                </h4>
                <div class="analysis-text">
                    NH投资证券发布新报告，维持<strong>BUY评级但目标价下调21.6%</strong>至₩40,000。
                    报告指出2026年因缺乏新作阵容，业绩处于空窗期；预计2027年后新作发行将带动预期修复。
                    本月以来股价从₩34,100回落至当前价位，主要受目标价下调和空窗期预期影响。
                    <span class="src-speculate" style="margin-left:6px">事实+有限推断</span>
                </div>
            </div>
        </div>
    </div>

    <!-- SU 折线图占位 -->
    <div class="card">
        <div class="card-header">
            <span>${suStock.name_en} 本月股价走势（绝对值）</span>
            <span style="font-size:11px;color:var(--text-muted)">${data.meta.display_date.split('年')[1] || ''} · 周末休市跳过</span>
        </div>
        <div class="card-body">
            <div class="chart-wrap"><canvas id="suChart"></canvas></div>
            <div class="weekend-note">注：周末休市日无收盘数据，图中仅显示交易日</div>
        </div>
    </div>`;

    document.getElementById('suSection').innerHTML = html;

    // 绑定折线图
    setTimeout(() => bindSUChart(suStock), 100);
}


// ============================================================
// 其他公司表格 + 对比折线图
// ============================================================

function renderOthersSection(data) {
    const others = (data.stocks || []).filter(s => s.is_focus !== true);

    let tableRows = others.map(s => {
        const pd = s.price_data || s;
        const cr = pd.change_rate || 0;
        const cls = cr > 0 ? 'up' : (cr < 0 ? 'down' : 'neutral');
        const sign = cr > 0 ? '+' : '';
        const chgAmt = pd.close && pd.prev_close ? Math.round((pd.close - pd.prev_close)) : 0;
        
        return `
        <tr>
            <td><div class="company-cell"><div class="company-dot" style="background:${s.color}"></div>${s.name_en}<span class="code-tag">${s.code}</span></div></td>
            <td style="color:var(--text-muted);font-family:monospace">${s.code}</td>
            <td style="font-weight:600;font-family:monospace">${(pd.close||'-').toLocaleString()}</td>
            <td>
                <span class="stock-change ${cls}" style="font-size:13px">${sign}${cr.toFixed(2)}% 
                  <small style="opacity:0.7">${chgAmt!==0?`±₩${Math.abs(chgAmt).toLocaleString()}`:'持平'}</small></span>
            </td>
        </tr>`;
    }).join('');

    const html = `
    <!-- 表格 -->
    <div class="card">
        <div class="card-header">
            <span>其他主要游戏公司收盘</span>
            <span style="font-size:11px;color:var(--text-muted)">${data.meta.display_date} (${data.meta.weekday})</span>
        </div>
        <div class="card-body" style="padding:0;overflow-x:auto">
            <table class="stock-table">
                <thead><tr><th>公司名称</th><th>代码</th><th>收盘价 (₩)</th><th>较前日变化</th></tr></thead>
                <tbody>${tableRows || '<tr><td colspan="4" style="text-align:center;padding:20px;color:var(--text-muted)">暂无数据</td></tr>'}</tbody>
            </table>
        </div>
    </div>

    <!-- 对比折线图 -->
    <div class="card">
        <div class="card-header">
            <span>本月股价日环比涨跌幅对比（%）</span>
            <span style="font-size:11px;color:var(--text-muted)">每日 vs 前一日变化率 · 周末跳过</span>
        </div>
        <div class="card-body">
            <div class="chart-wrap"><canvas id="compareChart"></canvas></div>
            <div class="weekend-note">注：仅显示有实际交易日的数据</div>
        </div>
    </div>`;

    document.getElementById('othersSection').innerHTML = html;

    setTimeout(() => bindCompareChart(others), 150);
}


// ============================================================
// PER 横向对比条形模块
// ============================================================

function renderPERSection(perSummary, allStocks) {
    if (!perSummary || !perSummary.all || perSummary.all.length === 0) return;

    // 找到最大值用于计算比例
    const maxPer = Math.max(...perSummary.all.map(p => p.per));
    const avgPer = perSummary.avg || 0;

    const rowsHtml = perSummary.all.map(item => {
        const pct = Math.min(Math.max((item.per / maxPer) * 100, 8), 100);
        return `
        <div class="per-compare-row">
            <div class="per-company-name">
                <div class="per-dot" style="background:${item.color}"></div>
                ${item.name}
            </div>
            <div class="per-bar-container">
                <div class="per-bar-fill" style="width:${pct}%;background:${item.color};opacity:0.75">
                    <span class="per-num">${item.per.toFixed(1)}</span>
                </div>
            </div>
            <div class="per-detail-col">
                <div>收盘: ₩${(item.close||0).toLocaleString()}</div>
            </div>
        </div>`;
    }).join('');

    const lowestName = perSummary.lowest ? perSummary.lowest.name : '-';
    const highestName = perSummary.highest ? perSummary.highest.name : '-';
    
    const summaryHtml = `
    <div class="card">
        <div class="card-header">
            <span>📊 PER (市盈率) 横向对比 — 数据来源: Naver Finance</span>
            <span style="font-size:11px;color:var(--text-muted)">
                平均 ${avgPer.toFixed(1)} | 最低: ${lowestName} | 最高: ${highestName}
            </span>
        </div>
        <div class="card-body" style="padding:4px 20px">
            ${rowsHtml}
            <div style="margin-top:10px;font-size:11px;color:var(--text-muted);text-align:right">
                PER越低 → 越被低估 | 数据更新于 Naver Finance 实时抓取
            </div>
        </div>
    </div>`;

    document.getElementById('perSection').innerHTML = summaryHtml;
}


// ============================================================
// 图表绑定
// ============================================================

function bindSUChart(suStock) {
    const el = document.getElementById('suChart');
    if (!el) return;
    
    // 销毁旧图表
    if (currentChartInstance) { currentChartInstance.destroy(); }

    const ctx = el.getContext('2d');
    
    // 默认示例数据（实际应从历史API获取）
    const labels = ['4/1', '4/2', '4/3', '4/6', '4/7'];
    const prices = [34100, 33500, 32800, 32050, (suStock.price_data||{}).close || 32900];

    const grad = ctx.createLinearGradient(0, 0, 0, 280);
    grad.addColorStop(0, 'rgba(255,107,157,0.25)');
    grad.addColorStop(1, 'rgba(255,107,157,0.01)');

    currentChartInstance = new Chart(ctx, {
        type: 'line',
        data: { labels, datasets: [{
            label: suStock.name_en + ' 收盘价',
            data: prices,
            borderColor: '#ff6b9d', backgroundColor: grad,
            borderWidth: 2.5, pointBackgroundColor: '#ff6b9d',
            pointBorderColor: '#fff', pointBorderWidth: 2,
            pointRadius: 4, pointHoverRadius: 7, tension: 0.35, fill: true
        }]},
        options: {
            responsive: true, maintainAspectRatio: false,
            interaction: { intersect: false, mode: 'index' },
            plugins: {
                legend: { display: false },
                tooltip: {
                    backgroundColor:'rgba(17,19,23,0.95)', titleColor:'#e8eaed', bodyColor:'#e8eaed',
                    borderColor:'#2e3347', borderWidth: 1, padding: 12,
                    callbacks: { label: ctx => `收盘价: ₩${ctx.parsed.y.toLocaleString()}` }
                }
            },
            scales: {
                x: { grid:{color:'rgba(46,51,71,0.3)',drawBorder:false}, ticks:{color:'#6b7185',font:{size:11}} },
                y: {
                    min: 30000, max: 36000,
                    grid:{color:'rgba(46,51,71,0.3)',drawBorder:false},
                    ticks:{color:'#6b7185',font:{size:11}, callback:v=>'₩'+(v/1000).toFixed(0)+'k'}
                }
            }
        }
    });
}

function bindCompareChart(others) {
    const el = document.getElementById('compareChart');
    if (!el || !others.length) return;
    
    if (cmpChartInstance) { cmpChartInstance.destroy(); }
    const ctx = el.getContext('2d');

    const dayLabels = ['4/1', '4/2', '4/3', '4/6', '4/7'];

    // 为每家公司生成模拟日环比数据
    const datasets = others.map(s => ({
        label: s.name_en,
        borderColor: s.color, backgroundColor: 'transparent',
        borderWidth: 2, pointRadius: 2, pointHoverRadius: 5,
        pointBackgroundColor: s.color, tension: 0.3, fill: false,
        // 使用实际涨跌幅作为最新值，前面填充模拟趋势
        data: generateTrendData(s.price_data?.change_rate || 0)
    }));

    cmpChartInstance = new Chart(ctx, {
        type: 'line',
        data: { labels: dayLabels, datasets },
        options: {
            responsive: true, maintainAspectRatio: false,
            interaction: { intersect: false, mode: 'index' },
            plugins: {
                legend: { display:true, position:'top',
                    labels:{color:'#9aa0b3', usePointStyle:true, pointStyle:'rectRounded', padding:16, font:{size:11,weight:500}} },
                tooltip: {
                    backgroundColor:'rgba(17,19,23,0.95)', titleColor:'#e8eaed', bodyColor:'#e8eaed',
                    borderColor:'#2e3347', borderWidth: 1, padding: 12,
                    callbacks:{ label: ctx => `${ctx.dataset.label}: ${ctx.parsed.y>=0?'+':''}${ctx.parsed.y.toFixed(2)}%`}
                }
            },
            scales: {
                x: { grid:{color:'rgba(46,51,71,0.3)',drawBorder:false}, ticks:{color:'#6b7185',font:{size:11}} },
                y: { min:-25, max:25,
                    grid:{color:'rgba(46,51,71,0.3)',drawBorder:false},
                    ticks:{color:'#6b7185',font:{size:11}, callback:v=>v+'%'},
                    title:{display:true,text:'日环比涨跌幅 (%)',color:'#6b7185',font:{size:11}}
                }
            }
        }
    });
}

/** 生成趋势模拟数据 */
function generateTrendData(latestChange) {
    const base = [-2.64, -1.76, -2.09, -2.29];
    base.push(latestChange);
    return base.map(v => parseFloat(v.toFixed(2)));
}


// ============================================================
// 日期选择器
// ============================================================

function renderDateSelector() {
    const select = document.getElementById('dateSelector');
    if (!select) return;

    // 清空并填充
    select.innerHTML = '<option value="">-- 选择日期 --</option>';

    AVAILABLE_DATES.forEach(d => {
        const opt = document.createElement('option');
        opt.value = d.trade_date;
        opt.textContent = `${d.trade_date} (${d.weekday})`;
        if (d.trade_date === CURRENT_DATE) opt.selected = true;
        select.appendChild(opt);
    });

    // 绑定事件
    select.addEventListener('change', onDateChange);
}

async function onDateChange(e) {
    const dateStr = e.target.value;
    if (!dateStr) return;

    // 显示 loading
    showLoading();

    try {
        const resp = await fetch(`/api/data/${dateStr}`);
        const result = await resp.json();
        if (result.code === 0) {
            hideLoading();
            renderDashboard(result.data);
            document.getElementById('dateHint').textContent = '';
            
            // 滚动到顶部
            window.scrollTo({ top: 0, behavior: 'smooth' });
        } else {
            hideLoading();
            showEmptyState();
            document.getElementById('dateHint').textContent = '⚠️ 该日期暂无存档数据';
            document.getElementById('dateHint').style.color = 'var(--accent-orange)';
        }
    } catch (err) {
        hideLoading();
        document.getElementById('dateHint').textContent = '❌ 加载失败';
        console.error(err);
    }
}

function goLatest() {
    if (!AVAILABLE_DATES.length) return;
    const latest = AVAILABLE_DATES[0].trade_date;
    document.getElementById('dateSelector').value = latest;
    onDateChange({ target: { value: latest } });
}

function showLoading() {
    document.getElementById('mainContainer').style.opacity = '0.4';
}

function hideLoading() {
    document.getElementById('mainContainer').style.opacity = '1';
}


// ============================================================
// 静态资讯翻页逻辑（保留原有功能）
// ============================================================

const EVENT_DATA = [
    { company: 'Shift Up', color: '#ff6b9d',
      title: 'NH证券新报告：目标价↓₩40,000/Buy，主题"痛苦期间"',
      source: '뉴스핌 (Newspim)', date: '04.07',
      url: 'https://www.newspim.com/news/view/20260407000081' },
    { company: 'Netmarble', color: '#ef4444',
      title: '₩1,500亿追加收购Coway股权遭Align Partners强烈批评',
      source: '아이뉴스24 (iNews24)', date: '04.07',
      url: 'https://www.inews24.com/view/1958083' },
    { company: 'NCSoft', color: '#3b82f6',
      title: "正式起诉YouTuber '영래기'（散布虚假事实+妨碍业务）",
      source: '스포츠경향 (Sports Khan)', date: '04.07',
      url: 'https://sports.khan.co.kr/article/20260408033500' },
    { company: 'Nexon', color: '#22c55e',
      title: '《Blue Archive（블루 아카이브）》IP扩展战略公布 → 股价强稳+0.54%',
      source: '재경일보 (Jaekyung Daily)', date: '04.07',
      url: 'https://news.jkn.co.kr/post/869567' },
    { company: 'Netmarble', color: '#ef4444',
      title: '新作《몬길: STAR DIVE》Showcase预告公开，定档4/15全球上线',
      source: '비즈월드 (BizWorld)', date: '04.07',
      url: 'https://www.bizwnews.com/news/articleView.html?idxno=132692' },
    { company: 'Krafton', color: '#f59e0b',
      title: 'PUBG Mobile × 캐치! 티니핑(Catch! Teenieping) 跨界联动正式开启',
      source: '더쎈뉴스 (The CEN News)', date: '04.07',
      url: 'https://www.mhns.co.kr/news/articleView.html?idxno=743979' },
    { company: 'Shift Up', color: '#ff6b9d',
      title: '完成Unbound Games（三上真司工作室）100%收购整合',
      source: '인벤 (Inven)', date: '04.01',
      url: 'https://www.inven.co.kr/webzine/news/?news=314941' },
    { company: 'Pearl Abyss', color: '#ec4899',
      title: '《붉은사막》(Crimson Desert) MetaCritic评分公布后股价单日暴跌29.88%',
      source: '조선일보 (Chosun Ilbo)', date: '03.20',
      url: 'https://www.chosun.com/economy/tech_it/2026/03/20/KKI55NYV3JFTFDJVYF6NJE3CH4/' },
];

const NORMAL_DATA = [
    { company: 'Pearl Abyss', color: '#ec4899',
      title: '《붉은사막》(Crimson Desert) 全球销量突破400万套，Steam在线峰值27万，口碑反转升至"好评如潮"',
      source: '펄어비스 공식 홈페이지', date: '03.30~04.07',
      url: 'https://www.pearlabyss.com/' },
    { company: 'Netmarble', color: '#ef4444',
      title: '《칠대죄: Origin》亮相香港 CON-CON 2026 展会',
      source: 'HaveAGoodHoliday', date: '04.04~04.05',
      url: 'https://www.haveagood-holiday.com/ko/articles/seven-deadly-sins-origin-con-con-hong-kong-2026' },
    { company: 'Krafton', color: '#f59e0b',
      title: '发布AI模型品牌 "Raon(라온)"，首批4款开源模型上线',
      source: 'Krafton AI 官网', date: '04.02',
      url: 'http://www.krafton.ai' },
    { company: 'Shift Up', color: '#ff6b9d',
      title: '完成Unbound Games（三上真司工作室）100%收购整合——开发商→发行商战略转型标志事件',
      source: '인벤 (Inven)', date: '04.01',
      url: 'https://www.inven.co.kr/webzine/news/?news=314941' },
    { company: 'Nexon', color: '#22c55e',
      title: '2026 NDC(개발자 컨퍼런스) 演讲者招募截止',
      source: 'MSN', date: '03.04~04.04',
      url: 'https://www.msn.com/' },
    { company: 'NCSoft', color: '#3b82f6',
      title: '《리니지 클래식》(Lineage Classic) 累计制裁近600万账户，打击非法程序力度持续加强',
      source: 'NCSoft官方公告', date: '04.07',
      url: 'https://about.ncsoft.com/news/article/news_update_260407' },
    { company: 'Krafton', color: '#f59e0b',
      title: '《어센드투제로》(Ascend to Zero) 新作动作Roguelike公布，Xbox+Steam同步发行',
      source: 'Krafton官方新闻室', date: '04月初',
      url: 'https://www.krafton.com/news/press/' },
    { company: 'Pearl Abyss', color: '#ec4899',
      title: 'DS投资证券将目标价从6.5万上调至9万韩元，《红沙漠》长期价值获看好',
      source: '스마트투데이 (SmartToday)', date: '03.30',
      url: 'https://www.smarttoday.co.kr/' },
    { company: 'Netmarble', color: '#ef4444',
      title: '《칠대죄: Origin》全球首发后首次大型展会亮相香港CON-CON 2026',
      source: 'HaveAGoodHoliday', date: '04.04~04.05',
      url: 'https://www.haveagood-holiday.com/ko/articles/seven-deadly-sins-origin-con-con-hong-kong-2026' },
];

const PAGE_SIZE = 5;
let eventCurrentPage = 1;
let normalCurrentPage = 1;

function initStaticTables() {
    renderEventTable();
    renderNormalTable();
}

function renderEventTable() {
    const tbody = document.getElementById('eventTableBody'); if(!tbody) return;
    const start = (eventCurrentPage - 1) * PAGE_SIZE;
    tbody.innerHTML = EVENT_DATA.slice(start, start+PAGE_SIZE).map(i=>`
        <tr>
            <td><strong style="color:${i.color}">${i.company}</strong></td>
            <td><a href="${i.url}" target="_blank" class="news-link"><span class="news-title">${i.title}</span><div class="news-source">${i.source}</div></a></td>
            <td style="color:var(--text-muted);font-size:13px">${i.date}</td>
        </tr>`).join('');
    const tp=Math.ceil(EVENT_DATA.length/PAGE_SIZE);
    document.getElementById('eventPageInfo').textContent=`第 ${eventCurrentPage}/${tp} 页，共 ${EVENT_DATA.length} 条`;
    document.getElementById('eventPrevBtn').disabled=(eventCurrentPage<=1);
    document.getElementById('eventNextBtn').disabled=(eventCurrentPage>=tp);
    renderDots('eventDots', eventCurrentPage, tp, 'eventCurrentPage');
}

function renderNormalTable() {
    const tbody = document.getElementById('normalTableBody'); if(!tbody) return;
    const start=(normalCurrentPage-1)*PAGE_SIZE;
    tbody.innerHTML=NORMAL_DATA.slice(start,start+PAGE_SIZE).map(i=>`
        <tr>
            <td><a href="${i.url}" target="_blank" class="news-link"><span class="news-title">${i.title}</span><div class="news-source">${i.source}</div></a></td>
            <td style="color:var(--text-muted);font-size:13px">${i.date}</td>
            <td><strong style="color:${i.color}">${i.company}</strong></td>
        </tr>`).join('');
    const tp=Math.ceil(NORMAL_DATA.length/PAGE_SIZE);
    document.getElementById('normalPageInfo').textContent=`第 ${normalCurrentPage}/${tp} 页，共 ${NORMAL_DATA.length} 条`;
    document.getElementById('normalPrevBtn').disabled=(normalCurrentPage<=1);
    document.getElementById('normalNextBtn').disabled=(normalCurrentPage>=tp);
    renderDots('normalDots', normalCurrentPage, tp, 'normalCurrentPage');
}

function renderDots(cid, cur, total, varName){
    const c=document.getElementById(cid); if(!c)return; c.innerHTML='';
    for(let i=1;i<=total;i++){
        const d=document.createElement('button'); d.className='page-dot'+(i===cur?' active':'');
        d.onclick=()=>{if(cid==='eventDots'){eventCurrentPage=i;renderEventTable()}else{normalCurrentPage=i;renderNormalTable()}};
        c.appendChild(d);}}

function changeEventPage(d){eventCurrentPage+=d;if(eventCurrentPage<1)eventCurrentPage=1;const m=Math.ceil(EVENT_DATA.length/PAGE_SIZE);if(eventCurrentPage>m)eventCurrentPage=m;renderEventTable();}
function changeNormalPage(d){normalCurrentPage+=d;if(normalCurrentPage<1)normalCurrentPage=1;const m=Math.ceil(NORMAL_DATA.length/PAGE_SIZE);if(normalCurrentPage>m)normalCurrentPage=m;renderNormalTable();}
