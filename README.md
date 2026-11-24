# Dickson-Color-Studio

Electron 可视化设计器应用（Vue2 + Element UI 前端 + 10 大类材质库）。

## 一、初始化与安装（首次）

```
npm init -y
npm install electron electron-builder --save-dev
```

## 二、运行应用（开发调试）

```
npm start
```

## 三、打包（只能走 CI，本地打的包不能给用户）

原生保护能力（`protect.node`）和混淆产物（`build-protect/`）都是 CI 里现做的：

- 本机没装 VS 时 `npm run build:native` 直接失败；
- 即使跳过原生模块，缺 `build-protect/manifest.json` 的包在用户机器上会弹"程序文件校验失败或已被修改"并退出。

所以本地 `npm run package` 的产物**只能用来检查资源是否齐全，不能发给用户**。真正出包靠 `.github/workflows/build-release.yml`。

## 四、发布新版（唯一路径：GitHub Actions）

1. **正常流程**：A 仓库构建前端 → 推 B 仓库 `dist` → 触发 C 仓库的 `repository_dispatch`，workflow 自动完成 编译原生模块 → 混淆 → 校验清单 → 打包 → 发 Release。
2. **应急手动**：仓库 Actions → 选 `LaLaLa` → Run workflow（`new_tag` 可填，留空则自动取最新 Release 补丁 +1）。
3. 版本号由 workflow 强制写入 `package.json`，本地不用手动改。
4. `latest.yml` 与 `.blockmap` 由 CI 自动上传，不需要手工拖文件。

> ⚠️ 原来的 `release.js` / `token.txt` 本地一键发布流程已删除：它不跑 native 与 protect，产出的安装包缺校验清单，用户装上会出现"打不开"；而 `--publish always` 还会覆盖 `latest.yml`，把已装用户自动更新到坏包。

## 五、检查更新界面（update-ui）

更新提示不再使用系统原生弹窗，改为独立的自绘窗口，界面文件在 `update-ui/`：

| 文件 | 作用 |
| --- | --- |
| `update-ui/index.html` | 六种状态的全部界面与交互（检查中 / 发现新版 / 下载中 / 已就绪 / 已最新 / 失败） |
| `update-ui/preload.js` | 通过 contextBridge 只暴露"读状态 + 发动作"，渲染进程保持 sandbox |

> ⚠️ 这两个文件**不能**放进 `src/`：CI 打包时会清空 `src` 再灌入 Vue 产物，放进去会被删掉。
> `package.json` 的 `build.files` 已加入 `update-ui/**/*`，无需再改。

界面上可选的选项：

- 发现新版本：**立即更新** / **稍后提醒** / **跳过此版本**
- 下载中：实时进度条（百分比、速度、已下载/总量、剩余时间）+ **取消下载** / **后台下载**
- 下载完成：**立即重启安装** / **稍后安装**（退出应用时自动装）
- 检查失败：**重试** / 关闭

界面里不提供任何可点开的外部地址（原先的"手动下载"和"查看发行说明"已移除），
主窗口也关闭了开发者工具（`devTools: false`，并屏蔽 F12 / Ctrl+Shift+I·J·C），
避免从客户端反查更新源与安装包下载地址。

行为细节：

- 启动 20 秒后后台静默检查一次，只有真有新版本才弹窗，不打断编辑
- 更新内容固定显示为"解决一些已知问题"（不展示远端 `releaseNotes`，文案在 `main.js` 的 `UPDATE_NOTES_TEXT`）
- "跳过此版本"会写入 `%APPDATA%/<应用名>/update-prefs.json`，之后静默检查不再提示该版本（手动检查仍会提示）
- 下载进度同时同步到主窗口任务栏进度条
- 菜单栏：已移除"开发者工具"条目，`Version:` 下一行直接显示**授权剩余分钟数**（纯数字，如 `1440`）
  - 该数字由原生模块的 `expireAt()` 计算，到期时间**只在** `protect/protect.cc` 里定义一处（`EXPIRE_MS`，当前 `1798761599000` = 2026-12-31 23:59:59 UTC），JS 侧不再保留第二份常量，改时间只改一处
  - 菜单只在显示内容（IP / 剩余分钟 / 版本）变化时才重建，不会每 5 秒把用户正在打开的菜单关掉
  - 运行期间每 60 秒复查一次到期时间，软件挂着跨过到期点同样会触发，而不是只在启动时判一次
- 更新源为 GitHub Releases + 腾讯云 COS，**两个源同时并发探测**（每个源一个独立 updater 实例）
  - 单源探测超时 15 秒，慢源/被墙源不会拖住整体：总耗时 ≈ 最慢的那个源，而不是两个源相加
  - 版本号优先；版本相同时选响应更快的源（通常也下载更快），界面会显示该源响应耗时
  - 探测结果直接复用，胜出的源立刻开始下载，不会再多查一次
  - 下载中断（非用户取消）时自动切换另一个源续下，界面提示"备用源已接管"，不弹错误框

本地预览界面（不用打包、不联网，用假数据走完 发现新版 → 下载 → 就绪）：

```
$env:DICKSON_UPDATE_DEMO="1"; npm start
```

也可以直接用浏览器打开 `update-ui/index.html?preview=available`（可选 `downloading` / `ready` / `latest` / `error` / `checking`）看样式。

## 六、完整性校验与沙箱

- `npm run protect` 除了混淆 `app.js`，还会生成 `build-protect/manifest.json`，把 `build-protect/app.js`、`src/index.html`、`src/preload.js`、`update-ui/index.html`、`update-ui/preload.js` 的 sha256 全部登记进去；启动时 `bootstrap.js` 逐文件比对，任何一个被改过就弹窗提示并退出（以前只校验 `app.js`，改界面 HTML 完全发现不了）。`package.json` 刻意不纳入：CI 会在打包前改写 version，纳进去会让所有人都对不上
- 文件放在 asar 里，C++ 的 ifstream 读不到，所以改由 Node 读出内容交给原生模块 `verifyBuffer()` 算哈希
- 渲染进程沙箱默认开启；只有确认被策略禁用的环境才用 `DICKSON_NO_SANDBOX=1` 关闭，不要无条件加 `--no-sandbox`
- 硬件加速默认开启（滚动、材质缩略图、高分屏靠 GPU 合成）。GPU 进程崩溃按次数分级处理：第 1 次只记日志，第 2 次写入永久标记（下次启动软件渲染），第 3 次直接带 `--disable-gpu` 重启。要强制软件渲染用 `DICKSON_NO_GPU=1`；被标记降级后想恢复，设 `DICKSON_GPU=1` 或删掉 `%APPDATA%\dickson-color-studio\gpu-fallback.json`。崩溃记录见 `%APPDATA%\dickson-color-studio\logs\gpu.log`
- 安装包目前**没有代码签名**。要过 SmartScreen 并真正挡住 asar 被整体替换，需要在 CI 里配置 `CSC_LINK`（证书 p12 的 base64 或路径）和 `CSC_KEY_PASSWORD` 环境变量，electron-builder 会自动签名；没有证书时这一步只能先空着


