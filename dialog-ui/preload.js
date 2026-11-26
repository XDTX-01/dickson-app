// 通用弹窗的 preload：只暴露"接收状态 + 回传按钮"两个最小能力
// 渲染进程保持 sandbox + contextIsolation，不接触任何 Node API
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("dialogUI", {
  // 订阅主进程推送的弹窗内容；就绪时反手通知主进程可以发首帧了
  onReady(callback) {
    if (typeof callback !== "function") return;
    ipcRenderer.on("dialog:state", (_event, state) => callback(state));
    ipcRenderer.send("dialog:ready");
  },
  // 按钮动作：回传按钮序号；点标题栏关闭回传 -1
  action(index) {
    const n = Number(index);
    ipcRenderer.send("dialog:action", Number.isFinite(n) ? n : -1);
  },
  // 内容渲染完后按真实高度请求主进程撑开窗口，避免清单被固定高度挤成一条
  resize(height) {
    const n = Math.round(Number(height));
    if (Number.isFinite(n) && n > 0) ipcRenderer.send("dialog:resize", n);
  },
});
