# Remote Codex · 把微信变成 Codex 遥控器

用手机发一句话，让电脑上的 Codex 继续工作。

Remote Codex 将普通微信与 Windows 上的 Codex 连接起来。你可以在手机上发送任务、查看回复、切换项目，也可以把指令送进已有的 Codex 桌面聊天，沿用原来的上下文。代码、终端、Git 和测试都在电脑上执行，不需要把项目同步到手机。

> 当前版本：0.2.1。第三方社区项目，与 OpenAI、腾讯及微信无隶属关系。

## 项目特色

- **普通微信即可使用**：微信模式无需额外安装 iOS App、Tailscale，也无需公网 IP、端口转发或自建中继。
- **继续原有聊天**：绑定已有 Codex 桌面会话，手机指令会带上 `[微信]` 标记出现在该聊天中。
- **手机切换项目**：发送“切换项目”或“会话列表”，回复编号即可选择，重启后记住目标。
- **回复更清楚**：桌面模式只自动转发手机任务的最终答复，并附上完成、失败或停止标记，避免回传整个聊天历史。
- **支持图片**：微信普通图片保存到电脑后交给 Codex 查看，支持 PNG、JPEG、WebP；每条最多 4 张，每张最多 10 MiB。
- **可选项目白名单**：默认关闭，需要时用微信命令开启；限制项目不会让微信入口退出，仍可切回已批准的项目。
- **薄桥接程序**：主要使用 Node.js 标准库；微信二维码显示仅依赖一个二维码编码库。另保留原生 SwiftUI iOS 客户端。

## 使用前准备

