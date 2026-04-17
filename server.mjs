/**
 * 韩国游戏股价看板 - Node.js 后端服务
 * ========================================
 * 功能:
 * 1. Express API 服务（动态数据渲染）
 * 2. Naver Finance 实时数据抓取（PER/股价/市值等）
 * 3. SQLite 历史数据库（每日留档归档）
 * 4. 定时任务：每天上午10点自动更新前一天数据
 * 5. 历史日期查询接口
 *
 * 用法:
 *   npm install          # 安装依赖
 *   npm start            # 启动 Web 服务 (默认 http://localhost:3000)
 *   node server.mjs --update-now    # 立即执行一次数据更新
 */

import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import cron from 'node-cron';
import * as cheerio from 'cheerio';

// ============================================================
// 常量与配置
// ============================================================

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DATA_DIR = path.join(__dirname, 'data');
const DB_PATH = path.join(DATA_DIR, 'dashboard.db');
const PORT = process.env.PORT || 3000;

const COMPANIES = [
    { name_en: "Shift Up",    name_ko: "시프트업",   code: "391740", color: "#ff6b9d", market: "KOSDAQ", isFocus: true },
    { name_en: "Nexon",       name_ko: "넥슨게임즈",  code: "042700", color: "#22c55e", market: "KOSPI",  isFocus: false },
    { name_en: "Netmarble",   name_ko: "넷마블",      code: "251270", color: "#ef4444", market: "KOSDAQ", isFocus: false },
    { name_en: "NC",          name_ko: "엔씨",          code: "036570", color: "#3b82f6", market: "KOSDAQ", isFocus: false },
    { name_en: "Krafton",     name_ko: "크래프톤",   code: "259960", color: "#f59e0b", market: "KOSDAQ", isFocus: false },
    { name_en: "Pearl Abyss", name_ko: "펄어비스",   code: "263750", color: "#ec4899", market: "KOSDAQ", isFocus: false },
];

const NAVER_HEADERS = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36',
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Accept-Language': 'ko-KR,ko;q=0.9,en;q=0.8',
};

const WEEKDAYS = ['周一', '周二', '周三', '周四', '周五', '周六', '周日'];

// ============================================================
// SQLite 数据库层
// ============================================================

let Database;
let db;

async function initDB() {
    const fs = await import('fs');
    fs.mkdirSync(DATA_DIR, { recursive: true });

    Database = (await import('better-sqlite3')).default;
    db = new Database(DB_PATH);

    // 每日快照表
    db.exec(`
        CREATE TABLE IF NOT EXISTS daily_snapshots (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            trade_date TEXT NOT NULL UNIQUE,
            display_date TEXT NOT NULL,
            weekday TEXT NOT NULL,
            data_json TEXT NOT NULL,
            created_at TEXT DEFAULT (datetime('now','+9 hours')),
            updated_at TEXT DEFAULT (datetime('now','+9 hours'))
        )
    `);

    // 公司估值指标
    db.exec(`
        CREATE TABLE IF NOT EXISTS company_metrics (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            trade_date TEXT NOT NULL,
            company_code TEXT NOT NULL,
            company_name TEXT NOT NULL,
            close_price INTEGER,
            change_rate REAL,
            per REAL,
            pbr REAL,
            market_cap_억 REAL,
            foreign_holding_rate REAL,
            volume INTEGER,
            source TEXT DEFAULT 'naver',
            UNIQUE(trade_date, company_code),
            created_at TEXT DEFAULT (datetime('now','+9 hours'))
        )
    `);

    // 更新日志
    db.exec(`
        CREATE TABLE IF NOT EXISTS update_log (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            executed_at TEXT NOT NULL,
            target_date TEXT NOT NULL,
            status TEXT NOT NULL,
            companies_updated INTEGER DEFAULT 0,
            error_msg TEXT,
            duration_seconds REAL
        )
    `);

    console.log(`✅ 数据库初始化完成: ${DB_PATH}`);
}

function saveSnapshot(tradeDate, dashboardData) {
    try {
        const dt = parseTradeDate(tradeDate);
        db.prepare(`
            INSERT OR REPLACE INTO daily_snapshots 
            (trade_date, display_date, weekday, data_json, updated_at)
            VALUES (?, ?, ?, ?, datetime('now','+9 hours'))
        `).run(
            tradeDate,
            `${dt.year}年${dt.month}月${dt.day}日`,
            WEEKDAYS[dt.weekday],
            JSON.stringify(dashboardData)
        );
        return true;
    } catch(e) { console.error(`❌ 保存快照失败: ${e.message}`); return false; }
}

