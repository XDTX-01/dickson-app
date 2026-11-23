const {
  app,
  BrowserWindow,
  Menu,
  dialog,
} = require("electron");
const { autoUpdater } = require("electron-updater");
const path = require("path");
const os = require("os");
const fs = require("fs/promises"); // 使用Promise版本的fs
// 原生保护模块：过期判定、文件完整性自检（C++ 编译，无明文逻辑）
// 本地开发（无编译产物）时降级为桩函数，保证 npm start 可直接跑；生产环境加载真实模块
// 部分受限环境（沙箱代理被策略禁用）渲染进程会直接崩溃，关闭沙箱保证可运行
app.commandLine.appendSwitch("no-sandbox");
app.disableHardwareAcceleration(); // 部分机器 GPU 初始化导致渲染进程崩溃，关闭硬加速
let native = null;
try {
  native = require("./protect/protect.node");
} catch (_) {
  native = { checkExpiry: () => 0, verifyFile: () => true };
}

// ------------------------- 常量与配置 -------------------------
const CONSTANTS = {
  APP_ICON: path.join(__dirname, "src/icon.ico"),
  INDEX_HTML: path.join(__dirname, "src/index.html"),
  PRELOAD_SCRIPT: path.join(__dirname, "src/preload.js"),
  SHORTCUTS: {
    REFRESH: "Ctrl+R",
    DEV_TOOLS: "F12",
    ZOOM_RESET: "Ctrl+0",
  },
  ZOOM_LIMITS: { MIN: 0.5, MAX: 2.0 }, // 缩放限制
};

// ------------------------- 工具函数 -------------------------
function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

// ------------------------- 核心功能 -------------------------
// 单实例锁
const gotTheLock = app.requestSingleInstanceLock();
if (!gotTheLock) {
  app.quit();
  return; // 未拿到锁立即终止，避免继续注册窗口与事件
}

// 获取应用版本（Promise化）
async function getAppVersion() {
  try {
    const data = await fs.readFile(
      path.join(__dirname, "package.json"),
      "utf8"
    );
    const packageJson = JSON.parse(data);
    return packageJson.version;
  } catch (err) {
    console.error("读取版本失败:", err);
    return "未知版本";
  }
}

// 获取网络状态
function getNetworkStatus() {
  const interfaces = os.networkInterfaces();
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name]) {
      if (iface.family === "IPv4" && !iface.internal) {
        return {
          status: "已连接",
          ip: iface.address,
        };
      }
    }
  }
  return { status: "未连接", ip: "无" };
}

