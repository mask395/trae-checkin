#!/usr/bin/env node
/**
 * Trae Work 只读积分查询
 * 查询积分/额度余额（usage_summary + 积分包），以及每日签到状态。
 * 只读不改动；令牌仅在内存。端点/加密方法逆向自官方客户端，可能随版本变化。
 *
 * 用法：node balance.js [--json]
 * 退出码：0=查询成功 1=异常（查询类脚本不因业务字段缺失而报错，只提示）
 */
"use strict";
const { createClient } = require("./lib.js");

async function main() {
  const jsonOut = process.argv.includes("--json");
  const client = await createClient();
  const auth = client.lib; // 登录态原文，这里只取 userRegion 用于展示

  // 并发调用两个只读接口：
  //   usage   —— 积分/额度用量汇总与积分包列表（req_source:1 = CN IDE 计费口径）
  //   checkin —— 今日签到状态与可领积分
  const [usage, checkin] = await Promise.all([
    client.post("/trae/api/v2/pay/ide_user_ent_usage", { require_usage: true, req_source: 1 }),
    client.post("/trae/api/v2/ug/checkin_credits/status", {}),
  ]);

  if (jsonOut) {
    console.log(JSON.stringify({ usage, checkin }, null, 2));
    return;
  }

  // 容错解析：接口字段缺失时回落为空对象/默认值，保证输出不崩
  const region = auth.userRegion;
  const us = usage.json.usage_summary || {};                 // 总量/已消耗/消耗比例
  const packs = usage.json.user_entitlement_pack_list || []; // 各积分包（来源描述 + 到期时间）
  const creditBilling = usage.json.is_credits_billing !== false;

  console.log("== Trae Work 积分查询 ==");
  console.log("账号区域 :", region ? (region.region || region._aiRegion || "CN") : "CN",
              creditBilling ? "· 积分制" : "· 美元用量计费");
  console.log("┌─ 积分/额度 ─────────────────────────");
  if (us.total_amount != null) {
    const total = Number(us.total_amount);
    const consumed = Number(us.consumed_amount || 0);
    const ratio = Number(us.consumption_ratio || 0);
    console.log(`│ 总量       : ${total}`);
    console.log(`│ 已消耗     : ${consumed}`);
    console.log(`│ 剩余(估算) : ${total - consumed}`);
    if (ratio > 0) console.log(`│ 消耗比例   : ${(ratio * 100).toFixed(2)}%`);
    console.log(`│ 积分包数量 : ${packs.length}`);
    packs.forEach((p, i) => {
      const info = p.entitlement_base_info || {};
      // end_time 是秒级 Unix 时间戳，乘 1000 转毫秒后只取日期部分
      const end = info.end_time ? new Date(info.end_time * 1000).toISOString().slice(0, 10) : "";
      console.log(`│   [${i + 1}] ${p.display_desc || info.entitlement_id || "?"}${end ? "  到期 " + end : ""}`);
    });
  } else {
    console.log("│（usage_summary 为空，可能接口/计费形态变化）");
  }
  console.log("└──────────────────────────────────────");
  console.log("┌─ 每日签到状态 ───────────────────────");
  if (checkin.json && checkin.json.code === 0) {
    const c = checkin.json; // checked_in=今日是否已领；credits=基础积分；extra_credits=额外奖励；enable=当前是否满足领取条件
    console.log(`│ 今日是否已签 : ${c.checked_in ? "是" : "否"}`);
    if (c.credits != null) console.log(`│ 可领基础积分 : ${c.credits}`);
    if (c.extra_credits != null) console.log(`│ 额外积分     : ${c.extra_credits}`);
    console.log(`│ 达标可领     : ${c.enable ? "是" : "否（未达标/不可领）"}`);
  } else {
    console.log("│（读取失败：" + ((checkin.json && checkin.json.message) || `HTTP ${checkin.status}`) + "）");
  }
  console.log("└──────────────────────────────────────");
}

main().catch((e) => { console.error("错误：" + e.message); process.exit(1); });