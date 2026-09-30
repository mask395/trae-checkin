#!/usr/bin/env node
/**
 * Trae 云端签到「一键部署」脚本
 *
 * 在本地只做准备工作，真正的签到全部发生在 GitHub Actions 云端，
 * 因此不受「同一台设备每天只能签一个账号」的限制。
 *
 * 流程：
 *   1. 读取并解密本机客户端当前登录账号（复用 scripts/lib.js）
 *   2. 让用户给账号起个英文名（默认取电脑名）
 *   3. 通过自带的 gh CLI 完成 GitHub 浏览器授权（无需手动创建令牌）
 *   4. Fork 官方仓库 mask395/trae-checkin
 *   5. 把账号（支持多账号累积）写入 TRAE_ACCOUNTS Secret
 *   6. 启用并立即运行签到工作流，回显第一次运行结果
 *
 * 用法：node deploy.js [--dry-run]
 *   --dry-run：只演示将要执行的步骤，不真正 fork / 写 Secret / 触发工作流
 */
"use strict";
const fs = require("fs");
const path = require("path");
const os = require("os");
const readline = require("readline");
const { spawn, spawnSync } = require("child_process");

const DRY_RUN = process.argv.includes("--dry-run");
const ROOT = path.join(__dirname, "..");                 // 便携包根目录
const MANAGED_DIR = path.join(ROOT, "managed");         // 本机已托管账号清单
const MANAGED_FILE = path.join(MANAGED_DIR, "accounts.txt");
const UPSTREAM = "mask395/trae-checkin";                // 上游开源仓库（本工具从它 fork）
const WORKFLOW_FILE = "checkin.yml";
const SECRET_NAME = "TRAE_ACCOUNTS";
const SECRET_LIMIT = 48 * 1024;                          // GitHub 单 Secret 大小上限 48KB

// lib.js 在本目录（打包时复制）；开发时回退到 scripts/lib.js
let lib;
try { lib = require(path.join(__dirname, "lib.js")); }
catch { lib = require(path.join(ROOT, "scripts", "lib.js")); }

// ---------- 终端工具 ----------
function line(s = "") { console.log(s); }
function info(s) { console.log(s); }
function ok(s) { console.log(`\x1b[32m✔\x1b[0m ${s}`); }
function warn(s) { console.log(`\x1b[33m! ${s}\x1b[0m`); }
function fail(s) { console.log(`\x1b[31mx ${s}\x1b[0m`); }

function ask(question, def) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    const tail = def ? `（直接回车用 ${def}）: ` : ": ";
    rl.question(question + tail, (a) => {
      rl.close();
      resolve((a || "").trim() || def);
    });
  });
}

// ---------- gh CLI 封装 ----------
// 优先使用便携包自带的 gh，其次使用 PATH 中的 gh（便于开发调试）
function ghPath() {
  const candidates = [
    path.join(ROOT, "runtime", "gh", "gh.exe"),                // gh >= 2.10x 便携版布局
    path.join(ROOT, "runtime", "gh", "bin", "gh.exe"),        // 旧版便携版布局
    path.join(ROOT, "runtime", "gh", "bin", "gh"),
  ];
  for (const c of candidates) if (fs.existsSync(c)) return c;
  return "gh";
}
const GH = ghPath();

// 执行 gh 命令并捕获输出；quiet=true 时不把参数打印到屏幕
function gh(args, opts = {}) {
  if (!opts.quiet) info(`  $ gh ${args.join(" ")}`);
  const r = spawnSync(GH, args, { encoding: "utf8", maxBuffer: 20 * 1024 * 1024 });
  return { code: r.status, out: (r.stdout || "").trim(), err: (r.stderr || "").trim() };
}

// 需要用户在终端里交互（如浏览器授权）时，直接继承当前窗口的输入输出
function ghInteractive(args) {
  info(`  $ gh ${args.join(" ")}`);
  const r = spawnSync(GH, args, { stdio: "inherit" });
  return r.status;
}

