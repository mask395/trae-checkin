// 临时诊断：从云端 IP 复刻 li/da/xiao 的认证流程，定位拒绝环节。
// 只打印状态码与错误消息，绝不打印任何令牌内容。
"use strict";
const fs = require("fs");
const { buildHeaders } = require("./lib.js");

function parseEntries(file) {
  const out = new Map();
  if (!file || !fs.existsSync(file)) return out;
  for (const item of fs.readFileSync(file, "utf8").split(";")) {
    if (!item.trim() || !item.includes("=")) continue;
    const name = item.slice(0, item.indexOf("="));
    const value = item.slice(item.indexOf("=") + 1);
    try {
      const obj = JSON.parse(Buffer.from(value, "base64").toString("utf8"));
      if (obj && obj.v >= 1 && obj.refreshToken && obj.userId) out.set(name, obj);
    } catch (e) { console.log(`! 跳过 ${name}: ${e.message}`); }
  }
  return out;
}

function mergeSessions(a, b) {
  const out = new Map();
  for (const [k, v] of a) out.set(k, v);
  for (const [k, v] of b) {
    const old = out.get(k);
    if (!old || Number(v.refreshExpireAt || 0) >= Number(old.refreshExpireAt || 0)) out.set(k, v);
  }
  return out;
}

async function probe(name, sess) {
  const uid = String(sess.userId);
  const fp = { deviceId: sess.deviceId, machineId: sess.machineId, ideVersion: sess.ideVersion, ideVersionCode: sess.ideVersionCode };
  const headers = buildHeaders(sess.token, uid, fp);
  console.log(`--- [${name}] userId=${uid} clientId=${sess.clientId} tokenExpireAt=${sess.tokenExpireAt} refreshExpireAt=${sess.refreshExpireAt} ---`);

  const status1 = await fetch(`${sess.host}/trae/api/v2/ug/checkin_credits/status`, { method: "POST", headers, body: JSON.stringify({}) });
  const j1 = await status1.json().catch(() => ({}));
  console.log(`[${name}] STATUS#1 HTTP=${status1.status} code=${j1.code} msg=${(j1.message || "").slice(0, 70)}`);

  if (status1.status === 401 || (j1.code != null && j1.code !== 0)) {
    const r = await fetch(`${sess.host}/cloudide/api/v3/trae/oauth/ExchangeToken`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ClientID: sess.clientId, RefreshToken: sess.refreshToken, ClientSecret: "-", UserID: uid }),
    });
    const j = await r.json().catch(() => ({}));
    const res = j && j.Result;
    console.log(`[${name}] ExchangeToken HTTP=${r.status} code=${j.code} msg=${(j.message || (res && res.Message) || "").slice(0, 70)} hasToken=${!!(res && res.Token)} tokenExpireAt=${res && res.TokenExpireAt} refreshExpireAt=${res && res.RefreshExpireAt}`);
    if (res && res.Token) {
      const h2 = buildHeaders(res.Token, uid, fp);
      const status2 = await fetch(`${sess.host}/trae/api/v2/ug/checkin_credits/status`, { method: "POST", headers: h2, body: JSON.stringify({}) });
      const j2 = await status2.json().catch(() => ({}));
      console.log(`[${name}] STATUS#2(newToken) HTTP=${status2.status} code=${j2.code} msg=${(j2.message || "").slice(0, 70)} checked_in=${j2.checked_in}`);
    }
  }
}

(async () => {
  const bootstrap = parseEntries(process.env.TRAE_BOOTSTRAP_FILE);
  const state = parseEntries(process.env.TRAE_STATE_FILE);
  const merged = mergeSessions(bootstrap, state);
  for (const name of ["li", "da", "xiao"]) {
    const s = merged.get(name);
    if (!s) { console.log(`[${name}] 无条目`); continue; }
    await probe(name, s);
  }
  console.log("=== 诊断完成 ===");
})().catch((e) => { console.log("ERR", e.message); process.exit(1); });