function saveMetrics(tradeDate, metricsList) {
    let count = 0;
    try {
        const stmt = db.prepare(`INSERT OR REPLACE INTO company_metrics
            (trade_date, company_code, company_name, close_price, change_rate,
             per, pbr, market_cap_억, foreign_holding_rate, volume, source)
            VALUES (?,?,?,?,?,?,?,?,?,?,?)`);
        
        for (const m of metricsList) {
            stmt.run(tradeDate, m.code, m.name, m.close || 0, m.changeRate || 0,
                m.per || null, m.pbr || null, m.marketCap || null,
                m.foreignRate || null, m.volume || 0, 'naver');
            count++;
        }
        console.log(`💾 估值指标已保存: ${count} 条 (${tradeDate})`);
    } catch(e) { console.error(`❌ 保存估值指标失败: ${e.message}`); }
    return count;
}

function getAvailableDates() {
    return db.prepare("SELECT trade_date, display_date, weekday FROM daily_snapshots ORDER BY trade_date DESC").all();
}

function getSnapshotByDate(date) {
    const row = db.prepare("SELECT data_json FROM daily_snapshots WHERE trade_date=?").get(date);
    return row ? JSON.parse(row.data_json) : null;
}

function logUpdate(targetDate, status, updatedCount, duration) {
    db.prepare("INSERT INTO update_log (executed_at, target_date, status, companies_updated, duration_seconds) VALUES (?,?,?,?,?)")
        .run(new Date().toISOString(), targetDate, status, updatedCount, duration);
}


// ============================================================
// Naver Finance 数据抓取
// ============================================================

async function fetchNaverStockInfo(code) {
    const resp = await fetch(`https://finance.naver.com/item/main.nhn?code=${code}`, { headers: NAVER_HEADERS });
    const html = await resp.arrayBuffer();
    const decoder = new TextDecoder('euc-kr');
    const text = decoder.decode(html);

    const $ = cheerio.load(text);
    const result = {};

    // 收盘价
    const priceText = $('div.today p.no_today span.blind').text().trim();
    if (priceText) result.close = parseInt(priceText.replace(/,/g, ''));

    // 涨跌幅
    $('div.today p.no_exday').each((i, el) => {
        const t = $(el).text();
        if (t.includes('%')) {
            const m = t.match(/([+-]?\d+\.?\d*)%/);
            if (m) result.changeRate = parseFloat(m[1]);
        }
    });

    // 前日收盘
    const prevText = $('div.today td:first-child span.blind').text().trim();
    if (prevText) result.prevClose = parseInt(prevText.replace(/,/g, ''));

    // PER / PBR 从 summary_table 获取
    let foundTable = false;
    $('table.summary_table, table').each((i, table) => {
        if (foundTable) return;
        $(table).find('tr').each((j, row) => {
            const cells = $(row).find('th,td');
            const texts = cells.map((k, c) => $(c).text().replace(/,/g, '').replace(/\s+/g, '')).get();
            
            for (let idx = 0; idx < texts.length; idx++) {
                const upper = texts[idx].toUpperCase();
                if ((upper.includes('PER') && !upper.includes('SUPER')) || upper === 'PER') {
                    const v = parseFloatSafe(texts[idx + 1]);
                    if (v !== null) result.per = v;
                } else if (upper === 'PBR' || upper.startsWith('PBR')) {
                    const v = parseFloatSafe(texts[idx + 1]);
                    if (v !== null) result.pbr = v;
                }
                
                // 市值
                if (texts[idx].includes('시가총액')) {
                    for (let k = idx; k < Math.min(idx + 4, texts.length); k++) {
                        const clean = texts[k].replace(/[조억만]/g, '');
                        const v = parseFloatSafe(clean.replace('시가총액',''));
                        if (v !== null) {
                            result.marketCap = texts[k].includes('조') ? v * 10000 : v;
                            break;
                        }
                    }
                }

                // 外资持股比
                const combined = texts.join('');
                if (combined.includes('외국인보유') || combined.toUpperCase().includes('FOREIGN')) {
                    for (let k = 0; k < texts.length; k++) {
                        if (texts[k].includes('%')) {
                            result.foreignRate = parseFloat(texts[k].replace('%',''));
                            break;
                        }
                    }
                }
            }
        });
        if (result.per !== undefined) foundTable = true;
    });

    // 高低价/成交量/开盘价
    $('table tr').each((i, row) => {
        const cells = $(row).find('th,td');
        const texts = cells.map((k, c) => $(c).text().replace(/,/g, '').trim()).get();
        
        for (let i = 0; i < texts.length; i++) {
            const t = texts[i];
            if (['고가', '최고'].includes(t)) { const v=parseIntSafe(texts[i+1]); if(v)result.high=v; }
            else if (['저가', '최저'].includes(t)) { const v=parseIntSafe(texts[i+1]); if(v)result.low=v; }
            else if (t==='시가') { const v=parseIntSafe(texts[i+1]); if(v)result.open=v; }
            else if (t==='거래량') { const v=parseIntSafe(texts[i+1]); if(v)result.volume=v; }
        }
    });

    return result.close ? result : null;
}

