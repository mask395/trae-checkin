# Trae Work 每日自动签到

纯 Node.js 实现（**零第三方依赖**）的 Trae Work 每日积分签到工具：读取客户端登录态，自动完成签到。**推荐使用 GitHub Actions 云端定时运行——一次配置，每天自动签到，无需开机、无需手动操作**；也支持本地运行。

![Node.js](https://img.shields.io/badge/Node.js-%3E%3D18-green) ![License](https://img.shields.io/badge/license-MIT-blue)

## 功能

- 自动读取并解密 Trae 桌面客户端登录态（AES-128-CBC，密钥由机器信息派生）
- 令牌临期自动刷新（401 自动重试，并发刷新自动去重）
- 每日签到幂等：重复运行不会重复领取，也不会报错
- **多账号批量签到**：按 userId 去重，任一账号失败不影响其他账号
- 安全：令牌仅存在于内存，不打印、不写盘；仅请求官方 `api.trae.cn`

## 工作原理

1. 在客户端数据目录中定位 `storage.json`（自动识别 Trae CN / TRAE SOLO CN / 国际版，按修改时间取最新）
2. 解密其中「tc 格式」的登录态字符串，得到访问令牌、userId、设备指纹
3. 携带真实设备指纹（machineId 等）请求官方接口：先查询签到状态，未签则领取
4. 访问令牌过期时，用 refreshToken 自动换新令牌后重发请求

> 加解密方法与端点均来自对官方客户端的分析，客户端升级后可能失效。

## 推荐方式：GitHub Actions 云端定时运行

一次配置，之后每天自动签到，电脑关机也不受影响。

### 懒人方式：一键部署包（Windows）

不想看教程的用户：

1. 到 [Releases 页面](https://github.com/mask395/trae-checkin/releases) 下载 `Trae云端部署.zip` 并解压
2. 确保客户端已登录，双击 **一键部署到GitHub.bat**
3. 按窗口提示完成一次浏览器授权，剩余的 Fork、Secret、启用工作流全自动完成

> 首次运行若弹出 SmartScreen「Windows 已保护你的电脑」：点击 **更多信息 → 仍要运行**（本工具未购买商业代码签名证书）。

### 手动方式（5 步）

1. **Fork 本仓库**（点击页面右上角 Fork；建议随后在你 fork 的 Settings 中将其 **设为私有**）
2. **导出账号档案**：在登录了目标账号的电脑上，用本仓库的导出脚本生成档案（见文末「导出 storage.json」），再将 `storage.json` 压缩为单行后取 Base64——可节省空间，避免账号较多时超过 Secret 的 48KB 上限：

   **Windows PowerShell：**

   ```powershell
   node -e "const fs=require('fs');process.stdout.write(Buffer.from(JSON.stringify(JSON.parse(fs.readFileSync(process.argv[1],'utf8')))).toString('base64'))" "路径\accounts\account1\storage.json" | Set-Clipboard
   ```

   **macOS / Linux：**

   ```bash
   node -e 'const fs=require("fs");process.stdout.write(Buffer.from(JSON.stringify(JSON.parse(fs.readFileSync(process.argv[1],"utf8")))).toString("base64"))' 路径/accounts/account1/storage.json
   ```

3. **添加 Secret**：在你 fork 的仓库 **Settings → Secrets and variables → Actions** 中新建：
   - 名称：`TRAE_ACCOUNTS`
   - 值（多个账号用 `;` 分隔，账号数量任意，总长不超过 48KB）：

     ```
     account1=<storage.json 的 Base64>;account2=<storage.json 的 Base64>
     ```

4. **启用并验证**：进入 **Actions** 页面启用工作流，选择 **Trae 每日签到 → Run workflow** 手动运行一次，确认各账号签到成功
5. 之后每天北京时间 **09:10** 自动运行，无需任何操作

> Fork 来的仓库默认不启用定时 Actions，需手动开启并至少运行一次。

### 关于"设备每天限签一次"

服务端按**设备指纹**去重：同一台设备上登录的多个账号，每天只有一个能签到成功。因此云端配置的每个账号，应在**不同的物理设备**上登录并导出（即让云端"替每台设备签到"）；日志中出现"设备已签跳过"，即代表该账号与其他账号来自同一设备。

## 其他方式：本地运行（可选）

> 坦白说：如果你只有一台设备、且愿意每天手动打开客户端，那直接在客户端里点签到最省事；本地多账号需要反复切换登录，意义不大。本地方式更适合**单账号自动签到**或**开发调试**。

要求：已安装 [Node.js](https://nodejs.org/)（LTS 版），客户端已登录。

**单账号**（直接使用客户端当前登录态）：

```powershell
node scripts/checkin.js
```

**多账号**：每登录一个账号，导出一次档案：

```powershell
node scripts/save-account.js account1
# 在客户端切换登录下一个账号
node scripts/save-account.js account2
node scripts/checkin-all.js
```

Windows 用户也可双击 `run-checkin.cmd`（输出写入 `checkin.log`）；需要每日自动执行时，用「任务计划程序」调用 `run-checkin.cmd /s`。

### 导出 storage.json（云端部署的前置步骤）

在登录了目标账号的电脑上执行，账号档案会生成到 `accounts/<名称>/storage.json`：

```powershell
node scripts/save-account.js account1
```

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

## 隐私与安全

- 账号档案（`accounts/`、`storage.json`）等同账号访问权，已默认加入 `.gitignore`，**切勿提交或外传**
- GitHub Secrets 为加密存储，日志不会回显；仓库公开也不会泄露 Secret，其他人 fork 无法读取你的 Secret
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
node scripts/balance.js
```

## 思路参考：用一台电脑导出多个账号（Windows 沙盒）

> 以下仅为思路分享，作者**不提供相关工具、脚本或技术支持**，请自行研究并承担风险。

服务端按设备指纹去重，与公网 IP 无关（同一公司 NAT 出口后数百台设备均可正常签到即为佐证）。Windows 沙盒（Windows Sandbox）每次启动都是一个全新的隔离系统，其中首次安装的客户端会生成**真实的、互不相同的** machineId，因此可用于在一台物理电脑上为多个账号分别导出登录态：

1. 启用「Windows 沙盒」功能（仅 Win10/11 专业版/企业版），可通过 `.wsb` 配置文件把主机的一个文件夹（内含 `scripts`、便携 `node.exe`）以可读写方式挂载进沙盒；
2. 启动沙盒 → 安装客户端 → 登录第一个账号 → 运行 `scripts/save-account.js` 导出，档案经挂载文件夹落回主机；
3. 关闭沙盒（内容自动销毁），重新启动一个**新沙盒** → 登录下一个账号并导出，如此重复；
4. 将各账号的 Base64 按 `名字=...;名字=...` 格式合并写入 `TRAE_ACCOUNTS`，由 GitHub Actions 统一签到。

注意：该方式虽不伪造指纹，但"批量制造设备身份"的意图明显，仍处于平台规则的边缘地带，可能触发风控，请自行权衡。

## 关于本项目

本项目的全部代码、脚本与文档，均由作者使用 [Trae](https://www.trae.cn)（AI 原生 IDE）完成开发。

## License

[MIT](LICENSE)
