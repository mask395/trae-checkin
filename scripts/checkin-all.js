#!/usr/bin/env node
/**
 * Trae Work 多账号批量签到
 *
 * 账号档案布局：accounts/<账号名>/storage.json
 *   由 save-account.js 在客户端登录对应账号后导出。
 * 流程（每个账号独立）：查签到状态 -> 未签则领取，服务端按天幂等去重。
 * 按 userId 去重防止同一账号导出两份；任一账号失败不影响其他账号。
 * accounts 目录不存在或为空时，退回单账号模式（直接用客户端当前登录态）。
 *
 * 安全：令牌只在内存中，不打印/不写盘；只请求官方 api.trae.cn。
 *
 * 用法：node checkin-all.js
 * 退出码：0=全部账号成功（含已签/重复跳过） 1=至少一个账号失败或脚本异常
 */
"use strict";
const fs = require("fs");
const path = require("path");
const { createClient } = require("./lib.js");

// 账号档案根目录（本脚本位于 scripts/ 下，accounts/ 与其同级）
const ACC_DIR = path.join(__dirname, "..", "accounts");
// 官方签到接口：先查状态、再领取（均为 POST，相对 api.trae.cn 的路径）
const STATUS_API = "/trae/api/v2/ug/checkin_credits/status";
const CLAIM_API = "/trae/api/v2/ug/checkin_credits/claim";

// 扫描 accounts/ 下所有含 storage.json 的子目录，每个子目录视为一个账号，按名称排序
function listProfiles() {
  if (!fs.existsSync(ACC_DIR)) return [];
  return fs.readdirSync(ACC_DIR, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => ({ name: d.name, file: path.join(ACC_DIR, d.name, "storage.json") }))
    .filter((p) => fs.existsSync(p.file))
    .sort((a, b) => a.name.localeCompare(b.name, "zh-Hans-CN"));
}

// 处理单个账号：通过环境变量让 lib.js 读取该账号的快照；file 为 null 时回退到本机客户端登录态
async function signOne(profile) {
  if (profile.file) process.env.TRAE_STORAGE_FILE = profile.file;
  else delete process.env.TRAE_STORAGE_FILE;

  const client = await createClient();
  const status = await client.post(STATUS_API, {});
  if (!(status.json && status.json.code === 0)) {
    return {
      ...profile, userId: client.userId, ok: false, state: "status_fail",
      message: (status.json && status.json.message) || "HTTP " + status.status,
    };
  }
  const s = status.json;
  if (s.checked_in) {
    return {
      ...profile, userId: client.userId, ok: true, state: "already",
      message: `今日已签（基础 ${s.credits ?? "?"}${s.extra_credits != null ? " + 额外 " + s.extra_credits : ""}）`,
    };
  }
  // did_checked_in=true 表示本设备今天已由其他账号签到：服务端按设备每天限一次，
  // 属正常业务去重而非失败，计为跳过（否则每日定时任务会被误报为失败并无谓重试）
  if (s.did_checked_in) {
    return {
      ...profile, userId: client.userId, ok: true, state: "device_signed",
      message: "本设备今日已有账号签到，跳过（服务端按设备每天限一次）",
    };
  }
  const claim = await client.post(CLAIM_API, {});
  if (claim.json && claim.json.code === 0) {
    const c = claim.json;
    const gained = c.gained_credits ?? c.credits_gained ?? c.reward ?? c.extra_credits ?? null;
    return {
      ...profile, userId: client.userId, ok: true, state: "claimed",
      message: gained != null ? `签到成功，领取 ${gained} 积分` : "签到成功",
    };
  }
  // 兜底：状态接口未给 did_checked_in 时，领取返回 9095 同样表示设备今日已签
  if (claim.json && claim.json.code === 9095) {
    return {
      ...profile, userId: client.userId, ok: true, state: "device_signed",
      message: "本设备今日已有账号签到，跳过（服务端按设备每天限一次）",
    };
  }
  return {
    ...profile, userId: client.userId, ok: false, state: "claim_fail",
    message: (claim.json && claim.json.message) || "HTTP " + claim.status,
  };
}

async function main() {
  const profiles = listProfiles();
  // 没有任何账号档案时，退回单账号模式，直接使用客户端当前登录态（兼容老用法）
  const targets = profiles.length
    ? profiles
    : [{ name: "本机当前登录账号", file: null }];

  console.log(`== Trae Work 批量签到（${profiles.length ? profiles.length + " 个账号" : "单账号模式"}）==`);

  // seen 按服务端 userId 去重（同一账号导出两份档案时第二份跳过）
  const seen = new Set();
  const results = [];
  // 串行处理而非并发：避免多账号同时请求触发频控，输出顺序也与账号列表一致
  for (const p of targets) {
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
    } catch (e) {
      console.log("✘ 登录态读取/刷新失败：" + e.message);
      results.push({ name: p.name, ok: false, state: "error", message: e.message });
    }
  }
  delete process.env.TRAE_STORAGE_FILE;

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
