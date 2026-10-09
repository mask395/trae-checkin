#!/usr/bin/env node
/**
 * Trae Work 多账号批量签到
 *
 * 账号档案（本地）：accounts/<账号名>/session.json（新）或 storage.json（旧格式兼容）
 *   由 save-account.js 在客户端登录对应账号后导出。
 *
 * 云端模式（GitHub Actions）通过三个环境变量驱动，不依赖 accounts/ 目录：
 *   TRAE_BOOTSTRAP_FILE：Secret TRAE_ACCOUNTS 还原的初始账号条目（首次部署/新加账号）
 *   TRAE_STATE_FILE    ：Actions Cache 中持久化的账号条目（含上次刷新轮换的新令牌）
 *   TRAE_STATE_OUT     ：本次运行后新状态的输出路径（运行结束后写入 Cache）
 *   条目格式：名称=Base64(session JSON);名称=Base64(...)（Base64 内容也兼容旧 storage.json）
 *   同名账号合并时，取 refreshExpireAt 更新的会话（重新登录或刷新过的一方）。
 *
 * 流程（每个账号独立）：查签到状态 -> 未签则领取，服务端按天幂等去重。
 * 按 userId 去重防止同一账号导出两份；任一账号失败不影响其他账号。
 * 没有任何账号档案时，退回单账号模式（直接用客户端当前登录态）。
 *
 * 安全：令牌只在内存中，不打印；只请求官方 api.trae.cn。
 *
 * 用法：node checkin-all.js
 * 退出码：0=全部账号成功（含已签/重复跳过） 1=至少一个账号失败或脚本异常
 */
"use strict";
const fs = require("fs");
const path = require("path");
const {
  createClient,
  buildSession,
  sessionFromStorageFile,
  decryptAuthValue,
} = require("./lib.js");

const ROOT = path.join(__dirname, "..");
// 账号档案根目录（本地模式）；云端合并会话的临时工作目录
const ACC_DIR = path.join(ROOT, "accounts");
const WORK_DIR = path.join(ROOT, ".run");
// 官方签到接口：先查状态、再领取（均为 POST，相对 api.trae.cn 的路径）
const STATUS_API = "/trae/api/v2/ug/checkin_credits/status";
const CLAIM_API = "/trae/api/v2/ug/checkin_credits/claim";

// ---------- 条目（entries）解析与合并 ----------

// 判断解码后的 JSON 是新 session（含 token+refreshToken）还是旧 storage 快照
function toSession(obj) {
  if (obj && obj.v >= 1 && obj.refreshToken && obj.userId) return obj;
  // 旧格式：storage.json 内容，转换为 session
  if (obj && obj["iCubeAuthInfo://icube.cloudide"]) {
    const enc = obj["iCubeAuthInfo://icube.cloudide"];
    const auth = String(enc).trim().startsWith("{") ? JSON.parse(enc) : decryptAuthValue(String(enc));
    return buildSession(auth, obj, "");
  }
  return null;
}

// 解析条目文件（名称=Base64;...），返回 Map<名称, session>
function parseEntries(file) {
  const out = new Map();
  if (!file || !fs.existsSync(file)) return out;
  for (const item of fs.readFileSync(file, "utf8").split(";")) {
    if (!item.trim() || !item.includes("=")) continue;
    const name = item.slice(0, item.indexOf("="));
    const value = item.slice(item.indexOf("=") + 1);
    try {
      const session = toSession(JSON.parse(Buffer.from(value, "base64").toString("utf8")));
      if (session) out.set(name, session);
    } catch (e) {
      console.log(`  ! 跳过无法解析的条目 ${name}：${e.message}`);
    }
  }
  return out;
}

// 合并两份会话（引导 Secret / 缓存状态）：同名取刷新令牌过期更晚的一方
function mergeSessions(a, b) {
  const out = new Map();
  for (const [k, v] of a) out.set(k, v);
  for (const [k, v] of b) {
    const old = out.get(k);
    if (!old || Number(v.refreshExpireAt || 0) >= Number(old.refreshExpireAt || 0)) out.set(k, v);
  }
  return out;
}