// ------------------------- 窗口管理 -------------------------
function createWindow() {
  const win = new BrowserWindow({
    width: 800,
    height: 600,
    icon: CONSTANTS.APP_ICON,
    webPreferences: {
      preload: CONSTANTS.PRELOAD_SCRIPT,
      contextIsolation: true, // 渲染进程与 preload 隔离，防止页面直接触碰 Node
      nodeIntegration: false, // 禁止页面使用 Node API
      sandbox: true, // 启用渲染进程沙箱
    },
  });

  win.loadFile(CONSTANTS.INDEX_HTML);

  // 快捷键统一由下方应用菜单的 accelerator 提供（仅在本应用内生效），
  // 不再使用 globalShortcut，避免拦截系统及其他应用的全局按键。

  // 优化后的缩放逻辑（带限制）
  function handleZoom(delta = 0.1) {
    const current = win.webContents.getZoomFactor();
    win.webContents.setZoomFactor(
      clamp(
        current + delta,
        CONSTANTS.ZOOM_LIMITS.MIN,
        CONSTANTS.ZOOM_LIMITS.MAX
      )
    );
  }

  // 菜单更新（Promise化）
  async function updateMenu() {
    const [networkInfo, appVersion] = await Promise.all([
      Promise.resolve(getNetworkStatus()),
      getAppVersion(),
    ]);

    const template = [
      {
        label: "文件",
        submenu: [
          {
            label: "退出",
            accelerator: "Ctrl+Q",
            click: () => app.quit(),
          },
        ],
      },
      {
        label: "查看",
        submenu: [
          {
            label: "刷新",
            accelerator: CONSTANTS.SHORTCUTS.REFRESH,
            click: () => win.reload(),
          },
          {
            label: "开发者工具",
            accelerator: CONSTANTS.SHORTCUTS.DEV_TOOLS,
            click: () => win.webContents.openDevTools(),
          },
          {
            label: "放大",
            accelerator: "Ctrl+=",
            click: () => handleZoom(0.1),
          },
          {
            label: "缩小",
            accelerator: "Ctrl+-",
            click: () => handleZoom(-0.1),
          },
          {
            label: "重置缩放",
            accelerator: CONSTANTS.SHORTCUTS.ZOOM_RESET,
            click: () => win.webContents.setZoomFactor(1),
          },
        ],
      },
      {
        label: `网络状态: ${networkInfo.status}，本机 IP: ${networkInfo.ip}`,
        enabled: false,
      },
      { label: `Version: ${appVersion}`, enabled: false },
      { label: "授权有效", enabled: false },
      {
        label: "检查更新",
        click: () => checkForUpdates(),
      },
    ];

    Menu.setApplicationMenu(Menu.buildFromTemplate(template));
  }

  // 初始化及定时更新（倒计时需周期性刷新）
  updateMenu();
  setInterval(updateMenu, 5000);

  // 鼠标滚轮缩放（带Ctrl键检测）
  win.webContents.on("mouse-wheel", (event, _, deltaY) => {
    if (event.ctrlKey) {
      event.preventDefault();
      handleZoom(deltaY > 0 ? 0.1 : -0.1);
    }
  });

  return win; // 返回窗口引用以便后续操作
}

// ------------------------- 自动更新（electron-updater，多更新源取最高版本） -------------------------
let updateCheckInProgress = false;
let isProbing = false; // 是否处于"探测各源版本"阶段（此时不弹窗、不下载）

// 更新源列表：GitHub 与 腾讯云 COS 都会检查，软件自动选"最新版本更高"的那个源下载。
const UPDATE_SOURCES = [
  {
    provider: "github",
    owner: "XDTX-01",
    repo: "dickson-app",
  },
  {
    provider: "generic",
    url: "https://dickson-app-1313952720.cos-website.ap-guangzhou.myqcloud.com/app-update/",
    channel: "latest",
  },
];

function applyFeedURL(source) {
  autoUpdater.setFeedURL(source);
}

// ------------------------- 下载进度窗 -------------------------
let progressWin = null;