function parseFloatSafe(s) {
    if (!s) return null;
    s = String(s).replace('N/A','').replace('-','').trim();
    if (!s || s === '0' || s === '-') return 0;
    const n = parseFloat(s);
    return isNaN(n) ? null : n;
}
function parseIntSafe(s) {
    if (!s) return null;
    const n = parseInt(String(s).replace(/,/g,''));
    return isNaN(n) ? null : n;
}
function parseTradeDate(str) {
    const d = new Date(str.slice(0,4)+'-'+str.slice(4,6)+'-'+str.slice(6,8));
    return { year: d.getFullYear(), month: d.getMonth()+1, day: d.getDate(), weekday: d.getDay() };
}


// ============================================================
// 数据聚合引擎
// ============================================================

async function runUpdate(targetDateStr = null) {
    const startTime = Date.now();

    // 确定目标日期
    let targetDt;
    if (targetDateStr) {
        targetDt = new Date(`${targetDateStr.slice(0,4)}-${targetDateStr.slice(4,6)}-${targetDateStr.slice(6,8)}T09:00:00+09:00`);
    } else {
        // 默认前一个工作日
        targetDt = new Date(Date.now() - 86400000);
        while (targetDt.getDay() >= 5) targetDt.setDate(targetDt.getDate() - 1);
    }

    const tradeDate = `${targetDt.getFullYear()}${String(targetDt.getMonth()+1).padStart(2,'0')}${String(targetDt.getDate()).padStart(2,'0')}`;
    
    console.log(`\n${'='.repeat(50)}`);
    console.log(`🔄 开始更新 | 目标: ${tradeDate} | ${WEEKDAYS[targetDt.getDay()]}`);
    console.log(`${'='.repeat(50)}\n`);

    // 逐公司获取 Naver 数据
    const allStocks = [];
    const metricsList = [];

    for (const comp of COMPANIES) {
        process.stdout.write(`  📡 ${comp.name_en} (${comp.code}) ... `);
        try {
            const info = await fetchNaverStockInfo(comp.code);
            if (info) {
                allStocks.push({ ...comp, priceData: info, status: 'ok' });
                metricsList.push({
                    code: comp.code, name: comp.name_en,
                    close: info.close, changeRate: info.changeRate,
                    per: info.per, pbr: info.pbr,
                    marketCap: info.marketCap,
                    foreignRate: info.foreignRate,
                    volume: info.volume,
                });
                console.log(`✅ ₩${info.close?.toLocaleString()} | PER=${info.per||'-'} PBR=${info.pbr||'-'}`);
            } else {
                allStocks.push({ ...comp, priceData: null, status: 'no_data' });
                console.log(`❌ 无数据`);
            }
        } catch(err) {
            allStocks.push({ ...comp, priceData: null, status: 'error' });
            console.log(`❌ ${err.message}`);
        }
    }

    // 构建 PER 摘要
    const validPers = metricsList.filter(m => m.per > 0)
        .map(m => ({ name: m.name, per: m.per, close: m.close, 
             color: COMPANIES.find(c=>c.name_en===m.name)?.color }))
        .sort((a,b)=> a.per - b.per);

    const dashboard = {
        meta: { tradeDate, 
            displayDate: `${targetDt.getFullYear()}年${targetDt.getMonth()+1}月${targetDt.getDate()}日`,
            weekday: WEEKDAYS[targetDt.getDay()],
            generatedAt: new Date(startTime).toISOString(),
            total: COMPANIES.length, ok: allStocks.filter(s=>s.status==='ok').length,
        },
        stocks: allStocks.map(s => ({
            nameEn: s.name_en, nameKo: s.name_ko, code: s.code, color: s.color,
            isFocus: s.isFocus, market: s.market,
            ...(s.priceData || {}),
            status: s.status,
        })),
        perSummary: {
            all: validPers,
            lowest: validPers[0] || null,
            highest: validPers[validPers.length-1] || null,
            avg: validPers.length ? validPers.reduce((sum,p)=>sum+p.per,0)/validPers.length : 0,
            count: validPers.length,
        },
    };

    // 存库
    saveSnapshot(tradeDate, dashboard);
    saveMetrics(tradeDate, metricsList);

    const duration = ((Date.now() - startTime) / 1000).toFixed(1);
    logUpdate(tradeDate, 'success', metricsList.length, parseFloat(duration));

    console.log(`\n${'='.repeat(50)}`);
    console.log(`✅ 更新完成! ${metricsList.length}/${COMPANIES.length} 公司 | 耗时 ${duration}s`);
    console.log(`${'='.repeat(50)}\n`);

    return dashboard;
}


