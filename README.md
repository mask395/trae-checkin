# Trae Work 每日自动签到

纯 Node.js 实现（**零第三方依赖**）的 Trae Work 每日积分签到工具：读取本地客户端登录态，自动完成签到；支持多账号、本地运行与 GitHub Actions 云端定时运行。

![Node.js](https://img.shields.io/badge/Node.js-%3E%3D18-green) ![License](https://img.shields.io/badge/license-MIT-blue)

## 功能

- 自动读取并解密 Trae 桌面客户端登录态（AES-128-CBC，密钥由机器信息派生）
- 令牌临期自动刷新（401 自动重试，并发刷新自动去重）
- 每日签到幂等：重复运行不会重复领取，也不会报错
- **多账号批量签到**：按 userId 去重，任一账号失败不影响其他账号
- 两种运行方式：本地一键脚本 / GitHub Actions 云端定时
- 安全：令牌仅存在于内存，不打印、不写盘；仅请求官方 `api.trae.cn`

## 工作原理

1. 在本机客户端数据目录中定位 `storage.json`（自动识别 Trae CN / TRAE SOLO CN / 国际版，按修改时间取最新）
2. 解密其中「tc 格式」的登录态字符串，得到访问令牌、userId、设备指纹
3. 携带真实设备指纹（machineId 等）请求官方接口：先查询签到状态，未签则领取
4. 访问令牌过期时，用 refreshToken 自动换新令牌后重发请求

> 加解密方法与端点均来自对官方客户端的分析，客户端升级后可能失效。

## 目录结构

```
.
├── scripts/
│   ├── lib.js           # 鉴权核心：定位/解密登录态、刷新令牌、组装请求
│   ├── checkin.js       # 单账号签到
│   ├── checkin-all.js   # 多账号批量签到
│   ├── balance.js       # 只读查询积分/额度与签到状态
│   └── save-account.js  # 导出客户端当前登录账号为档案
├── run-checkin.cmd      # Windows 一键启动器（失败重试 3 次，支持 /s 静默模式）
└── .github/workflows/
    └── checkin.yml      # GitHub Actions 云端定时签到
```

## 方式一：本地运行

要求：Windows + 已安装 [Node.js](https://nodejs.org/)（LTS 版），客户端已登录。

**单账号**（直接使用客户端当前登录态）：

```powershell
node scripts\checkin.js
```

**多账号**：每登录一个账号，导出一次档案：

```powershell
node scripts\save-account.js account1
# 在客户端切换登录下一个账号
node scripts\save-account.js account2
```

然后批量签到：

```powershell
node scripts\checkin-all.js
```

Windows 用户也可直接双击 `run-checkin.cmd`（输出写入 `checkin.log`）。需要每日自动执行时，用「任务计划程序」调用 `run-checkin.cmd /s`。

## 方式二：GitHub Actions 云端运行

1. Fork 本仓库（建议在仓库 Settings 中将 fork **设为私有**）
2. 确认客户端已登录，导出账号档案并取得 `storage.json` 的 Base64：

   **Windows PowerShell：**

   ```powershell
   [Convert]::ToBase64String([IO.File]::ReadAllBytes("路径\accounts\account1\storage.json"))
   ```

   **macOS / Linux：**

   ```bash
   base64 -w 0 路径/accounts/account1/storage.json
   ```

3. 在仓库 **Settings → Secrets and variables → Actions** 添加 Secret：
   - 名称：`TRAE_ACCOUNTS`
   - 值（多个账号用 `;` 分隔，账号数量任意）：

     ```
     account1=<storage.json 的 Base64>;account2=<storage.json 的 Base64>
     ```

4. 进入 **Actions** 页面，启用工作流后选择 **Trae 每日签到 → Run workflow** 手动验证一次
5. 之后每天北京时间 **09:10** 自动运行

> Fork 仓库默认不启用定时 Actions，需手动开启并至少运行一次。

### 关于"设备每天限签一次"

服务端按**设备指纹**去重：同一台设备上登录的多个账号，每天只有一个能签到成功。因此云端配置的每个账号，应在**不同的物理设备**上登录并导出（即让云端"替每台设备签到"），日志中出现"设备已签跳过"即代表该账号与其他账号来自同一设备。

## 隐私与安全

- 账号档案（`accounts/`、`storage.json`）等同账号访问权，已默认加入 `.gitignore`，**切勿提交或外传**
- GitHub Secrets 为加密存储，日志不会回显；请只在可信的私有仓库中使用
- 脚本不收集、不上传任何数据，所有请求仅发往官方域名

## 风险声明

本项目仅供学习与技术交流，用于理解客户端鉴权机制与自动化流程。自动化签到可能与平台服务条款存在冲突，云端机房 IP 等因素也可能触发平台风控（如要求重新登录、限制账号等）。**使用本脚本产生的一切后果由使用者自行承担**，请合理、克制使用。

## 常见问题

**Actions 提示登录态读取/刷新失败？**
对应账号可能已在客户端重新登录，旧快照失效。重新导出该账号的 `storage.json`，更新 Secret 即可。

**定时任务突然不运行了？**
仓库连续 60 天无活动，GitHub 会自动暂停定时工作流；任意提交一次即可恢复。

**如何查询积分余额？**

```powershell
node scripts\balance.js
```

## License

[MIT](LICENSE)