function openProgressWindow(version) {
  if (progressWin) return;
  const parent = BrowserWindow.getAllWindows()[0];
  progressWin = new BrowserWindow({
    width: 440,
    height: 215,
    resizable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    parent: parent || undefined,
    modal: !!parent,
    title: "正在下载更新",
    autoHideMenuBar: true,
    webPreferences: { sandbox: true, contextIsolation: true },
  });
  const html = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<style>
  body { font-family: "Microsoft YaHei", sans-serif; background: #f5f6f8; margin: 0; padding: 26px 28px; }
  .title { font-size: 15px; font-weight: 600; color: #1f2937; margin-bottom: 16px; }
  .rack { height: 10px; background: #e5e7eb; border-radius: 6px; overflow: hidden; }
  .bar { height: 100%; width: 0; background: #3b82f6; border-radius: 6px; transition: width .15s linear; }
  .pct { font-size: 24px; font-weight: 700; color: #2563eb; margin-top: 14px; }
  .info { font-size: 12px; color: #6b7280; margin-top: 6px; }
</style>
</head>
<body>
  <div class="title">正在下载新版本 v__VER__ …</div>
  <div class="rack"><div class="bar" id="bar"></div></div>
  <div class="pct" id="pct">0.0%</div>
  <div class="info" id="info"></div>
</body>
</html>`;
  progressWin.loadURL(
    "data:text/html;charset=utf-8," + encodeURIComponent(html.replace("__VER__", version || ""))
  );
  progressWin.on("closed", () => {
    progressWin = null;
  });
}

function setProgress(p) {
  if (!progressWin || !p) return;
  const pct = (p.percent || 0).toFixed(1);
  const mb = (n) => ((n || 0) / 1048576).toFixed(1);
  const speed = ((p.bytesPerSecond || 0) / 1024).toFixed(0);
  progressWin.webContents
    .executeJavaScript(
      `document.getElementById("pct").textContent = "${pct}%";` +
        `document.getElementById("bar").style.width = "${pct}%";` +
        `document.getElementById("info").textContent = "${mb(p.transferred)} MB / ${mb(
          p.total
        )} MB · ${speed} KB/s";`
    )
    .catch(() => {});
}

function closeProgressWindow() {
  if (progressWin) {
    progressWin.close();
    progressWin = null;
  }
}

// 简单版本号比较：a>b 返回1，a<b 返回-1，相等返回0（支持 1.0.4 / 1.0.5 等）
function compareVersions(a, b) {
  const pa = String(a).split(".").map((n) => parseInt(n, 10) || 0);
  const pb = String(b).split(".").map((n) => parseInt(n, 10) || 0);
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const na = pa[i] || 0;
    const nb = pb[i] || 0;
    if (na > nb) return 1;
    if (na < nb) return -1;
  }
  return 0;
}

function initAutoUpdater() {
  autoUpdater.logger = console;
  autoUpdater.autoDownload = true; // 检测到更新自动下载
  autoUpdater.autoInstallOnAppQuit = true; // 退出时自动安装

  autoUpdater.on("checking-for-update", () => {
    if (isProbing) return; // 探测阶段不弹窗
    dialog.showMessageBox({ type: "info", title: "检查更新", message: "正在检查更新，请稍候..." });
  });
  autoUpdater.on("update-available", (info) => {
    if (isProbing) return; // 探测阶段不弹窗
    updateCheckInProgress = false;
    openProgressWindow(info.version); // 打开下载进度窗，后续由 download-progress 刷新
  });
  autoUpdater.on("download-progress", (p) => {
    if (isProbing) return; // 探测阶段不刷新
    setProgress(p);
  });
  autoUpdater.on("update-not-available", () => {
    if (isProbing) return; // 探测阶段不弹窗
    updateCheckInProgress = false;
    closeProgressWindow();
    dialog.showMessageBox({ type: "info", title: "检查更新", message: "当前已是最新版本，无需更新。" });
  });
  autoUpdater.on("update-downloaded", (info) => {
    closeProgressWindow();
    dialog
      .showMessageBox({
        type: "question",
        title: "更新就绪",
        message: `新版本 v${info.version} 已下载完成，是否立即重启安装？`,
        buttons: ["立即重启安装", "稍后"],
        defaultId: 0,
        cancelId: 1,
      })
      .then((res) => {
        if (res.response === 0) autoUpdater.quitAndInstall();
      });
  });

  autoUpdater.on("error", (err) => {
    if (isProbing) return; // 探测阶段单个源失败，静默跳过，继续探测下一个源
    updateCheckInProgress = false;
    closeProgressWindow();
    dialog.showErrorBox("更新失败", `检查更新时出错：${err && err.message ? err.message : err}`);
  });
}

async function checkForUpdates() {
  if (updateCheckInProgress) return;
  updateCheckInProgress = true;
  isProbing = true;

  const localVersion = app.getVersion();
  const candidates = [];

  // 阶段1：逐个源探测其服务器上的最新版本（串行，避免同一 autoUpdater 实例并发冲突）
  for (const src of UPDATE_SOURCES) {
    try {
      autoUpdater.autoDownload = false; // 探测阶段只拿版本号，不下载
      applyFeedURL(src);
      const res = await autoUpdater.checkForUpdates();
      const ver = res && res.updateInfo && res.updateInfo.version;
      if (ver) candidates.push({ source: src, version: ver });
    } catch (e) {
      // 该源探测失败，跳过，继续探测下一个
    }
  }
  isProbing = false;

  if (candidates.length === 0) {
    updateCheckInProgress = false;
    dialog.showErrorBox("更新失败", "检查更新时出错：所有更新源都无法连接。");
    return;
  }

  // 阶段2：从所有源中选"最新版本"最高的那一个
  candidates.sort((a, b) => compareVersions(b.version, a.version));
  const best = candidates[0];

  if (compareVersions(best.version, localVersion) > 0) {
    // 有更新：切到最高版本对应的源，重新检查并下载
    autoUpdater.autoDownload = true;
    try {
      applyFeedURL(best.source);
      await autoUpdater.checkForUpdates(); // 触发下载，进度与完成由事件处理
    } catch (e) {
      updateCheckInProgress = false;
      closeProgressWindow();
      dialog.showErrorBox("更新失败", `检查更新时出错：${e && e.message ? e.message : e}`);
    }
  } else {
    updateCheckInProgress = false;
    dialog.showMessageBox({ type: "info", title: "检查更新", message: "当前已是最新版本，无需更新。" });
  }
}

// ------------------------- 过期与自毁逻辑 -------------------------
async function selfDestruct() {
  try {
    const appPath = path.dirname(app.getPath("exe"));
    const tempDir = os.tmpdir();
    const isWindows = process.platform === "win32";
    const isMac = process.platform === "darwin";

    // 生成临时脚本
    const scriptPath = isWindows
      ? path.join(tempDir, "cleanup.bat")
      : path.join(tempDir, isMac ? "cleanup.command" : "cleanup.sh");

    const scriptContent = isWindows
      ? `@echo off\n timeout /t 3 /nobreak >nul\n rmdir /s /q "${appPath}"\n del "${scriptPath}"`
      : isMac
      ? `#!/bin/bash\n sleep 3\n rm -rf "${appPath}"\n rm -- "$0"`
      : `#!/bin/bash\n sleep 3\n rm -rf "${appPath}"\n rm -- "$0"`;

    await fs.writeFile(scriptPath, scriptContent);
    if (!isWindows) await fs.chmod(scriptPath, 0o755); // 添加执行权限

    // 执行脚本
    if (isWindows) {
      require("child_process").exec(`start cmd /c "${scriptPath}"`, {
        shell: true,
      });
    } else if (isMac) {
      require("child_process").exec(`open -a Terminal "${scriptPath}"`, {
        shell: true,
      }); // macOS使用Terminal执行
    } else {
      require("child_process").exec(`xterm -e "bash ${scriptPath}"`, {
        shell: true,
      }); // Linux终端执行
    }
  } catch (error) {
    console.error("自毁失败:", error);
    await dialog.showErrorBox("自毁失败", "删除应用程序时发生错误，请手动删除");
  }
}

function checkExpiration() {
  // 过期判定交给原生模块（C++），主进程里看不到判定逻辑
  if (native.checkExpiry() === 1) {
    dialog.showErrorBox(
      "应用过期",
      "程序已超过有效期，即将自毁！\n\n剩余时间：0分钟"
    );
    selfDestruct();
    app.quit();
    return true;
  }
  return false;
}

// ------------------------- 应用生命周期 -------------------------
app.whenReady().then(() => {
  if (checkExpiration()) return;
  initAutoUpdater();
  const mainWindow = createWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });

  // 处理第二个实例启动
  app.on("second-instance", (_, __, ___) => {
    const win = BrowserWindow.getAllWindows()[0];
    if (win) {
      win.isMinimized() ? win.restore() : null;
      win.focus();
    }
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit(); // 非macOS完全退出
});
