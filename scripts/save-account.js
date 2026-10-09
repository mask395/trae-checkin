#!/usr/bin/env node
/**
 * 导出客户端「当前登录账号」为签到档案（session 格式）
 *
 * 用法：node save-account.js <账号名>
 * 流程：
 *   1. 在 Trae/TraeWork 客户端登录要导出的账号；
 *   2. 运行本脚本并给一个好认的名字（字母/数字/中文/下划线/短横线）；
 *   3. 在客户端切换到下一个账号，换名字再运行一次，直到所有账号导出完。
 * 重新导出同名账号会覆盖旧档案，用于登录态失效后刷新。
 *
 * 导出内容：accounts/<账号名>/session.json
 *   只含签到所需的最小会话（令牌、刷新令牌、客户端 ClientID、设备指纹、版本），
 *   约 1~2KB；云端刷新轮换后的新令牌也基于该结构持久化。
 *
 * 退出码：0=导出成功 1=找不到客户端登录态 2=参数（账号名）不合法
 *
 * 注意：accounts/ 下的 session.json 是该账号的登录凭证，等同于账号访问权，
 *       请勿外传、勿提交到 git。
 */
"use strict";
const fs = require("fs");
const path = require("path");
const { candidateOrder, sessionFromStorageFile } = require("./lib.js");

const name = process.argv[2];
if (!name || !/^[\w一-龥.\-]+$/.test(name)) {
  console.error("用法：node save-account.js <账号名>");
  console.error("账号名仅支持字母、数字、中文、下划线、短横线、点。");
  process.exit(2);
}

// candidateOrder()[0] = 本机最近更新的客户端登录态（即客户端当前登录账号）
const src = candidateOrder()[0];
if (!src) {
  console.error("未找到客户端 storage.json。请先安装并登录 Trae/TraeWork 桌面端。");
  process.exit(1);
}

// 从完整 storage.json 提取最小会话（内部完成 tc 解密与 ClientID 判定）
const session = sessionFromStorageFile(src);

// 写入 accounts/<账号名>/session.json；recursive 自动建目录，同名覆盖即刷新档案
const dir = path.join(__dirname, "..", "accounts", name);
fs.mkdirSync(dir, { recursive: true });
const dest = path.join(dir, "session.json");
fs.writeFileSync(dest, JSON.stringify(session, null, 2), "utf8");

console.log(`已导出账号 [${name}]（session 会话，${fs.statSync(dest).size}B）`);
console.log(`来源 : ${src}`);
console.log(`ClientID : ${session.clientId}`);
console.log(`存档 : ${dest}`);
console.log("下一步：在客户端切换到下一个账号，换个账号名再次运行本脚本。");
