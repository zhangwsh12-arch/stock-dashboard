# X 账号每日/每周监控

自动抓取 3 个 X 账号的动态（原创 / 转发 / 引用），做增量去重、AI 翻译解读，生成：

- **网页看板**（每日更新，保留历史）
- **企业微信周报推送**（每周一次，深度趋势分析，全文不摘要）

全流程跑在 CI 定时任务（免费），数据与 HTML 提交回仓库做历史存储。

> **用内网工蜂 (git.woa.com) + 蓝盾？** 见 [BLUEKING.md](./BLUEKING.md)。抓取/推送逻辑完全通用，只需把「定时 + git 回写」从 GitHub Actions 换成蓝盾流水线。下面的 GitHub 部署为可选备用方案。

---

## 监控的账号

在 `config/accounts.json` 中配置，当前为：

- @jamm3rd
- @_yoojoonseok
- @hsyoo___

## 推送策略

- **日报**：仅更新网页看板，**不推送微信**
- **周报**：每周一次，推送到企业微信机器人（深度趋势分析）

---

## 部署步骤

### 1. 推到 GitHub
把本目录推送到一个 GitHub 仓库。

### 2. 配置 Secrets
仓库 **Settings → Secrets and variables → Actions → New repository secret**，添加：

| Secret | 说明 | 必填 |
|---|---|---|
| `TWITTERAPI_IO_KEY` | TwitterAPI.io 的 API Key（[注册地址](https://twitterapi.io)，Google 登录即得，无需 X 开发者账号） | ✅ |
| `WECHAT_WEBHOOK_URL` | 企业微信机器人 webhook 地址（群设置 → 群机器人 → 添加 → 复制 Webhook） | ✅ |
| `LLM_API_KEY` | DeepSeek API Key（[注册地址](https://platform.deepseek.com)） | 建议 |
| `LLM_API_BASE` | 默认 `https://api.deepseek.com`，用其他 OpenAI 兼容接口时填 | 可选 |
| `LLM_MODEL` | 默认 `deepseek-chat` | 可选 |

> 不配 `LLM_API_KEY` 也能跑：不翻译、周报直接汇总原文。配上后会英文→中文翻译 + 话题标注 + 周趋势合成。

### 3. 启用 GitHub Pages
仓库 **Settings → Pages → Source** 选 **Deploy from a branch**，分支选 `main`、目录选 **`/docs`**。
几分钟后看板地址为 `https://<用户名>.github.io/<仓库名>/`。

### 4. 完成
Actions 会按计划自动运行：

- **日报**：每天 KST 07:00（UTC 22:00）→ 更新看板
- **周报**：每周一 KST 08:00（周日 UTC 23:00）→ 推送企业微信

也可在 **Actions → X Account Monitor → Run workflow** 手动触发（可选 daily / weekly）。

---

## 成本

TwitterAPI.io 约 $0.00015/条。3 账号每天抓几十条 → 每月约几美分。DeepSeek 翻译约每月一两元人民币。

---

## 本地调试

```bash
# 安装依赖
pip install requests jinja2

# 设置环境变量后跑
cd scripts
export TWITTERAPI_IO_KEY=xxx
export LLM_API_KEY=xxx          # 可选
export WECHAT_WEBHOOK_URL=xxx   # 可选
python run_daily.py    # 抓取 + 生成看板
python run_weekly.py   # 聚合近7日 + 推送周报
```

## 目录说明

```
config/accounts.json      监控账号
scripts/                  抓取/解读/渲染/推送/编排
data/state.json           每账号去重游标
data/daily/*.json         每日快照
data/weekly/*.json        每周汇总
docs/                     GitHub Pages 输出
templates/                看板模板
.github/workflows/        定时任务
```
