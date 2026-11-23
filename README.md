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

## 三、打包生成安装包

> 若打包时报 `unable to verify the first certificate`（证书校验失败，通常是安全软件/代理拦截），先执行第一条设置环境变量。

```
$env:NODE_TLS_REJECT_UNAUTHORIZED=0
npm run package
```

打包完成后，`dist` 文件夹会生成两个关键文件：

- `dickson-color-studio Setup <版本号>.exe`（安装包）
- `latest.yml`（版本信息，程序检测更新用，**必须随包一起上传**）

## 四、发布新版到 GitHub（让"检查更新"生效）

1. 修改 `package.json` 里的 `version`（如 `1.0.0` → `1.0.1`，**只能递增，不能减小**）
2. 执行上面的打包命令，生成新的安装包和 `latest.yml`
3. 打开仓库：https://github.com/XDTX-01/dickson-app
4. 点 **Releases** → **Create a new release**
   - **Tag version** 填：`v<版本号>`（如 `v1.0.1`）
   - **Release title** 填：`<版本号>`（如 `1.0.1`）
5. 把 `dist` 里的 **Setup.exe** 和 **latest.yml** **两个文件都**拖进 "Attach binaries"
6. 点 **Publish release**

> ⚠️ 关键：
> - `latest.yml` 必须上传，否则客户端点"检查更新"检测不到新版。
> - 每次发版用**新生成的** `latest.yml`，版本号只增不减。

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
- 菜单栏：已移除"开发者工具"条目，`Version:` 下一行直接显示**授权剩余分钟数**（纯数字，如 `1440`，每 5 秒刷新）
  - 该数字由 `main.js` 的 `LICENSE_EXPIRE_MS` 计算，与 `protect/protect.cc` 里的 `EXPIRE_MS` 必须一致（当前 `1798761599000` = 2026-12-31 23:59:59）
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

