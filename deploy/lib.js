#!/usr/bin/env node
/**
 * Trae 本地账号鉴权共用模块（只读）
 *
 * 负责：定位本地登录态 → 解密「tc 格式」→ 令牌临期自动刷新 → 带鉴权头发起请求。
 * 安全约定：令牌仅在内存/闭包中，本模块不打印令牌，也不把令牌写盘。
 * 端点与加解密方法逆向自官方客户端，可能随版本变化。
 *
 * 两种登录态来源：
 *   1) 默认：自动扫描本机客户端目录（Trae CN / TRAE SOLO CN 等）；
 *   2) 多账号：环境变量 TRAE_STORAGE_FILE 指向 accounts/<名>/storage.json 快照，
 *      checkin-all.js 遍历账号时逐个设置，本模块其余逻辑完全不变。
 */
"use strict";
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");

function storageCandidates() {
  // 多账号模式：checkin-all.js 通过环境变量指定某个账号导出的 storage.json 快照
  const override = process.env.TRAE_STORAGE_FILE;
  if (override && fs.existsSync(override)) return [override];
  const home = os.homedir();
  const roots = [
    path.join(home, "Library", "Application Support"),
    process.env.APPDATA || path.join(home, "AppData", "Roaming"),
  ];
  // 各版本客户端在 %APPDATA% 下的数据目录名（CN 个人版 / CN SOLO / 国际版）
  const names = ["Trae CN", "TRAE SOLO CN", "Trae", "TRAE SOLO"];
  const out = [];
  // 登录态文件固定位于 <客户端数据目录>/User/globalStorage/storage.json
  for (const root of roots) for (const n of names) out.push(path.join(root, n, "User", "globalStorage", "storage.json"));
  return out;
}

// 多客户端并存时按修改时间取最新的登录态，避免读到旧客户端的过期令牌
function candidateOrder() {
  return storageCandidates()
    .filter((p) => fs.existsSync(p))
    .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
}

// 两段 64 字节内置常量（逆向自官方客户端），异或后参与登录态密钥派生；属于固定算法参数，非账号密钥
const SALT_A = Uint8Array.from([82,9,106,213,48,54,165,56,191,64,163,158,129,243,215,251,124,227,57,130,155,47,255,135,52,142,67,68,196,222,233,203,84,123,148,50,166,194,35,61,238,76,149,11,66,250,195,78,8,46,161,102,40,217,36,178,118,91,162,73,109,139,209,37]);
const SALT_B = Uint8Array.from([31,221,168,51,136,7,199,49,177,18,16,89,39,128,236,95,96,81,127,169,25,181,74,13,45,229,122,159,147,201,156,239,160,224,59,77,174,42,245,176,200,235,187,60,131,83,153,97,23,43,4,126,186,119,214,38,225,105,20,99,85,33,12,125]);
function xor(a, b, n) { const r = new Uint8Array(n); for (let i = 0; i < n; i++) r[i] = a[i] ^ b[i]; return r; }

