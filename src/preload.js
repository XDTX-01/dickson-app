// 预加载脚本（preload）
// 当前应用为纯静态页面，无需向渲染进程暴露 Node 能力。
// 保持安全默认：contextIsolation = true、nodeIntegration = false、sandbox = true。
// 未来如需安全 IPC 桥接，可在此通过 contextBridge.exposeInMainWorld 暴露受控接口。
