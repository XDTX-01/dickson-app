const { app, BrowserWindow, Menu, globalShortcut, shell } = require("electron");
const path = require("path");
const { exec } = require("child_process");
const os = require("os");

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
  const win = new BrowserWindow({
    width: 800,
    height: 600,
    icon: path.join(__dirname, "src/icon.ico"),
    webPreferences: {
      preload: path.join(__dirname, "src/preload.js"),
    },
  });

  win.loadFile("src/index.html");

  // 获取初始网络信息
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
            label: "版权归属: Little Deng Student",
            click: () => {
              console.log("版权归属: Little Deng Student");
            },
          },
          {
            label: "软件更新:Little Deng Student",
            click: () => {
              // 假设这里有官方网站的链接
              shell.openExternal(
                "https://pan.baidu.com/s/1C1--k3ibElRIPEso1XGKEQ?pwd=53w2"
              );
            },
          },
        ],
      },
    ];

    const menu = Menu.buildFromTemplate(template);
    Menu.setApplicationMenu(menu);

    // 定时更新网络信息
    setInterval(() => {
      const newNetworkInfo = getNetworkStatus();
      getNetworkLatency((newLatency) => {
        template[2].label = `网络状态: ${newNetworkInfo.status}，本机 IP: ${newNetworkInfo.ip}，网络延迟: ${newLatency}`;
        const newMenu = Menu.buildFromTemplate(template);
        Menu.setApplicationMenu(newMenu);
      });
    }, 5000);
  });

  // 注册全局快捷键
  globalShortcut.register("Ctrl+R", () => {
    win.reload();
  });

  // 注册 F12 快捷键以打开开发者工具
  globalShortcut.register("F12", () => {
    win.webContents.openDevTools();
  });

  // 支持 Ctrl + 滚轮缩放
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
