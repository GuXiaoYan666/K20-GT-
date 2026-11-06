# K20 GT 歌词引擎（lyric-hub）

把当前播放的歌曲歌词实时显示在 **MCHOSE K20 GT** 音响的小屏幕上。

项目由两部分组成：

- **后端**：Node.js 服务，读取 Windows SMTC 媒体信息，检索多源歌词，通过 HID 写入键盘屏幕。
- **M HUB 插件**：在 M HUB 顶部导航注入「歌词」入口，点击后在主窗口内打开原生内嵌歌词页（不是弹窗）。

> 非官方项目，与 MCHOSE / 迈从无隶属关系。安装会修改 `app.asar` 并自动备份，请阅读「注意事项」后再使用。

## 功能

- 自动跟随系统正在播放的歌曲（QQ 音乐、网易云音乐、Spotify、foobar2000 等支持 SMTC 的播放器）
- 多源歌词检索：网易云、QQ 音乐、酷我，带歌名/歌手/时长匹配打分，避免串歌
- 支持翻译歌词（优先显示原文，必要时显示翻译）
- 本地缓存，弱网/重复歌曲秒开
- M HUB 内嵌歌词页：滚动歌词、当前行高亮、播放进度、重新匹配、字号/对齐设置
- 全局快捷键 `Ctrl + Alt + K` 打开/关闭歌词页
- 托盘菜单：打开歌词页 / 打开发电机控制台 / 退出插件
- 退出时自动恢复键盘原本的屏幕内容

## 环境要求

- Windows 10 / 11（x64）
- 已安装 **MCHOSE HUB**（迈从驱动）
- K20 GT 键盘已连接（8K 接收器或 USB）
- Node.js 18+；没有安装时安装脚本会自动下载便携版 Node.js

## 安装

1. 从 Releases 下载源码包（或 `git clone` 本仓库），解压到任意目录。
2. 双击 **`一键安装.cmd`**，按提示允许管理员权限（UAC）。
3. 安装完成后 M HUB 会自动启动。

安装脚本会做这些事：

| 步骤 | 说明 |
| --- | --- |
| 定位 M HUB | 通过 manifest、运行中的进程、默认安装目录依次查找 |
| 备份 | 首次安装将 `resources/app.asar` 备份为 `app.asar.lyric-hub-backup` |
| 部署插件 | 复制 `lyric-hub/` 到 `M HUB/resources/app/lyric-hub/`（含后端与 `node_modules`） |
| 打补丁 | 解包 `app.asar`，在主进程入口顶部注入一行 `require(...)`，再重新打包 |
| 启动 | 启动 M HUB 并写入安装清单 |

> 部分杀毒软件会对「修改其他程序文件」敏感，如被拦截请将本项目目录加入信任。

## 使用

1. 打开 M HUB，顶部导航会出现 **歌词** 标签。
2. 点击「歌词」，主窗口内容区会切换为内嵌歌词页。
3. 播放音乐后歌词会自动出现；没有匹配到时可点「重新匹配」。
4. 点击其他标签、按 `Esc` 或再次点击「歌词」即可关闭。
5. 任何时候可用 `Ctrl + Alt + K` 快速开关。

## 卸载

双击 **`一键卸载.cmd`**（同样需要管理员权限）。脚本会：

- 结束 M HUB 相关进程
- 从 `app.asar` 中移除注入的插件入口
- 删除 `resources/app/lyric-hub/`
- 用备份还原 `app.asar`（如果备份存在）

## 目录结构

```
.
├─ lyric-hub/
│  ├─ index.js              # 插件主进程：协议、Tab 注入、轮询、iframe 容器
│  ├─ renderer/
│  │  └─ tab-inject.js      # 注入到 M HUB 渲染进程，克隆并绑定「歌词」Tab
│  └─ backend/
│     ├─ server.js          # HTTP API + SSE + 调度 + HID 推送
│     ├─ device.js          # K20 GT HID 通信与写入队列
│     ├─ lyrics.js          # 多源歌词检索、解析、打分、缓存
│     ├─ smtc.js            # 拉起 PowerShell 监听 SMTC
│     ├─ smtc.ps1           # SMTC 读取脚本（输出 JSON Lines）
│     └─ public/            # 内嵌页 Web UI（由自定义协议提供）
├─ install.ps1              # 安装 / 卸载（纯 PowerShell + asar CLI）
├─ download-node.ps1        # 便携版 Node.js 下载
├─ 一键安装.cmd
├─ 一键卸载.cmd
└─ 一键运行.cmd             # 仅运行后端，浏览器访问调试
```

