// 更新窗口的 preload：只暴露"读状态 + 发动作"两个最小能力
// 渲染进程保持 sandbox + contextIsolation，不接触任何 Node API
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("updateUI", {
  // 订阅主进程推送的界面状态；就绪时反手通知主进程可以发首帧了
  onState(callback) {
    if (typeof callback !== "function") return;
    ipcRenderer.on("update:state", (_event, state) => callback(state));
    ipcRenderer.send("update:ready");
  },
  // 按钮动作：close / later / skip / update-now / cancel-download / ...
  action(id) {
    ipcRenderer.send("update:action", String(id || ""));
  },
});