/**
 * 确定本次要处理的目标。
 *   云端：合并 bootstrap 与 state，会话写入 .run/<名>/session.json 供 createClient 读取；
 *   本地：扫描 accounts/ 下的 session.json / storage.json。
 * 返回 { targets, cloud, stateOut }
 */
function prepareTargets() {
  const bootstrap = process.env.TRAE_BOOTSTRAP_FILE;
  const stateFile = process.env.TRAE_STATE_FILE;
  const stateOut = process.env.TRAE_STATE_OUT;
  const cloud = !!(bootstrap || stateFile);

  if (cloud) {
    const merged = mergeSessions(parseEntries(bootstrap), parseEntries(stateFile));
    fs.rmSync(WORK_DIR, { recursive: true, force: true });
    const targets = [...merged.entries()]
      .sort((a, b) => a[0].localeCompare(b[0], "zh-Hans-CN"))
      .map(([name, session]) => {
        const dir = path.join(WORK_DIR, name);
        fs.mkdirSync(dir, { recursive: true });
        const file = path.join(dir, "session.json");
        fs.writeFileSync(file, JSON.stringify(session, null, 2), "utf8");
        return { name, sessionFile: file, storageFile: null };
      });
    return { targets, cloud, stateOut };
  }

  // 本地模式：扫描 accounts/ 子目录，优先 session.json，退回 storage.json
  const targets = fs.existsSync(ACC_DIR)
    ? fs.readdirSync(ACC_DIR, { withFileTypes: true })
        .filter((d) => d.isDirectory())
        .map((d) => {
          const base = path.join(ACC_DIR, d.name);
          const sessionFile = path.join(base, "session.json");
          const storageFile = path.join(base, "storage.json");
          return {
            name: d.name,
            sessionFile: fs.existsSync(sessionFile) ? sessionFile : null,
            storageFile: !fs.existsSync(sessionFile) && fs.existsSync(storageFile) ? storageFile : null,
          };
        })
        .filter((p) => p.sessionFile || p.storageFile)
        .sort((a, b) => a.name.localeCompare(b.name, "zh-Hans-CN"))
    : [];
  return { targets, cloud, stateOut: null };
}

// 处理单个账号：通过环境变量让 lib.js 读取该账号会话；file 都为 null 时用本机当前登录态
async function signOne(target) {
  if (target.sessionFile) {
    process.env.TRAE_SESSION_FILE = target.sessionFile;
    delete process.env.TRAE_STORAGE_FILE;
  } else if (target.storageFile) {
    process.env.TRAE_STORAGE_FILE = target.storageFile;
    delete process.env.TRAE_SESSION_FILE;
  } else {
    delete process.env.TRAE_SESSION_FILE;
    delete process.env.TRAE_STORAGE_FILE;
  }

  const client = await createClient();
  const status = await client.post(STATUS_API, {});
  if (!(status.json && status.json.code === 0)) {
    return {
      ...target, session: client.session, userId: client.userId, ok: false, state: "status_fail",
      message: (status.json && status.json.message) || "HTTP " + status.status,
    };
  }
  const s = status.json;
  if (s.checked_in) {
    return {
      ...target, session: client.session, userId: client.userId, ok: true, state: "already",
      message: `今日已签（基础 ${s.credits ?? "?"}${s.extra_credits != null ? " + 额外 " + s.extra_credits : ""}）`,
    };
  }
  // did_checked_in=true 表示本设备今天已由其他账号签到：服务端按设备每天限一次，
  // 属正常业务去重而非失败，计为跳过（否则每日定时任务会被误报为失败并无谓重试）
  if (s.did_checked_in) {
    return {
      ...target, session: client.session, userId: client.userId, ok: true, state: "device_signed",
      message: "本设备今日已有账号签到，跳过（服务端按设备每天限一次）",
    };
  }
  const claim = await client.post(CLAIM_API, {});
  if (claim.json && claim.json.code === 0) {
    const c = claim.json;
    const gained = c.gained_credits ?? c.credits_gained ?? c.reward ?? c.extra_credits ?? null;
    return {
      ...target, session: client.session, userId: client.userId, ok: true, state: "claimed",
      message: gained != null ? `签到成功，领取 ${gained} 积分` : "签到成功",
    };
  }
  // 兜底：状态接口未给 did_checked_in 时，领取返回 9095 同样表示设备今日已签
  if (claim.json && claim.json.code === 9095) {
    return {
      ...target, session: client.session, userId: client.userId, ok: true, state: "device_signed",
      message: "本设备今日已有账号签到，跳过（服务端按设备每天限一次）",
    };
  }
  return {
    ...target, session: client.session, userId: client.userId, ok: false, state: "claim_fail",
    message: (claim.json && claim.json.message) || "HTTP " + claim.status,
  };
}

