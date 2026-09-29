#!/usr/bin/env node
/**
 * Trae Work 每日签到
 * 先查签到状态，若今日未领取则调用领取接口，并报告进度/结果。
 * 领取是幂等的：服务器按天去重，重复运行不会重复发放，也不会报错。
 * 令牌仅在内存；端点/加密方法逆向自官方客户端，可能随版本变化。
 *
 * 用法：node checkin.js [--json]
 * 退出码：0=成功（含今日已签） 2=签到状态查询失败 3=领取失败 1=其他异常
 * 多账号批量签到请改用 checkin-all.js（本文件只处理本机当前登录的一个账号）。
 */
"use strict";
const { createClient } = require("./lib.js");

async function main() {
  const jsonOut = process.argv.includes("--json");
  // createClient 内部完成：读登录态 → 解密 → 必要时刷新令牌
  const client = await createClient();

  // 第 1 步：查询今日签到状态（code === 0 为业务成功标志）
  const status = await client.post("/trae/api/v2/ug/checkin_credits/status", {});
  if (!(status.json && status.json.code === 0)) {
    console.log(`[签到状态读取失败] ${(status.json && status.json.message) || "HTTP " + status.status}`);
    process.exit(2);
  }
  const s = status.json;

  // --json：机器可读输出（供其他程序调用），未签时顺带完成领取并附原始返回
  if (jsonOut) {
    let result = { status_read: true, checked_in: !!s.checked_in };
    if (!s.checked_in) {
      const claim = await client.post("/trae/api/v2/ug/checkin_credits/claim", {});
      result.claim = claim.json;
    }
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  // 以下为人类可读的控制台输出
  console.log("== Trae Work 每日签到 ==");
  console.log(`今日已签 : ${s.checked_in ? "是（跳过领取）" : "否"}`);

  if (s.checked_in) {
    console.log(`（已领取，无需重复签到。明日可领：基础 ${s.credits ?? "?"}` +
                `${s.extra_credits != null ? " + 额外 " + s.extra_credits : ""}）`);
    return;
  }

  // 第 2 步：今日未签，调用领取接口
  const claim = await client.post("/trae/api/v2/ug/checkin_credits/claim", {});
  if (claim.json && claim.json.code === 0) {
    const c = claim.json;
    // 不同客户端版本返回字段名可能不同，按优先级依次尝试取出积分数
    const gained = c.gained_credits ?? c.credits_gained ?? c.reward ?? c.extra_credits ?? "";
    console.log(`签到成功 ✔  ${gained ? "领取积分 " + gained : "已领取"}`);
    if (c.reward_info) console.log("奖励:", JSON.stringify(c.reward_info));
  } else {
    console.log(`签到失败 : ${(claim.json && claim.json.message) || ("HTTP " + claim.status)}`);
    if (claim.json) console.log("原始返回:", JSON.stringify(claim.json).slice(0, 300));
    process.exit(3);
  }
}

main().catch((e) => { console.error("错误：" + e.message); process.exit(1); });