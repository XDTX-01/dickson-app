// 预加载脚本（preload）
// 只向渲染进程暴露「保存文件 / 在文件夹中显示」两个接口，其余 Node 能力一律不暴露。
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("dicksonSave", (payload) =>
  ipcRenderer.invoke("app:save-file", payload)
);

contextBridge.exposeInMainWorld("dicksonReveal", (filePath) =>
  ipcRenderer.invoke("app:reveal-file", filePath)
);