// ============================================================
// Express App & Routes
// ============================================================

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'static')));

app.set('views', path.join(__dirname, 'templates'));
app.set('view engine', 'html');
app.engine('html', async (filePath, options, callback) => {
    const fs = await import('fs');
    try {
        const content = fs.readFileSync(filePath, 'utf-8');
        // 简单模板替换 {{ variable }}
        let rendered = content;
        for (const [key, val] of Object.entries(options)) {
            const safeVal = typeof val === 'object' ? JSON.stringify(val).replace(/"/g, '&quot;') : String(val);
            rendered = rendered.replaceAll(`{{ ${key} }}`, safeVal);
            rendered = rendered.replaceAll(`{{ ${key} | tojson | safe }}`, 
                typeof val === 'object' ? JSON.stringify(val) : JSON.stringify(String(val)));
        }
        callback(null, rendered);
    } catch(err) { callback(err); }
});

// 首页
app.get('/', (req, res) => {
    const dates = getAvailableDates();
    const latestDate = dates.length > 0 ? dates[0].trade_date : null;
    const snapshot = latestDate ? getSnapshotByDate(latestDate) : null;

    res.render('index.html', {
        _snapshot: snapshot,
        available_dates: JSON.stringify(dates),
        current_date: latestDate || '',
    }, (err, html) => {
        if (err) return res.status(500).send(err.message);
        res.send(html);
    });
});

// API 路由
app.get('/api/data/:tradeDate', (req, res) => {
    const snap = getSnapshotByDate(req.params.tradeDate);
    snap ? res.json({ code: 0, data: snap }) : res.status(404).json({ code: -1, msg: '无该日期数据' });
});

app.get('/api/latest', (req, res) => {
    const dates = getAvailableDates();
    if (dates.length) {
        const snap = getSnapshotByDate(dates[0].trade_date);
        if (snap) return res.json({ code: 0, date: dates[0].trade_date, data: snap });
    }
    res.status(404).json({ code: -1, msg: '暂无数据' });
});

app.get('/api/dates', (req, res) => {
    res.json({ code: 0, dates: getAvailableDates() });
});

app.get('/api/history/:companyCode', (req, res) => {
    const limit = parseInt(req.query.limit) || 30;
    const rows = db.prepare(
        `SELECT trade_date, close_price as close, change_rate as changeRate, 
                per, pbr, market_cap_억 as marketCap
         FROM company_metrics WHERE company_code=? ORDER BY trade_date DESC LIMIT ?`
    ).all(req.params.companyCode, limit);
    res.json({ code: 0, history: rows });
});

app.post('/api/update', async (req, res) => {
    try {
        const result = await runUpdate();
        res.json({ code: 0, msg: '更新成功', data: result });
    } catch(e) {
        res.status(500).json({ code: -1, msg: e.message });
    }
});


// ============================================================
// 启动入口
// ============================================================

async function main() {
    const args = process.argv.slice(2);

    // 初始化数据库
    await initDB();

    // --update-now 模式
    if (args.includes('--update-now')) {
        const dateIdx = args.indexOf('--date');
        const result = await runUpdate(dateIdx >= 0 ? args[dateIdx + 1] : null);
        console.log(JSON.stringify(result, null, 2));
        process.exit(0);
    }

    // 注册定时任务: 每天 10:00 KST 自动更新
    cron.schedule('0 10 * * 1-5', () => {
        console.log('\n⏰ [定时任务] 开始执行每日自动更新...');
        runUpdate().catch(e => console.error('定时更新失败:', e.message));
    }, {
        scheduled: true,
        timezone: 'Asia/Seoul'
    });

    // 启动 HTTP 服务
    app.listen(PORT, () => {
        console.log(`
╔══════════════════════════════════════════════╗
║  🎮 韩国游戏股价看板 - Web服务启动             ║
║                                              ║
║  地址: http://localhost:${PORT}
║  数据库: ${DB_PATH}
║  定时: 工作日 上午 10:00 KST 自动更新         ║
╚══════════════════════════════════════════════╝`);
    });
}

main().catch(console.error);
