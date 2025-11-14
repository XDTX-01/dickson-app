const {
  app,
  BrowserWindow,
  Menu,
  globalShortcut,
  shell,
  dialog,
} = require("electron");
const path = require("path");
const os = require("os");
const fs = require("fs/promises"); // 使用Promise版本的fs

// ------------------------- 常量与配置 -------------------------
const CONSTANTS = {
  APP_ICON: path.join(__dirname, "src/icon.ico"),
  INDEX_HTML: path.join(__dirname, "src/index.html"),
  PRELOAD_SCRIPT: path.join(__dirname, "src/preload.js"),
  NETWORK_TARGET: "www.baidu.com",
  SHORTCUTS: {
    REFRESH: "Ctrl+R",
    DEV_TOOLS: "F12",
    ZOOM_IN: "Ctrl+Plus",
    ZOOM_OUT: "Ctrl+Minus",
    ZOOM_RESET: "Ctrl+0",
  },
  ZOOM_LIMITS: { MIN: 0.5, MAX: 2.0 }, // 缩放限制
  CONFIG: {
    EXPIRE_DATE: new Date("2025-12-31"),
    SELF_DESTRUCT: true,
  },
};

// ------------------------- 工具函数 -------------------------
function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

// ------------------------- 核心功能 -------------------------
// 单实例锁
const gotTheLock = app.requestSingleInstanceLock();
if (!gotTheLock) app.quit();

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
    webPreferences: { preload: CONSTANTS.PRELOAD_SCRIPT },
  });

  win.loadFile(CONSTANTS.INDEX_HTML);

  // 注册快捷键并绑定窗口销毁时注销
  function registerShortcuts() {
    globalShortcut.register(CONSTANTS.SHORTCUTS.REFRESH, () => win.reload());
    globalShortcut.register(CONSTANTS.SHORTCUTS.DEV_TOOLS, () =>
      win.webContents.openDevTools()
    );
  }
  registerShortcuts();
  win.on("closed", () => globalShortcut.unregisterAll()); // 防止内存泄漏

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
      {
        label: `${getRemainingTime()} `,
        enabled: false,
      },
      {
        label: "关于",
        submenu: [
          {
            label: "检查更新",
            click: () => {
              const url =
                "https://wwix.lanzouw.com/b011la44be";
              if (/^https?:\/\//i.test(url)) shell.openExternal(url);
            },
          },
          {
            label: "版权信息",
            click: () => console.log("Copyright: Little Deng Student"),
          },
        ],
      },
    ];

    Menu.setApplicationMenu(Menu.buildFromTemplate(template));
  }

  // 初始化及定时更新
  updateMenu();
  setInterval(updateMenu, 5000);

  // 键盘缩放支持（优化事件处理）
  win.webContents.on("before-input-event", (event, input) => {
    if (input.ctrlKey && input.type === "keyDown") {
      if (input.key === "Minus") handleZoom(-0.1);
      else if (input.key === "Equal") handleZoom(0.1);
    }
  });

  // 鼠标滚轮缩放（带Ctrl键检测）
  win.webContents.on("mouse-wheel", (event, _, deltaY) => {
    if (event.ctrlKey) {
      event.preventDefault();
      handleZoom(deltaY > 0 ? 0.1 : -0.1);
    }
  });

  return win; // 返回窗口引用以便后续操作
}

// ------------------------- 过期与自毁逻辑 -------------------------
function getRemainingTime() {
  const now = new Date();
  const remainingMs = CONSTANTS.CONFIG.EXPIRE_DATE - now;
  if (remainingMs <= 0) return 0; // 已到期，返回0分钟

  return Math.floor(remainingMs / 60000); // 转换为分钟并取整
}

async function selfDestruct() {
  if (!CONSTANTS.CONFIG.SELF_DESTRUCT) return;

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
  const now = new Date();
  if (now > CONSTANTS.CONFIG.EXPIRE_DATE) {
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