// 把本次会话（含刷新轮换后的新令牌）序列化为条目文本
function serializeResults(results) {
  const parts = [];
  for (const r of results) {
    if (!r.session) continue;
    parts.push(`${r.name}=${Buffer.from(JSON.stringify(r.session), "utf8").toString("base64")}`);
  }
  return parts.join(";");
}

async function main() {
  const { targets, cloud, stateOut } = prepareTargets();
  // 没有任何账号档案时，退回单账号模式，直接使用客户端当前登录态（兼容老用法）
  const useTargets = targets.length ? targets : [{ name: "本机当前登录账号", sessionFile: null, storageFile: null }];

  console.log(`== Trae Work 批量签到（${targets.length ? targets.length + " 个账号" : "单账号模式"}）==`);

  // seen 按服务端 userId 去重（同一账号导出两份档案时第二份跳过）
  const seen = new Set();
  const results = [];
  // 串行处理而非并发：避免多账号同时请求触发频控，输出顺序也与账号列表一致
  for (const p of useTargets) {
    process.stdout.write(`\n[${p.name}] `);
    try {
      const r = await signOne(p);
      if (r.userId && seen.has(r.userId)) {
        r.ok = true;
        r.state = "duplicate";
        r.message = "与前面账号 userId 相同，跳过（同一账号勿重复导出）";
      } else if (r.userId) {
        seen.add(r.userId);
      }
      console.log((r.ok ? "✔ " : "✘ ") + r.message);
      results.push(r);
      // 云端：每处理完一个账号立即落盘状态，后续账号失败/重试时刷新结果不丢失
      if (cloud && stateOut) {
        fs.mkdirSync(path.dirname(stateOut), { recursive: true });
        fs.writeFileSync(stateOut, serializeResults(results), "utf8");
      }
    } catch (e) {
      console.log("✘ 登录态读取/刷新失败：" + e.message);
      results.push({ name: p.name, ok: false, state: "error", message: e.message, session: null });
    }
  }
  delete process.env.TRAE_SESSION_FILE;
  delete process.env.TRAE_STORAGE_FILE;
  // 清理云端临时工作目录（状态已序列化到 stateOut）
  if (cloud) fs.rmSync(WORK_DIR, { recursive: true, force: true });

  const claimed = results.filter((r) => r.state === "claimed").length;
  const already = results.filter((r) => r.state === "already").length;
  const deviceSigned = results.filter((r) => r.state === "device_signed").length;
  const dup = results.filter((r) => r.state === "duplicate").length;
  const failed = results.filter((r) => !r.ok);

  console.log("\n== 汇总 ==");
  console.log(`新签到 ${claimed} · 已签跳过 ${already} · 设备已签跳过 ${deviceSigned} · 重复跳过 ${dup} · 失败 ${failed.length}`);
  if (failed.length) {
    for (const f of failed) console.log(`  ✘ ${f.name}: ${f.message}`);
    console.log("\n失败处理：在客户端重新登录该账号，再运行 node scripts/save-account.js <账号名> 重新导出。");
    process.exit(1);
  }
}

main().catch((e) => {
  console.error("错误：" + e.message);
  process.exit(1);
});