// 解密 storage.json 中「tc 格式」的登录态字符串，返回含 token/refreshToken/userId 等字段的对象
function decryptAuthValue(b64) {
  // 整体结构：6 字节固定头 + 32 字节随机盐(rb) + AES 密文(enc)
  const buf = Buffer.from(b64, "base64");
  const hd = buf.slice(0, 6), rb = buf.slice(6, 38), enc = buf.slice(38);
  // 固定头必须是 "tc" 0x05 0x10 0x00 0x00（0x74='t', 0x63='c'），否则不是本客户端的加密格式
  if (!(hd[0] === 0x74 && hd[1] === 0x63 && hd[2] === 0x05 && hd[3] === 0x10 && hd[4] === 0 && hd[5] === 0)) {
    throw new Error("未知的登录态加密格式（header 不匹配）");
  }
  // 两段内置常量异或还原出派生用盐值（与客户端实现一致）
  const salt = xor(SALT_A, SALT_B, 64);
  // 密钥派生：SHA-512( SHA-512(随机盐) + 内置盐 )，得到 64 字节摘要
  const finalHash = crypto.createHash("sha512")
    .update(Buffer.concat([crypto.createHash("sha512").update(rb).digest(), Buffer.from(salt)]))
    .digest();
  // 摘要前 16 字节作 AES-128-CBC 密钥，第 16~32 字节作 IV
  const dc = crypto.createDecipheriv("aes-128-cbc", finalHash.slice(0, 16), finalHash.slice(16, 32));
  const plain = Buffer.concat([dc.update(enc), dc.final()]);
  // 明文布局：前 64 字节 = 负载的 SHA-512（完整性校验），其余才是 JSON 负载
  const stored = plain.slice(0, 64);
  const payload = plain.slice(64);
  const computed = crypto.createHash("sha512").update(payload).digest();
  // 校验不一致说明密文损坏或加密格式已变化，拒绝继续（避免拿到半截/伪造数据）
  if (!stored.equals(computed)) throw new Error("解密校验失败（SHA-512 不符）");
  return JSON.parse(payload.toString("utf8"));
}

// 按修改时间从新到旧读取候选 storage.json，返回第一个含有效登录态的解密结果
function loadAuth() {
  for (const p of candidateOrder()) {
    if (!fs.existsSync(p)) continue;
    const storage = JSON.parse(fs.readFileSync(p, "utf8"));
    // 登录态在该键下（CN 版为 tc 加密串；国际版可能是明文 JSON）
    const enc = storage["iCubeAuthInfo://icube.cloudide"];
    if (!enc) continue;
    if (String(enc).trim().startsWith("{")) return JSON.parse(enc); // 国际版明文
    return decryptAuthValue(String(enc));
  }
  throw new Error("未找到 Trae 本地登录态（storage.json）。请先安装并登录 Trae/TraeWork 桌面端。");
}

// 读不到本机设备标识时的兜底：生成一个随机 32 位十六进制设备 ID
function devId() {
  return crypto.createHash("sha256").update(crypto.randomBytes(32).toString("hex")).digest("hex").substring(0, 32);
}

/**
 * 读取本机稳定的设备标识，避免每次请求随机生成导致指纹漂移。
 * 优先从 storage.json 读取；读不到才回退到随机值。
 * 返回 { machineId, deviceId }：
 *   machineId = telemetry.machineId（客户端「关于」里的 64 位设备ID）
 *   deviceId  = storage 里 iCubeAuthInfo://icube-dc:<n> 键名中的数字 Device Id
 */
function readDeviceIds() {
  const out = {};
  for (const p of candidateOrder()) {
    if (!fs.existsSync(p)) continue;
    const s = JSON.parse(fs.readFileSync(p, "utf8"));
    const machineId = s["telemetry.machineId"];
    if (typeof machineId === "string" && machineId) out.machineId = machineId;
    for (const k of Object.keys(s)) {
      const m = /^iCubeAuthInfo:\/\/icube-dc:(\d+)$/.exec(k);
      if (m && m[1]) { out.deviceId = m[1]; break; }
    }
    break;
  }
  return out;
}

/**
 * 读取本端已安装客户端的版本号（storage 里的 iCubeLastVersion，格式如 2.3.40353），
 * 跟随各安装端真实版本，而非硬编码。读不到时返回 null，交由调用方回退默认值。
 */
function readClientVersion() {
  let version = null;
  for (const p of candidateOrder()) {
    if (!fs.existsSync(p)) continue;
    const s = JSON.parse(fs.readFileSync(p, "utf8"));
    const v = s["iCubeLastVersion"];
    if (typeof v === "string" && v.trim()) { version = v.trim(); }
    break;
  }
  if (!version) return null;
  return {
    ideVersion: version,
    ideVersionCode: version.replace(/\./g, "") || version,
  };
}

/**
 * 按本机真实系统生成平台与系统版本头，安装到任何机器都会上报对应当前系统；
 * 而非硬编码为 Windows。
 */
