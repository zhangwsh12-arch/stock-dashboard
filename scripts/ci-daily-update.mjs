#!/usr/bin/env node
// ============================================================
// 每日更新汇总脚本 - 韩国游戏股价看板（工蜂 CI 专用入口）
// ============================================================
//
// 用途：
//   工蜂 CI（蓝盾流水线）不像 GitHub Actions 一样天然支持多 job + 精细化
//   的条件控制/权限声明，为了让流水线配置尽量简单（一个 Job 一个脚本步骤即可），
//   本脚本把原 daily-update.yml 中 update job 的全部步骤顺序封装起来：
//
//     1. fetch-data.mjs      —— 抓取股价数据（失败则整体失败，阻断后续）
//     2. fetch-news.mjs      —— 抓取行业新闻（失败仅告警，不阻断）
//     3. validate-data.mjs   —— 数据校验（失败则整体失败，不提交/不推送）
//     4. git commit + push   —— 提交 data/ 变更回工蜂仓库
//     5. notify-wecom.mjs    —— 企业微信推送（失败仅告警，不阻断整体退出码）
//
// 环境变量（与原脚本保持一致，工蜂 CI 流水线"变量"中配置）：
//   OPENAI_API_KEY     - 用于 fetch-news.mjs 的 AI 翻译（可选）
//   WECOM_WEBHOOK_URL  - 企业微信群机器人 Webhook（可选，未配置则跳过推送）
//   DASHBOARD_URL      - 看板访问地址，用于推送消息中的链接
//   FORCE_NOTIFY       - 'true' 时忽略每日去重，强制推送
//   CI_GIT_USER_NAME   - 提交使用的 git 用户名（默认 'coding-ci-bot'）
//   CI_GIT_USER_EMAIL  - 提交使用的 git 邮箱（默认 'wrenwszhang@tencent.com'，
//                        必须是工蜂账号绑定邮箱，否则会被 committer-check 拒绝）
//   SKIP_GIT_PUSH      - 'true' 时跳过 git commit/push（本地调试用）
//   EDGEONE_API_TOKEN  - EdgeOne Makers 的 API Token（配置了才会执行网站部署，
//                        因为 EdgeOne Pages 不支持直接导入工蜂仓库，改为 CLI 主动推送部署）
//   EDGEONE_PROJECT_NAME - EdgeOne Makers 项目名称
//                        （默认 'korea-stock-dashboard-overseas'，海外加速区域项目，
//                          因为自定义域名未在工信部备案，绑定 global 区域项目会要求备案）
//   EDGEONE_AREA       - EdgeOne Makers 加速区域，'overseas' 或 'global'（默认 'overseas'）
//
// 用法（工蜂 CI 流水线中一条命令即可）：
//   node scripts/ci-daily-update.mjs
// ============================================================

import { execFileSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { cpSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = join(__dirname, '..');

const GIT_USER_NAME = process.env.CI_GIT_USER_NAME || 'coding-ci-bot';
const GIT_USER_EMAIL = process.env.CI_GIT_USER_EMAIL || 'wrenwszhang@tencent.com';
const SKIP_GIT_PUSH = String(process.env.SKIP_GIT_PUSH || '').toLowerCase() === 'true';

function step(title) {
  console.log(`\n${'='.repeat(60)}\n▶ ${title}\n${'='.repeat(60)}`);
}

function run(cmd, args, { cwd = ROOT_DIR, allowFail = false } = {}) {
  try {
    execFileSync(cmd, args, { cwd, stdio: 'inherit', env: process.env });
    return true;
  } catch (e) {
    if (allowFail) {
      console.warn(`⚠️ [ci-daily-update] "${cmd} ${args.join(' ')}" 执行失败（非致命，已跳过）: ${e.message}`);
      return false;
    }
    console.error(`❌ [ci-daily-update] "${cmd} ${args.join(' ')}" 执行失败: ${e.message}`);
    process.exit(1);
  }
}

// ====== 1. 抓取股价数据（关键路径，失败即整体失败）======
step('1/5 抓取股价数据 (fetch-data.mjs)');
run('node', ['scripts/fetch-data.mjs']);

// ====== 2. 抓取行业新闻（非关键路径，失败仅告警）======
step('2/5 抓取行业新闻 (fetch-news.mjs)');
const newsOk = run('node', ['scripts/fetch-news.mjs'], { allowFail: true });
if (!newsOk) {
  console.warn('⚠️ fetch-news.mjs 本次运行失败，资讯数据未更新。请检查脚本是否存在语法错误或网络问题。');
}

// ====== 3. 数据校验（关键路径，失败即整体失败，不提交不推送）======
step('3/5 数据校验 (validate-data.mjs)');
run('node', ['scripts/validate-data.mjs']);

// ====== 4. 提交并推送数据变更 ======
step('4/5 提交并推送 data/ 变更');
if (SKIP_GIT_PUSH) {
  console.log('ℹ️ SKIP_GIT_PUSH=true，跳过 git commit/push（本地调试模式）');
} else {
  run('git', ['config', 'user.name', GIT_USER_NAME]);
  run('git', ['config', 'user.email', GIT_USER_EMAIL]);
  run('git', ['add', 'data/']);

  let hasChanges = true;
  try {
    execFileSync('git', ['diff', '--cached', '--quiet'], { cwd: ROOT_DIR });
    hasChanges = false; // exit code 0 表示无变更
  } catch {
    hasChanges = true; // exit code 非0 表示有变更（git diff --quiet 的约定）
  }

  if (hasChanges) {
    const kstDate = new Date(Date.now() + 9 * 60 * 60 * 1000).toISOString().slice(0, 16).replace('T', ' ');
    run('git', ['commit', '-m', `📊 自动更新股价数据 ${kstDate} KST`]);
    run('git', ['push']);
    console.log('✅ data/ 变更已提交并推送');
  } else {
    console.log('ℹ️ 无数据变更，跳过 commit/push');
  }
}

// ====== 5. 企业微信推送（非关键路径，失败仅告警）======
step('5/6 企业微信推送 (notify-wecom.mjs)');
const notifyOk = run('node', ['scripts/notify-wecom.mjs'], { allowFail: true });
if (!notifyOk) {
  console.warn('⚠️ 企业微信推送失败，请检查 WECOM_WEBHOOK_URL 是否正确配置。');
}

// ====== 6. 部署网站到 EdgeOne Makers（非关键路径，失败仅告警）======
// 说明：EdgeOne Pages/Makers 目前不支持直接导入工蜂（Coding）仓库自动部署，
// 因此改为在数据更新完成后，用 EdgeOne CLI 主动推送部署。
// 注意：不能直接对仓库根目录执行 deploy（会连 .git、脚本、系统文件一起打包，
// 之前在用户主目录下手动测试时就因此报过 EBUSY 错误），
// 这里先把网站真正需要的文件（index.html + data/）复制到一个干净的临时目录，
// 再对临时目录执行 deploy，用完即删除。
// 未配置 EDGEONE_API_TOKEN 时自动跳过（例如本地调试、或还没开通 EdgeOne Makers 时）。
step('6/6 部署网站到 EdgeOne Makers (edgeone makers deploy)');
const EDGEONE_API_TOKEN = process.env.EDGEONE_API_TOKEN || '';
// 项目已改为 overseas（海外）加速区域创建，因为自定义域名（Cloudflare 购买、未在工信部备案）
// 只能绑定到 overseas 区域的项目，绑定 global/中国大陆区域项目会被要求先备案。
const EDGEONE_PROJECT_NAME = process.env.EDGEONE_PROJECT_NAME || 'korea-stock-dashboard-overseas';
const EDGEONE_AREA = process.env.EDGEONE_AREA || 'overseas';
if (!EDGEONE_API_TOKEN) {
  console.log('ℹ️ 未配置 EDGEONE_API_TOKEN，跳过网站部署步骤（如需启用，请在流水线变量中配置该密钥）。');
} else {
  const deployDir = join(tmpdir(), `edgeone-deploy-${Date.now()}`);
  try {
    mkdirSync(deployDir, { recursive: true });
    cpSync(join(ROOT_DIR, 'index.html'), join(deployDir, 'index.html'));
    cpSync(join(ROOT_DIR, 'data'), join(deployDir, 'data'), { recursive: true });
    console.log(`ℹ️ 已准备干净部署目录: ${deployDir}（仅含 index.html + data/）`);

    const deployOk = run('npx', [
      '--yes', 'edgeone', 'makers', 'deploy', '.',
      '-n', EDGEONE_PROJECT_NAME,
      '-t', EDGEONE_API_TOKEN,
      '-a', EDGEONE_AREA,
    ], { cwd: deployDir, allowFail: true });
    if (!deployOk) {
      console.warn('⚠️ EdgeOne Makers 部署失败，请检查 EDGEONE_API_TOKEN / EDGEONE_PROJECT_NAME 是否正确。');
    } else {
      console.log('✅ 已触发 EdgeOne Makers 部署');
    }
  } catch (e) {
    console.warn(`⚠️ 准备部署目录或部署过程出错（非致命，已跳过）: ${e.message}`);
  } finally {
    try { rmSync(deployDir, { recursive: true, force: true }); } catch {}
  }
}

console.log('\n✅ [ci-daily-update] 每日更新流程全部完成');
