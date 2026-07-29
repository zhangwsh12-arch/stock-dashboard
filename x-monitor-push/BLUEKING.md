# 内网工蜂 (git.woa.com) + 蓝盾流水线 部署指南

> 你的 Python 抓取/解读/推送逻辑无需改动，只需在蓝盾上配置「定时 + 跑脚本 + git 回写」。
> 蓝盾流水线在**网页控制台可视化编排**，不读仓库里的 yml（`.github/workflows/monitor.yml` 仅作 GitHub 备用）。

---

## 一、总体结构

建 **2 条流水线**（比 1 条判分支清晰）：

| 流水线 | 触发 | 跑的脚本 | 作用 |
|---|---|---|---|
| **A｜日报** | 定时 每天 07:00 | `run_daily.py` | 抓取 + 更新看板，**不推微信** |
| **B｜周报** | 定时 每周一 08:00 | `run_weekly.py` | 聚合 7 日 + 推企微 + 更新看板 |

两条流水线的 Job/Shell 几乎一样，只差最后跑哪个脚本。

---

## 二、准备：代码库 + git 写权限令牌

1. 把本项目推到内网工蜂新建的仓库，例如 `https://git.woa.com/<你的组>/x-monitor.git`
2. 生成一个**工蜂 Access Token**（工蜂 → 个人设置 → 访问令牌 / Personal Access Token，勾选 `write_repository` 或 `api` 权限）。记下 token，稍后作为流水线变量 `GIT_TOKEN`。

> git 回写就靠这个 token：`git push https://oauth2:${GIT_TOKEN}@git.woa.com/<组>/x-monitor.git`

---

## 三、配置流水线变量（相当于 GitHub Secrets）

在**每条流水线**的 `Trigger → 流水线变量` 里新增以下变量（值填你自己的，敏感的勾选「是否为敏感信息」）：

| 变量名 | 值 | 说明 |
|---|---|---|
| `TWITTERAPI_IO_KEY` | 你的 twitterapi.io key | 必填，敏感 |
| `WECHAT_WEBHOOK_URL` | 企微机器人 webhook | 必填，敏感（周报流水线才用得到，但两条都填便于统一） |
| `LLM_API_KEY` | DeepSeek key | 建议，敏感 |
| `LLM_API_BASE` | `https://api.deepseek.com` | 可选 |
| `LLM_MODEL` | `deepseek-chat` | 可选 |
| `GIT_TOKEN` | 工蜂 access token | 必填，敏感（git 回写用） |
| `GIT_REPO` | `git.woa.com/<组>/x-monitor.git` | 回写地址（不含协议头） |

---

## 四、流水线 A（日报）配置步骤

### 1. 新建流水线
蓝盾 → 你的项目 → 流水线 → 新建 → 选「空白流水线」，命名 `X监控-日报`。

### 2. Trigger（定时）
- 点 **Trigger** → 添加 **定时触发** 插件
- cron 填：`0 22 * * *`
  - 说明：蓝盾定时通常按**服务器时区**。若蓝盾是北京时区(UTC+8)，KST 07:00 = 北京 06:00，填 `0 6 * * *`；若按 UTC 填 `0 22 * * *`。**建议先随便设个近时间手动验证一次时区**。

### 3. Stage → Job
- 添加 Stage → 添加 Job → 选 **Linux（Docker 公共构建机）**，镜像用默认（含 Python 环境）

### 4. Task：拉代码
- 加 **代码拉取** 插件，关联你的工蜂仓库，分支 `master`（或 `main`）

### 5. Task：Shell 脚本（核心）
- 加 **Shell** / **执行 Linux 脚本** 插件，粘贴以下内容（把 `MODE=daily`）：

```bash
set -e

# 若默认镜像无 python3，可换成有 python 的镜像；或用 pip3
python3 -m pip install --quiet requests jinja2

# 导出流水线变量为环境变量（Shell 里可直接用 ${变量}，但导出更保险）
export TWITTERAPI_IO_KEY="${TWITTERAPI_IO_KEY}"
export WECHAT_WEBHOOK_URL="${WECHAT_WEBHOOK_URL}"
export LLM_API_KEY="${LLM_API_KEY}"
export LLM_API_BASE="${LLM_API_BASE:-https://api.deepseek.com}"
export LLM_MODEL="${LLM_MODEL:-deepseek-chat}"

# 自测外网（首次部署可保留，验证后删掉）
curl -sS -m 10 -o /dev/null -w "twitterapi.io HTTP %{http_code}\n" https://api.twitterapi.io || echo "外网不通！"

cd scripts
python3 run_daily.py          # 周报流水线这里改成 run_weekly.py

# ---- git 回写数据与看板 ----
cd ..
git config user.name "bkci-bot"
git config user.email "bkci-bot@woa.com"
git add data docs
if git diff --staged --quiet; then
  echo "无变更，跳过提交"
else
  git commit -m "chore: update X monitor ($(date +%Y-%m-%d))"
  git push "https://oauth2:${GIT_TOKEN}@${GIT_REPO}" HEAD:master
fi
```

### 6. 保存
保存流水线。可点「执行」手动跑一次验证。

---

## 五、流水线 B（周报）配置步骤

完全复制流水线 A（蓝盾支持「复制流水线」），改两处：

1. **命名** `X监控-周报`
2. **Trigger cron** 改为 `0 23 * * 0`（KST 周一 08:00 = 周日 UTC 23:00；若北京时区填 `0 7 * * 1`）
3. **Shell 脚本** 里把 `python3 run_daily.py` 改成 `python3 run_weekly.py`

---

## 六、看板怎么看（内网无 Pages）

内网工蜂没有 GitHub Pages，看板 HTML 有三种查看方式：

1. **直接在工蜂网页打开** `docs/index.html`（工蜂支持在线预览文件；点 raw 或预览）
2. **每次运行后下载** `docs/` 目录看（git 回写后本地 pull 即可）
3. **周报全文推企微** —— 这本来就是你的主要出口，看板作为历史留存

> 若以后想要真正的网页托管，可考虑把 `docs/` 同步到内网静态托管（如 STKE/织云静态页、或部门内网 Nginx），我可以再帮你加一步 rsync/scp。

---

## 七、验证清单

- [ ] 手动执行日报流水线 → 日志出现 `twitterapi.io HTTP 200`、`已渲染看板`
- [ ] 仓库出现 `data/daily/YYYY-MM-DD.json` 和 `docs/index.html`（git 回写成功）
- [ ] 手动执行周报流水线 → 企微群收到周报消息
- [ ] 定时时区确认无误（先设近时间试跑一次）

---

## 八、常见问题

- **`git push` 403/401**：token 权限不足或过期，重新生成带 `write_repository` 的令牌。
- **`python3: not found`**：换含 Python 的构建镜像，或在 Shell 开头 `apt-get install -y python3 python3-pip`（公共构建机一般自带）。
- **定时不触发**：确认流水线已保存且启用；蓝盾定时最小间隔一般 ≥5 分钟；确认时区。
- **抓取 0 条**：首次运行是建立基线（只抓 24h），第二天起才有增量；或该账号近 24h 确无更新。
- **企微没收到**：确认 `WECHAT_WEBHOOK_URL` 正确、机器人未被移除；周报流水线才推送（日报不推）。
