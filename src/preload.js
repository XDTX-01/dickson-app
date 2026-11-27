// 预加载脚本（preload）
// 只向渲染进程暴露「保存文件 / 在文件夹中显示 / 主窗口状态」三个接口，其余 Node 能力一律不暴露。
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("dicksonSave", (payload) =>
  ipcRenderer.invoke("app:save-file", payload)
);

contextBridge.exposeInMainWorld("dicksonReveal", (filePath) =>
  ipcRenderer.invoke("app:reveal-file", filePath)
);

// 主窗口状态（是否最小化 / 是否可见）：保存前用它判断窗口是否被 Chromium 节流
contextBridge.exposeInMainWorld("dicksonWindowState", () =>
  ipcRenderer.invoke("app:window-state")
);

// 保存前把窗口还原到前台，避免最小化时导出被节流卡住
contextBridge.exposeInMainWorld("dicksonEnsureVisible", () =>
  ipcRenderer.invoke("app:ensure-visible")
);