## 本地开发

```powershell
npm install
npm start                     # 等价于 node lyric-hub/backend/server.js
```

浏览器打开 <http://127.0.0.1:8720> 可直接调试 Web UI（无需安装到 M HUB）。

调试插件主进程日志：

```powershell
$env:K20_LYRIC_DEBUG = "1"    # 输出 DOM 注入诊断
# 日志：%TEMP%\k20_lyric_plugin.log（超过 512KB 自动轮转为 .old）
```

## HTTP API

后端只监听 `127.0.0.1:8720`，不对外网开放。

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/state` | 当前状态、歌词、设备状态、日志 |
| GET | `/api/events` | SSE 实时推送（含 15s 心跳） |
| POST | `/api/manual` | 手动检索歌词 `{"title":"...","artist":"..."}` |
| POST | `/api/settings` | 更新设置（歌词页、字号、方向等） |
| POST | `/api/test` | 向键盘发送一条测试歌词 |
| POST | `/api/push` | 向键盘推送一行文本 `{"text":"..."}` |
| POST | `/api/sync` | 按插件提供的播放进度同步一行歌词 |
| POST | `/api/refresh` | 强制重新检索当前歌曲歌词 |
| POST | `/api/reconnect` | 重新连接 HID 设备 |
| POST | `/api/restore` | 恢复键盘原屏幕内容 |

## 工作原理

1. `smtc.ps1` 通过 WinRT `GlobalSystemMediaTransportControlsSessionManager` 读取当前会话，按固定间隔输出 JSON Lines。
2. `smtc.js` 解析会话，`server.js` 按歌名/歌手/时长去重并触发歌词检索。
3. `lyrics.js` 并行请求多个歌词源，解析 LRC，按歌名、歌手、时长打分，达到阈值才采用。
4. 播放进度变化时计算出当前歌词行，通过 HID 写入键盘屏幕；退出时恢复原内容。
5. 插件主进程注册 `mchose-lyric://` 自定义协议提供 UI，`/api/*` 反代到本地后端以保证同源；再用 iframe 覆盖 M HUB 主窗口 header 以下区域。

## 常见问题

**点「歌词」没有反应？**
先确认顶部是否出现「歌词」标签；若没有，查看 `%TEMP%\k20_lyric_plugin.log` 是否有 `attach` / `inject` 记录。M HUB 大版本更新后可能需要重新执行安装脚本。

**歌词一直显示「未找到」？**
不同平台曲库版本差异较大，匹配度低于 80% 会被拒绝以避免串歌。可在歌词页点「重新匹配」，或确认歌名/歌手信息是否被播放器改写（例如加了 Live/Remastered 后缀）。

**键盘没反应？**
确认键盘已连接、未被 M HUB 独占；在后端页面点「重新扫描」。若 8720 端口被其它程序占用，后端会启动失败，请释放端口。

**M HUB 更新后失效？**
更新会覆盖 `app.asar`。重新运行 `一键安装.cmd` 即可；备份文件不会被覆盖。

**如何彻底还原？**
运行 `一键卸载.cmd`，或手动用 `resources/app.asar.lyric-hub-backup` 覆盖 `app.asar` 并删除 `resources/app/lyric-hub/`。

## 注意事项

- 安装需要管理员权限，并且会修改 M HUB 的 `app.asar`。请自行评估风险，建议先备份整个 M HUB 安装目录。
- 本项目仅在本机运行，不会上传你的播放内容；歌词检索会访问网易云、QQ 音乐、酷我公开接口。
- 请遵守所在地区法律与音乐平台服务条款，仅将歌词用于个人学习与设备显示。

## 许可证

[MIT](LICENSE)

## 致谢

内嵌页交互参考了 pet-hub 的 inline-page 思路；pet-hub 相关代码与资源不包含在本仓库中。
