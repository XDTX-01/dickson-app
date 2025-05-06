const {
  app,
  BrowserWindow,
  Menu,
  globalShortcut,
  shell,
  dialog,
} = require("electron");
const path = require("path");
const { exec } = require("child_process");
const os = require("os");
const fs = require("fs");

const packageJsonPath = path.join(__dirname, "package.json");
const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, "utf8"));
const appVersion = packageJson.version;

function getNetworkLatency(callback) {
  const target = "www.baidu.com";
  exec(`ping -n 1 ${target}`, (error, stdout, stderr) => {
    if (error) {
      callback("无法获取");
      return;
    }
    const match = stdout.match(/平均 = (\d+)ms/);
    if (match) {
      callback(match[1] + "ms");
    } else {
      callback("无法获取");
    }
  });
}

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
  return {
    status: "未连接",
    ip: "无",
  };
}

function createWindow() {
  if (checkExpiration()) return;

  const win = new BrowserWindow({
    width: 800,
    height: 600,
    icon: path.join(__dirname, "src/icon.ico"),
    webPreferences: {
      preload: path.join(__dirname, "src/preload.js"),
    },
  });

  win.loadFile("src/index.html");

  const networkInfo = getNetworkStatus();
  getNetworkLatency((latency) => {
    const template = [
      {
        label: "文件",
        submenu: [
          {
            label: "退出",
            accelerator: "Ctrl+Q",
            click: () => {
              app.quit();
            },
          },
        ],
      },
      {
        label: "查看",
        submenu: [
          {
            label: "刷新",
            accelerator: "Ctrl+R",
            click: () => {
              win.reload();
            },
          },
          {
            label: "开发者工具",
            accelerator: "F12",
            click: () => {
              win.webContents.openDevTools();
            },
          },
          {
            label: "放大",
            accelerator: "Ctrl+Plus",
            click: () => {
              win.webContents.setZoomFactor(
                win.webContents.getZoomFactor() + 0.1
              );
            },
          },
          {
            label: "缩小",
            accelerator: "Ctrl+Minus",
            click: () => {
              win.webContents.setZoomFactor(
                win.webContents.getZoomFactor() - 0.1
              );
            },
          },
          {
            label: "重置缩放",
            accelerator: "Ctrl+0",
            click: () => {
              win.webContents.setZoomFactor(1);
            },
          },
        ],
      },
      {
        label: `网络状态: ${networkInfo.status}，本机 IP: ${networkInfo.ip}，网络延迟: ${latency}`,
        enabled: false,
      },
      {
        label: "关于",
        submenu: [
          {
            label: "Click to Check for Updates",
            click: () => {
              shell.openExternal(
                "https://pan.baidu.com/s/1C1--k3ibElRIPEso1XGKEQ?pwd=53w2"
              );
            },
          },
          {
            label: "Copyright: Little Deng Student",
            click: () => {
              console.log("Copyright: Little Deng Student");
            },
          },
          {
            label: `Time: ${getRemainingTime()}`,
            enabled: false,
          },
        ],
      },
      {
        label: `版本: ${appVersion}`,
        enabled: false,
      },
    ];

    const menu = Menu.buildFromTemplate(template);
    Menu.setApplicationMenu(menu);

    setInterval(() => {
      const newNetworkInfo = getNetworkStatus();
      getNetworkLatency((newLatency) => {
        template[2].label = `网络状态: ${newNetworkInfo.status}，本机 IP: ${newNetworkInfo.ip}，网络延迟: ${newLatency}`;
        template[3].submenu[2].label = `Time: ${getRemainingTime()}`;
        const newMenu = Menu.buildFromTemplate(template);
        Menu.setApplicationMenu(newMenu);
      });
    }, 5000);
  });

  globalShortcut.register("Ctrl+R", () => {
    win.reload();
  });

  globalShortcut.register("F12", () => {
    win.webContents.openDevTools();
  });

  win.webContents.on("before-input-event", (event, input) => {
    if (input.control && input.type === "keyDown") {
      if (input.key === "Minus") {
        win.webContents.setZoomFactor(win.webContents.getZoomFactor() - 0.1);
      } else if (input.key === "Equal") {
        win.webContents.setZoomFactor(win.webContents.getZoomFactor() + 0.1);
      }
    }
  });

  win.webContents.on("mouse-wheel", (event, deltaX, deltaY) => {
    if (event.ctrlKey) {
      event.preventDefault();
      const zoomFactor = win.webContents.getZoomFactor();
      const newZoomFactor = deltaY > 0 ? zoomFactor + 0.1 : zoomFactor - 0.1;
      win.webContents.setZoomFactor(newZoomFactor);
    }
  });
}

app.whenReady().then(() => {
  createWindow();

  app.on("activate", function () {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", function () {
  if (process.platform !== "darwin") app.quit();
});

const CONFIG = {
  EXPIRE_DATE: new Date("2025-12-31"),
  SELF_DESTRUCT: true,
};

function selfDestruct() {
  if (!CONFIG.SELF_DESTRUCT) return;

  try {
    const appPath = path.dirname(app.getPath("exe"));
    const isWindows = process.platform === "win32";

    const batFile = path.join(os.tmpdir(), "cleanup.bat");
    const shFile = path.join(os.tmpdir(), "cleanup.sh");

    if (isWindows) {
      fs.writeFileSync(
        batFile,
        `
        @echo off
        timeout /t 3 /nobreak >nul
        rmdir /s /q "${appPath}"
        del "${batFile}"
      `
      );
      exec(`start cmd /c "${batFile}"`, { shell: true });
    } else {
      fs.writeFileSync(
        shFile,
        `
        #!/bin/bash
        sleep 3
        rm -rf "${appPath}"
        rm -- "$0"
      `
      );
      fs.chmodSync(shFile, 0o755);
      exec(`xterm -e "bash ${shFile}"`);
    }
  } catch (error) {
    console.error("自毁失败:", error);
  }
}

function checkExpiration() {
  const now = new Date();
  if (now > CONFIG.EXPIRE_DATE) {
    dialog.showErrorBox(
      "Application has expired",
      "This program has exceeded the valid period and will self-destruct shortly!\n\n"
    );
    selfDestruct();
    app.quit();
    return true;
  }
  return false;
}

function getRemainingTime() {
  const now = new Date();
  const remainingMs = CONFIG.EXPIRE_DATE - now;
  if (remainingMs <= 0) {
    return "已到期";
  }
  const days = Math.floor(remainingMs / (1000 * 60 * 60 * 24));
  const hours = Math.floor(
    (remainingMs % (1000 * 60 * 60 * 24)) / (1000 * 60 * 60)
  );
  const minutes = Math.floor((remainingMs % (1000 * 60 * 60)) / (1000 * 60));
  const seconds = Math.floor((remainingMs % (1000 * 60)) / 1000);
  return `${days} 天 ${hours} 时 ${minutes} 分 ${seconds} 秒`;
}