// 通过 stdin 传 Secret 值，避免命令行长度/转义问题
function ghSetSecret(repo, name, value) {
  if (DRY_RUN) { info(`  $ gh secret set ${name} --repo ${repo}  （stdin 传入 ${value.length} 字符）`); return true; }
  const r = spawnSync(GH, ["secret", "set", name, "--repo", repo], { input: value, encoding: "utf8" });
  return r.status === 0;
}

// ---------- 业务步骤 ----------

// 第 1 步：读取本机登录账号，并把整个 storage.json 压缩为单行后做 Base64
function readLocalAccount() {
  line("【1/6】读取本机 Trae 客户端登录态...");
  const auth = lib.loadAuth();                       // 解密后的登录态（含 userId/host）
  const storageFile = lib.candidateOrder()[0];      // 最新的 storage.json 完整路径
  if (!storageFile) throw new Error("未找到客户端 storage.json");
  const storage = JSON.parse(fs.readFileSync(storageFile, "utf8"));
  // 压缩为单行 JSON：内容字段完全不变，仅去掉缩进空白，可显著减小 Secret 体积
  const b64 = Buffer.from(JSON.stringify(storage), "utf8").toString("base64");
  ok(`已读取账号（userId: ${auth.userId || "未知"}）`);
  info(`  来源文件: ${storageFile}`);
  return { b64, userId: String(auth.userId || "") };
}

// 第 2 步：账号命名（云端 Secret 中的 key），只允许安全字符
async function nameAccount() {
  line("【2/6】为这个账号起个名字");
  const def = os.hostname().toLowerCase().replace(/[^a-z0-9_-]/g, "").slice(0, 18) || "pc";
  for (;;) {
    const n = await ask("  输入英文/数字名字（多台设备请用不同名字，如 home、office）", def);
    if (/^[A-Za-z0-9_-]{1,20}$/.test(n)) return n;
    warn("名字只能包含英文、数字、下划线、短横线，且不超过 20 个字符");
  }
}

// 第 3 步：确保已登录 GitHub；未登录则走浏览器一次性代码授权
function ensureLogin() {
  line("【3/6】检查 GitHub 登录状态...");
  let r = gh(["auth", "status"], { quiet: true });
  if (r.code === 0) {
    r = gh(["api", "user", "-q", ".login"], { quiet: true });
    ok(`已登录 GitHub：${r.out}`);
    return r.out;
  }
  if (DRY_RUN) { warn("dry-run：假设已登录，用户名为 your-name"); return "your-name"; }
  info("  接下来会打开浏览器，请按提示完成授权（无需自行创建令牌）：");
  const code = ghInteractive(["auth", "login", "--hostname", "github.com", "--git-protocol", "https", "--web"]);
  if (code !== 0) throw new Error("GitHub 授权失败，请重试");
  r = gh(["api", "user", "-q", ".login"], {quiet: true});
  ok(`登录成功：${r.out}`);
  return r.out;
}

// 第 4 步：Fork 上游仓库（已存在则跳过）
function ensureFork(login) {
  const repo = `${login}/trae-checkin`;
  line("【4/6】准备云端仓库（Fork）...");
  const exists = gh(["repo", "view", repo], { quiet: true }).code === 0;
  if (exists) { ok(`仓库已存在：https://github.com/${repo}`); return repo; }
  if (DRY_RUN) { info(`  $ gh repo fork ${UPSTREAM} --clone=false`); return repo; }
  const r = gh(["repo", "fork", UPSTREAM, "--clone=false"]);
  if (r.code !== 0) throw new Error(`Fork 失败：${r.err || r.out}`);
  ok(`已 Fork：https://github.com/${repo}`);
  return repo;
}

/**
 * 第 5 步：组装 TRAE_ACCOUNTS。
 * 本机已托管清单保存在 managed/accounts.txt，追加/更新当前账号；
 * 这样用户带着整个文件夹在多台设备间操作即可累积多个账号。
 */