**普通用户推荐：[下载 Windows x64 便携包](https://github.com/twodog41/codex-Remote/releases/latest)。** 选择 `RemoteCodex-0.2.1-windows-x64.zip`，完整解压到固定位置，再双击 **RemoteCodex.exe**（也可用“启动微信.cmd”）。首次输入项目文件夹路径，然后用微信扫码。无需安装 Node.js 或 npm；Codex 仍需安装并登录。

| 下载方式 | 是否需要安装 Node.js | 怎么启动 | 适合谁 |
| --- | --- | --- | --- |
| Release 中的 Windows 便携包 ZIP | 不需要，已包含运行环境和依赖 | 完整解压后双击 `RemoteCodex.exe` | 普通 Windows x64 用户 |
| GitHub “Code → Download ZIP”或克隆的源码 | 需要 Node.js 22+ 和 npm | 按下面的源码教程运行 | 开发者、想修改代码的用户 |
| Release 中单独的 `RemoteCodex.exe` | 它本身没有内置运行环境 | 放在完整便携包根目录运行 | 单独获取启动器，不是完整软件 |

**不要只下载 exe，也不要在压缩包内直接运行。** exe 是启动器，不是安装包或单文件完整程序；需要旁边的 `runtime`、`scripts`、`bridge` 和 `node_modules` 文件夹。Windows ARM64 尚未提供原生便携包。GitHub 自动生成的 Source code ZIP 也属于源码版。

从源码运行微信模式需要：

1. 一台能正常使用 Codex 的 Windows 电脑，以及已登录的 Codex 桌面 App 或 CLI。
2. Node.js 22 或更新版本，包含 npm；使用环境代理时，建议选择支持 `--use-env-proxy` 的版本。
3. 已下载的本项目源码，以及你现有的微信账号。

**用普通权限打开 PowerShell，不要以管理员身份启动遥控器。** 程序会拒绝管理员身份运行。

手机和电脑不用连接同一个 Wi-Fi，也没有距离限制。电脑必须保持开机、联网、唤醒，遥控启动窗口需要保持运行，可以最小化。继续桌面聊天时，Codex App 也需保持运行。

## 首次使用教程

### 1. 在电脑上启动

下载并解压源码，进入项目目录。下面两处路径请替换成你自己的路径：

```powershell
cd 'D:\工具\Remote-Codex'
.\scripts\wechat.ps1 -Project 'D:\项目\MyProject'
```

第一行是本软件所在目录，第二行是要让 Codex 工作的项目目录。首次启动会保存配置，并在缺少二维码依赖时自动安装依赖。

如果 PowerShell 提示不允许运行脚本，可以仅对当前窗口放行，再重新执行启动命令：

```powershell
Set-ExecutionPolicy -Scope Process Bypass
```

### 2. 用微信扫码连接

用自己的微信扫描终端显示的二维码，按微信提示确认。二维码太小时，在浏览器打开终端提示的 `weixin-login.svg` 文件。

如果微信显示配对码，只在电脑启动窗口中输入，不要把配对码发给其他人。账号能否完成授权，以实际扫码结果为准。

连接成功后，在微信产生的助手聊天中发送：

```text
只回复“连接成功”，不要执行任何命令或修改文件。
```

首次启动默认使用独立 Codex 会话。如果希望指令进入已有桌面聊天，继续下一步。

### 3. 绑定已有的 Codex 聊天

打开你想遥控的 Codex 桌面聊天，向其中的 Codex 发送以下请求，并把路径换成实际的软件目录：

```text
请将 D:\工具\Remote-Codex 中的微信遥控程序绑定到当前对话。
请使用该项目的 bridge/bind-desktop.mjs 和当前聊天 ID 完成绑定。
如果使用便携包，请使用该目录的 runtime/node.exe 执行脚本，不依赖系统 node 命令。
```

绑定需要从 Codex 内执行，普通 PowerShell 没有桌面 App 提供的连接信息。此功能依赖桌面 App 中可用的 `codex-app-tools` 插件接口；缺少该接口时，可继续使用独立模式。

绑定后，关闭旧微信启动窗口，双击项目目录里的 **启动微信.cmd**。启动信息显示已连接现有桌面聊天后，微信指令就会进入该聊天，使用原来的上下文。

> 绑定的是指定聊天。电脑上切换标签不会自动改变手机的遥控目标；手机切换目标也不会自动切换电脑显示的标签。

### 4. 日常使用

以后双击 **启动微信.cmd** 即可启动，通常无需再次扫码。发送“帮助”查看指令，直接发送自然语言安排任务，例如：

```text
检查当前项目的测试失败原因，修复后告诉我改了什么。
```

| 微信发送内容 | 功能 |
| --- | --- |
| 自然语言任务 | 交给当前目标聊天里的 Codex |
| `状态` | 查看目标项目、白名单开关和任务状态 |
| `切换项目` | 列出本地项目，回复编号选择 |
| `会话列表` | 选择同一项目或其他项目的已有聊天 |
| `取消` | 退出项目选择菜单 |
| `开启白名单` | 只允许已在电脑批准的项目 |
| `关闭白名单` | 取消项目名单限制，保留原名单 |
| `不回传`，换行后写任务 | 执行任务，但答复只在电脑查看 |
| `停止` | 桌面模式发送停止请求；独立模式请求实际中断 |
| `帮助` | 查看当前模式的使用说明 |

桌面模式每轮完成后回传最终答复，等待电脑审批或连接异常时会提示。项目列表从最近 50 个本地聊天中筛选，最多显示 20 个选项；不创建新聊天。切换项目不会自动停止原聊天的任务。

## 可选：启用项目白名单

白名单默认关闭；只想方便地使用所有本地项目，可以一直保持关闭。只有扫码绑定的微信账号能够遥控，这一身份限制不受白名单开关影响。

想限制可遥控的项目时，在微信发送 **开启白名单**。开关立即生效，重启后保留。初始批准名单只包含首次设置的项目，新增项目需在电脑的本软件目录执行：

```powershell
.\scripts\allow-project.ps1 -Project 'D:\项目\AnotherProject'
```

保存后重启微信入口。移出名单时加上 `-Remove`：

```powershell
.\scripts\allow-project.ps1 -Project 'D:\项目\AnotherProject' -Remove
```

如果当前绑定的项目不在名单中，入口会拒绝该项目的任务和聊天回传，但继续接收微信命令；发送 **切换项目** 返回已批准的项目，或发送 **关闭白名单** 取消限制。

## 权限与隐私

- **白名单限制的是可遥控项目，不是 Codex 的文件权限。** 桌面模式沿用 Codex App 的权限设置，审批和完全访问仍需在电脑处理。
- 桌面模式的“停止”是一条停止请求，不能当作任务已经停止。独立模式支持审批编号及完全访问确认，完全访问仅限下一轮、最多十分钟。详情见[微信使用说明](docs/wechat.md)。
- 配置保存在 `%LOCALAPPDATA%\RemoteCodex`，凭据与微信回复上下文使用 Windows 当前用户 DPAPI 保护；不要把配置、配对密钥或登录二维码提交到 GitHub。
- 指令检查发送时间、目标会话和重复消息；普通用户之外的消息、群消息及机器人自己的消息不会触发任务。
- 桌面聊天内容默认不自动回传，手机任务可用“不回传”关闭答复转发。程序还过滤部分常见密钥格式，但这不能识别所有敏感信息。
- 微信模式的指令、图片和回复会经过微信服务；发送前请自行判断内容是否适合通过微信传输。
- 下载图片默认最多保留七天，总空间上限 200 MiB。

需要停用遥控时，双击 **紧急停用遥控.cmd**。这会阻止新的遥控操作，但不会声称已停止正在执行的桌面任务。恢复时在电脑运行：

```powershell
.\scripts\enable-remote.ps1
```

然后重新启动入口。**紧急停止Codex.cmd** 是另一种操作，确认后会强制结束当前 Windows 用户的所有 Codex 进程树，可能中断多个任务。完整边界见[安全加固与停用说明](docs/hardening.md)。

## 常见问题

**找不到 codex.exe？**

启动脚本会查找 PATH、npm 安装和桌面 App 附带的 CLI。仍找不到时，指定真实的可执行文件路径后重新启动：

```powershell
$env:CODEX_BIN = 'C:\实际路径\codex.exe'
.\scripts\wechat.ps1
```

**网络需要代理？**

在启动窗口设置你自己的代理地址。以下端口仅为示例，需要本机确实有对应代理服务：

```powershell
$env:HTTP_PROXY = 'http://127.0.0.1:7890'
$env:HTTPS_PROXY = 'http://127.0.0.1:7890'
.\scripts\wechat.ps1
```

**提示微信接口错误 -2？**

程序会暂停重发，避免持续刷屏。稍后用绑定账号发送新的“状态”，程序会尝试刷新回复上下文；能否恢复仍取决于微信服务的实际响应。

**桌面 App 更新或重启后连接失败？**

在目标 Codex 聊天中重新执行绑定，再重启微信入口。桌面接入依赖安装的插件接口，兼容性可能随 App 或插件版本变化。

**关闭启动窗口后手机没反应？**

入口需要持续运行，当前不提供后台服务、开机自启或推送通知。重新双击 **启动微信.cmd**，并检查电脑是否休眠或断网。

## 可选：原生 iOS 客户端

仓库保留 SwiftUI iOS 客户端，通过 Tailscale 私网 HTTPS 连接 Windows 上的 `codex app-server` 桥接程序。该模式管理独立会话；无需把 Windows 项目复制到手机。

- Windows：运行 `scripts/setup.ps1 -Project <项目目录> -ShowToken`，再运行 `scripts/start.ps1`。
- Tailscale：为本机 `127.0.0.1:8787` 配置 Serve，将私网 HTTPS 地址及配对密钥填入手机。
- Mac：使用 Xcode 打开 `ios/RemoteCodex.xcodeproj`，配置签名并安装到 iOS 16+ 设备。

原生 App 需要 Mac、Xcode 和可用的 Tailscale；当前 Windows 开发环境未完成 iOS 编译及真机验收。微信模式不需要这些条件。接口说明见[协议文档](docs/protocol.md)。

## 开发与验证

构建 Windows x64 便携包（Windows PowerShell）：

```powershell
.\scripts\package-windows.ps1
```

打包脚本下载固定版本的官方 Node.js Windows 运行环境，并校验固定 SHA-256；使用锁文件安装依赖，保留 Node.js 和二维码库的许可文件。结果保存在 `dist/`，附带校验文件。构建需要联网，构建脚本本身无需系统 Node.js；包内不包含 Codex、个人配置、微信凭据、Git 元数据或登录二维码。也可在 GitHub Actions 手动运行 **Build Windows portable package** 下载构建产物。

验证便携包能在没有系统 Node.js/npm 的环境启动：

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File bridge/test/portable.test.ps1 -Package 'dist/RemoteCodex-0.2.1-windows-x64.zip'
```

```powershell
npm ci --ignore-scripts
npm test
powershell.exe -NoProfile -ExecutionPolicy Bypass -File bridge/test/safety.test.ps1
powershell.exe -NoProfile -ExecutionPolicy Bypass -File bridge/test/start.test.ps1
```

当前记录为 21 项 Node 自动测试通过，另有 Windows PowerShell 配置与启动测试。自动测试使用协议替身，不代表所有微信账号、Codex 版本或 iOS 设备都已验证。真实 Codex 冒烟测试可运行 `npm run smoke`，会使用正常模型额度。详细结果见[验证记录](VALIDATION.md)，第三方材料见[来源与声明](THIRD_PARTY_NOTICES.md)。

## 支持开发

如果这个项目帮你省下了守在电脑前的时间，欢迎自愿支持后续开发。支持与否不影响软件使用。

<img src="支持开发.jpg" alt="支持开发：微信支付二维码" width="300" />

## 给项目一颗 Star ⭐

如果你觉得 Remote Codex 有用，欢迎在 GitHub 上点一颗 **Star**，也欢迎提交 Issue 分享使用反馈。你的支持会帮助更多人发现这个项目。
