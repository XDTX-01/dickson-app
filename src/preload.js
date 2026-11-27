// 预加载脚本（preload）
// 只向渲染进程暴露「保存文件 / 还原窗口」两个接口，其余 Node 能力一律不暴露。
// 以前的 dicksonReveal / dicksonWindowState 前端产物里从来没调用过（grep 为 0），
// 留着只是白白扩大攻击面，已连同对应的 IPC 一起删掉。
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("dicksonSave", (payload) =>
  ipcRenderer.invoke("app:save-file", payload)
);

// 切换预览 / 导出前把窗口还原到前台，避免最小化时渲染被 Chromium 节流
contextBridge.exposeInMainWorld("dicksonEnsureVisible", () =>
  ipcRenderer.invoke("app:ensure-visible")
);