function detectOs() {
  const platform = process.platform;
  const release = os.release();
  let deviceType = "unknown";
  let osVersion = platform;
  if (platform === "darwin") { deviceType = "mac"; osVersion = `Darwin ${release}`; }
  else if (platform === "win32") { deviceType = "windows"; osVersion = `Windows ${release}`; }
  else if (platform === "linux") { deviceType = "linux"; osVersion = `Linux ${release}`; }
  return { deviceType, osVersion };
}

// 组装每次 API 请求所需的鉴权与设备指纹头（尽量与真实客户端一致，降低旁路请求特征）
function buildHeaders(token, uid, fp = {}) {
  const osInfo = detectOs();
  return {
    "Authorization": `Cloud-IDE-JWT ${token}`,
    "X-Cloudide-Token": token,
    "x-uid": String(uid),
    "x-app-id": "6eefa01c-1036-4c7e-9ca5-d891f63bfcd8",
    "x-device-id": fp.deviceId || devId(),
    "x-machine-id": fp.machineId || crypto.randomBytes(32).toString("hex"),
    "x-request-id": crypto.randomUUID(),
    "x-ide-version": fp.ideVersion || "3.3.67",
    "x-ide-version-code": fp.ideVersionCode || "20260401",
    "x-device-type": osInfo.deviceType,
    "x-os-version": osInfo.osVersion,
    "Content-Type": "application/json",
    "Accept": "application/json",
  };
}

/**
 * 返回一个带令牌的客户端：
 *   client.lib  -> 登录态原文（含 userId / host / refreshToken，供需要时判断）
 *   client.post(path, body) -> 自动刷新令牌后 POST 并返回 { status, json }
 */
async function createClient() {
  const auth = loadAuth();
  const host = auth.host || "https://api.trae.cn";
  const uid = String(auth.userId || "");
  const device = readDeviceIds();
  const ver = readClientVersion();
  const fingerprint = {
    deviceId: device.deviceId,
    machineId: device.machineId,
    ideVersion: ver && ver.ideVersion,
    ideVersionCode: ver && ver.ideVersionCode,
  };
  let token = auth.token;
  let refreshing = null;

  // 用 refreshToken 换新的访问令牌；成功后只更新闭包内的 token，不落盘、不回写 storage.json
  async function refresh() {
    if (!auth.refreshToken) return false;
    // 并发请求同时触发刷新时，复用同一个刷新 Promise，避免多次 ExchangeToken 互相作废旧令牌
    if (refreshing) return refreshing;
    refreshing = (async () => {
      const r = await fetch(`${host}/cloudide/api/v3/trae/oauth/ExchangeToken`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ClientID: "ono9krqynydwx5",
          RefreshToken: auth.refreshToken,
          ClientSecret: "-",
          UserID: uid,
        }),
      });
      const j = await r.json();
      if (j && j.Result && j.Result.Token) { token = j.Result.Token; return true; }
      return false;
    })();
    try { return await refreshing; } finally { refreshing = null; }
  }

  // 访问令牌临近过期则先行刷新（避免并行请求各自 401 互相踩掉旧令牌）
  if (!auth.expiredAt || (new Date(auth.expiredAt).getTime() - Date.now()) < 30 * 60 * 1000) {
    await refresh();
  }

  return {
    lib: auth,
    host,
    userId: uid,
    async post(p, body) {
      const doFetch = () =>
        fetch(`${host}${p}`, { method: "POST", headers: buildHeaders(token, uid, fingerprint), body: JSON.stringify(body) });
      let resp = await doFetch();
      // 服务端判令牌失效（401）时刷新一次后原样重发；仍失败则把响应交给调用方处理
      if (resp.status === 401) { await refresh(); resp = await doFetch(); }
      // json() 解析失败（如空响应）时归一化为空对象，保证调用方不会因解析异常崩溃
      return resp.json().then((j) => ({ status: resp.status, json: j })).catch(() => ({ status: resp.status, json: {} }));
    },
  };
}

module.exports = { loadAuth, createClient, buildHeaders, decryptAuthValue, candidateOrder };