function buildAccounts(name, b64, userId) {
  line("【5/6】组装账号清单...");
  if (!fs.existsSync(MANAGED_DIR)) fs.mkdirSync(MANAGED_DIR, { recursive: true });
  const entries = new Map();
  if (fs.existsSync(MANAGED_FILE)) {
    for (const item of fs.readFileSync(MANAGED_FILE, "utf8").split(";")) {
      if (!item.trim()) continue;
      const k = item.slice(0, item.indexOf("="));
      const v = item.slice(item.indexOf("=") + 1);
      if (k && v) entries.set(k, v);
    }
  } else if (!DRY_RUN) {
    warn("本机没有历史托管清单。若你之前已在其他电脑部署过别的账号，");
    warn("那些账号无法从 GitHub 读回，本次提交将只包含当前账号。");
    warn("多设备部署建议：用 U 盘/网盘带着整个文件夹操作，或始终在同一台电脑上累积。");
  }
  const before = entries.size;
  entries.set(name, b64);
  const secret = [...entries].map(([k, v]) => `${k}=${v}`).join(";");
  if (secret.length > SECRET_LIMIT) {
    throw new Error(`账号清单 ${secret.length} 字符，超过 GitHub Secret 48KB 上限，无法继续`);
  }
  fs.writeFileSync(MANAGED_FILE, secret);
  ok(`清单现含 ${entries.size} 个账号（本次${entries.size > before ? "新增" : "更新"} 1 个），长度 ${secret.length} 字符`);
  return secret;
}

// 第 6 步：写 Secret → 启用工作流 → 立即运行 → 等待结果并回显
async function deployAndRun(repo, secret) {
  line("【6/6】写入 Secret 并触发第一次云端签到...");
  if (!ghSetSecret(repo, SECRET_NAME, secret)) throw new Error("写入 Secret 失败");
  ok("Secret 已写入（加密存储，不回显）");

  if (DRY_RUN) {
    info(`  $ gh workflow enable ${WORKFLOW_FILE} --repo ${repo}`);
    info(`  $ gh workflow run ${WORKFLOW_FILE} --repo ${repo}`);
    return;
  }
  gh(["workflow", "enable", WORKFLOW_FILE, "--repo", repo]);   // fork 的 Actions 默认关闭
  gh(["workflow", "run", WORKFLOW_FILE, "--repo", repo]);

  info("  云端运行中，等待结果...");
  let runId = null;
  for (let i = 0; i < 12; i++) {
    await new Promise((r) => setTimeout(r, 5000));
    const r = gh(["run", "list", "--repo", repo, "--workflow", WORKFLOW_FILE, "--limit", "1",
      "--json", "databaseId,status,conclusion", "--jq", ".[0]"], { quiet: true });
    const m = /"databaseId":\s*(\d+)/.exec(r.out);
    if (m) runId = m[1];
    if (/"status":\s*"completed"/.test(r.out)) break;
  }
  if (!runId) { warn("已触发，但暂时查不到运行记录，可稍后到 Actions 页面查看"); return; }

  const log = gh(["run", "view", String(runId), "--log"], { quiet: true }).out;
  const interesting = log.split(/\r?\n/).filter((l) => /✔|✘|汇总|新签到/.test(l))
    .map((l) => l.replace(/^\S+\s+/, ""));
  line();
  info("======== 云端签到结果 ========");
  for (const l of interesting) info("  " + l);
  info(`  完整日志：https://github.com/${repo}/actions/runs/${runId}`);
}

async function main() {
  line("==============================================");
  line("  Trae 云端签到 · 一键部署工具");
  line("  签到在 GitHub 云端完成，本机不签到");
  if (DRY_RUN) line("  【演练模式 --dry-run，不会真正修改任何东西】");
  line("==============================================");
  line();

  const { b64, userId } = readLocalAccount();
  const name = await nameAccount();
  const login = ensureLogin();
  const repo = ensureFork(login);
  const secret = buildAccounts(name, b64, userId);
  await deployAndRun(repo, secret);

  line();
  ok("全部完成！以后每天北京时间 09:10 自动签到，无需任何操作。");
  line(`  仓库地址：https://github.com/${repo}`);
  line("  要增加新设备上的账号：把整个文件夹复制到那台设备，登录后再运行本工具。");
}

main().catch((e) => {
  fail(e && e.message ? e.message : String(e));
  line();
  line("部署未完成，请按上面的提示处理后重试；如无法解决可到上游仓库反馈：");
  line(`  https://github.com/${UPSTREAM}/issues`);
  process.exitCode = 1;
});
