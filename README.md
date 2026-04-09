# 韩国游戏股价看板 🎮

PER估值分析看板 — 每日自动更新韩国游戏公司股价数据

## 功能

- **PER/PBR 估值展示** — 替代传统券商目标价，更直观的横向对比
- **每日自动更新** — 工作日上午 10:00 KST 自动抓取 Naver Finance 数据
- **历史数据留档** — 每天数据存为 JSON，支持日期选择器回查
- **完全免费** — GitHub Pages 托管，零服务器成本
- **全球可访问** — CDN 加速，任何设备随时查看

## 快速部署（3步）

### 第1步：创建 GitHub 仓库

1. 打开 https://github.com/new
2. Repository name: `korea-game-stock-dashboard`（或任意名称）
3. 选择 **Private**（仅自己可见）或 **Public**（所有人可访问）
4. **不要勾选** "Add a README file"
5. 点击 **Create repository**

### 第2步：推送代码

打开 PowerShell / 终端，依次执行：

```bash
cd stock-dashboard

git init
git add .
git commit -m "🎮 Initial: 韩国游戏股价看板 v3.0"

git remote add origin https://github.com/你的用户名/korea-game-stock-dashboard.git
git push -u origin main
```

> 把 `你的用户名` 替换成你的 GitHub 用户名。

### 第3步：开启 GitHub Pages

1. 进入仓库页面 → **Settings**
2. 左侧菜单 → **Pages**
3 **Build and deployment > Source**: 选择 **GitHub Actions**

> ⚠️ 不要选择 "Deploy from a branch"，必须选 **GitHub Actions**，因为我们用自定义工作流。

4. 等待约 1-2 分钟，Actions 会自动运行首次数据抓取

5. 在 **Actions** 页面可以看到运行状态

6. 部署成功后，访问：
   ```
   https://你的用户名.github.io/korea-game-stock-dashboard/
   ```

## 项目结构

```
stock-dashboard/
├── .github/workflows/
│   └── daily-update.yml      ← 每天自动运行的定时任务
├── data/
│   ├── latest.json            ← 最新数据（网页读取这个）
│   ├── dates.json             ← 可用的历史日期列表
│   └── YYYYMMDD.json          ← 每日快照归档
├── scripts/
│   └── fetch-data.mjs         ← 数据抓取脚本（Naver Finance）
├── index.html                 ← 主页面（从 JSON 动态读取数据）
├── package.json               ← Node.js 配置
└── README.md                  ← 本文件
```

## 数据更新机制

```
每天 工作日 10:00 KST (UTC 01:00)
    │
    ▼
GitHub Actions 自动触发 fetch-data.mjs
    │
    ├─ 抓取 6 家公司 Naver Finance 数据 (股价/PER/PBR/市值)
    ├─ 获取 Shift Up 月度走势图数据
    ├─ 写入 data/YYYYMMDD.json (当日快照)
    ├─ 更新 data/latest.json (最新数据指针)
    └─ 更新 data/dates.json (日期列表)
    │
    ▼
GitHub Pages 自动重新部署
    │
    ▼
网页刷新即可看到最新数据 ✅
```

## 手动触发更新

如果需要立即更新（不等定时任务）：

**方式A：GitHub 网页操作**
1. 仓库 → Actions → Daily Stock Data Update
2. 右侧 **Run workflow** → 选择 main 分支 → Run workflow

**方式B：本地命令行**
```bash
node scripts/fetch-data.mjs
git add data/
git commit -m "📊 手动更新数据"
git push
```

## 本地预览

不需要 Node.js！直接双击打开：

```bash
# 方式1：直接在浏览器中打开
start index.html

# 方式2：如果你有 Python
python -m http.server 8080
# 然后 http://localhost:8080

# 方式3：如果你有 Node.js
npx serve .
# 然后打开终端提示的地址
```

## 自定义配置

### 修改关注的公司

编辑 `scripts/fetch-data.mjs` 中的 `COMPANIES` 数组：

```javascript
const COMPANIES = [
  { code: '391740', name: 'Shift Up',   nameKr: '시프트업',    color: '#ff6b9d' },
  // ... 添加更多公司
];
```

### 修改自动更新时间

编辑 `.github/workflows/daily-update.yml`：

```yaml
schedule:
  # cron 格式: 分 时 日 月 周(0=周日,1=周一,...,5=周五)
  # 当前: 每天 UTC 01:00 = KST 10:00
  - cron: '0 1 * * 1-5'  # 周一到周五
```

### 修改时区/语言

`index.html` 中的文字都是中文，可以自由改为韩文或英文。

## 数据来源

| 数据项 | 来源 | 更新频率 |
|--------|------|---------|
| 股价 | Naver Finance (finance.naver.com) | 实时 |
| PER / PBR | Naver Finance | 每日收盘 |
| 市值 | Naver Finance | 每日收盘 |
| 月度走势图 | Naver SiseJson API | 每日 |
| 新闻分析 | 手动维护（T1/T2来源标注） | 按需 |

## 注意事项

1. **周末和韩国节假日无交易** — 脚本会跳过这些日期
2. **Naver 可能有反爬限制** — 如果抓取失败，Action 日志会有错误信息
3. **数据延迟约1天** — 显示的是前一交易日收盘数据
4. **仅供学习参考** — 不构成投资建议

## License

MIT
