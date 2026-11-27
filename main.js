const {
  app,
  BrowserWindow,
  Menu,
  ipcMain,
  shell,
  dialog,
  session,
} = require("electron");
const { autoUpdater } = require("electron-updater");
const path = require("path");
const os = require("os");
const fs = require("fs/promises"); // 使用Promise版本的fs
// 原生保护模块：过期判定、文件完整性自检（C++ 编译，无明文逻辑）
// 本地开发（无编译产物）时降级为桩函数，保证 npm start 可直接跑；生产环境加载真实模块
// 硬件加速默认开启（GPU 合成，滚动/材质缩略图/高分屏更顺），
// 少数机器 GPU 驱动有问题会让 GPU 进程崩溃，降级策略见下方「硬件加速与自动降级」一节

// 渲染进程沙箱默认保持开启（与下方 webPreferences.sandbox = true 一致）。
// 少数机器（安全软件/代理策略禁用沙箱）会让渲染进程一启动就崩，所以保留三条降级通道：
//   1) 崩溃自动降级：渲染进程异常退出后用 --no-sandbox 重启一次（10 分钟内只降级一次，防死循环）
//   2) 环境变量 DICKSON_NO_SANDBOX=1
//   3) 快捷方式/命令行加 --no-sandbox
const SANDBOX_DISABLED =
  process.env.DICKSON_NO_SANDBOX === "1" ||
  process.argv.indexOf("--no-sandbox") !== -1 ||
  app.commandLine.hasSwitch("no-sandbox"); // 兜底：Chromium 自己解析过的开关

if (SANDBOX_DISABLED) {
  app.commandLine.appendSwitch("no-sandbox");
}

let native = null;
try {
  native = require("./protect/protect.node");
} catch (_) {
  native = {
    checkExpiry: () => 0, // 开发模式：永不过期
    expireAt: () => 0, // 0 = 没有到期时间，菜单里不显示倒计时
    verifyFile: () => true,
    verifyBuffer: () => true,
  };
}

// ------------------------- 常量与配置 -------------------------
const CONSTANTS = {
  APP_ICON: path.join(__dirname, "src/icon.ico"),
  INDEX_HTML: path.join(__dirname, "src/index.html"),
  PRELOAD_SCRIPT: path.join(__dirname, "src/preload.js"),
  SHORTCUTS: {
    REFRESH: "Ctrl+R",
    ZOOM_RESET: "Ctrl+0",
  },
  ZOOM_LIMITS: { MIN: 0.5, MAX: 2.0 }, // 缩放限制
};

// 运行参数集中定义：原来 500/620/236/64、80ms、82MB 这类数字散落在各个函数里，
// 改一处要翻全文，也容易和界面上的提示文案对不上
const TIMING = {
  MENU_REFRESH_MS: 30 * 1000, // 菜单内容没变就不重建
  EXPIRY_CHECK_MS: 60 * 1000, // 运行期间复查到期时间
  SANDBOX_FALLBACK_COOLDOWN_MS: 10 * 60 * 1000, // 同机 10 分钟内只降级一次
  STARTUP_CHECK_DELAY_MS: 20 * 1000, // 启动后静默检查更新
  PROBE_TIMEOUT_MS: 15 * 1000, // 单源探测超时
  PROGRESS_THROTTLE_MS: 80, // 下载进度推送节流
  DEMO_TICK_MS: 500, // 演示模式进度刷新
  DIALOG_FORCE_EXIT_MS: 60 * 1000, // 过期弹窗无人响应后强制清理
  RELAUNCH_DELAY_MS: 60, // 退出安装前等界面关闭
};

const LIMITS = {
  SAVE_TEXT_MAX_BYTES: 32 * 1024 * 1024,
  SAVE_IMAGE_MAX_BYTES: 256 * 1024 * 1024,
  FILE_NAME_MAX_LEN: 120,
  UNIQUE_NAME_MAX_TRIES: 500,
  DIALOG_BASE_HEIGHT: 236,
  DIALOG_MAX_HEIGHT: 620,
  DIALOG_HEIGHT_PER_CHECK: 64,
  DEMO_TOTAL_BYTES: 82 * 1048576,
  DEMO_SPEED_BYTES: 2.6 * 1048576,
};

// 菜单刷新间隔：内容（IP / 到期分钟数 / 版本）没变就不会真的重建菜单
const MENU_REFRESH_MS = TIMING.MENU_REFRESH_MS;
// 运行期间复查到期时间的间隔：只在启动时判一次的话，挂机跨过到期点不会触发
const EXPIRY_CHECK_INTERVAL = TIMING.EXPIRY_CHECK_MS;

let mainWin = null; // 主窗口引用（second-instance 用，避免误取更新窗口）
let menuTimer = null;
let lastMenuSignature = "";

function clearMenuTimer() {
  if (menuTimer) {
    clearInterval(menuTimer);
    menuTimer = null;
  }
}

function startMenuTimer(fn) {
  clearMenuTimer();
  menuTimer = setInterval(fn, MENU_REFRESH_MS);
  if (typeof menuTimer.unref === "function") menuTimer.unref();
}

// ------------------------- 沙箱降级兜底 -------------------------
// 只在“渲染进程真的崩了”的时候才降级，且同一台机器 10 分钟内只降一次，
// 避免因为别的原因（OOM、被杀进程）反复重启。
const fsSync = require("fs");

function sandboxFallbackFile() {
  return path.join(app.getPath("userData"), "sandbox-fallback.json");
}

function canFallbackToNoSandbox() {
  try {
    const raw = fsSync.readFileSync(sandboxFallbackFile(), "utf8");
    const state = JSON.parse(raw);
    const lastAt = Number(state && state.lastAt) || 0;
    return Date.now() - lastAt > TIMING.SANDBOX_FALLBACK_COOLDOWN_MS;
  } catch (_) {
    // 文件不存在 / 内容损坏都按“可以降级”处理
    return true;
  }
}

function markNoSandboxFallback() {
  try {
    fsSync.mkdirSync(path.dirname(sandboxFallbackFile()), { recursive: true });
    fsSync.writeFileSync(
      sandboxFallbackFile(),
      JSON.stringify({ lastAt: Date.now() }, null, 2),
      "utf8"
    );
  } catch (_) {
    // 写不进去只影响“防循环”这一层，不影响重启本身
  }
}

const SANDBOX_CRASH_REASONS = ["crashed", "launch-failed", "integrity-failure"];

app.on("render-process-gone", (_event, _webContents, details) => {
  const reason = (details && details.reason) || "";
  if (SANDBOX_DISABLED) return; // 已经是关沙箱在跑，再崩就不是沙箱的事了
  if (SANDBOX_CRASH_REASONS.indexOf(reason) === -1) return;
  if (!canFallbackToNoSandbox()) return;

  console.warn("[sandbox] 渲染进程异常退出（" + reason + "），改用 --no-sandbox 重启");
  markNoSandboxFallback();
  app.relaunch({ args: process.argv.slice(1).concat(["--no-sandbox"]) });
  app.exit(0);
});

// ------------------------- 硬件加速（GPU）与自动降级 -------------------------
// 默认开启硬件加速：滚动、材质缩略图、高分屏缩放都靠 GPU 合成，关掉会明显卡 CPU。
// 少数机器 GPU 驱动有问题会让 GPU 进程崩溃，这里不做"一次就降级"，而是分级处理：
//   本会话第 1 次 GPU 崩溃 → 只记日志（Chromium 自己能重建 GPU 进程，用户无感）
//   第 2 次                → 写永久标记，下次启动直接软件渲染
//   第 3 次                → 立刻带 --disable-gpu 重启，不再让用户对着花屏等
// 想强制恢复硬件加速：设环境变量 DICKSON_GPU=1，或删掉 userData/gpu-fallback.json
// 本段只用同步 fs；与上方沙箱降级共用同一个 fsSync，避免同一文件 require 两次
const gpuFs = fsSync;

function gpuFallbackFile() {
  return path.join(app.getPath("userData"), "gpu-fallback.json");
}

function gpuFallbackMarked() {
  try {
    return gpuFs.existsSync(gpuFallbackFile());
  } catch (_) {
    return false;
  }
}

function gpuLog(text) {
  try {
    const dir = path.join(app.getPath("userData"), "logs");
    gpuFs.mkdirSync(dir, { recursive: true });
    gpuFs.appendFileSync(
      path.join(dir, "gpu.log"),
      "[" + new Date().toISOString() + "] " + text + "\n",
      "utf8"
    );
  } catch (_) {
    // 日志失败不影响降级判断
  }
}

function markGpuFallback(reason) {
  try {
    gpuFs.writeFileSync(
      gpuFallbackFile(),
      JSON.stringify({ lastAt: Date.now(), reason: String(reason || "") }, null, 2),
      "utf8"
    );
  } catch (_) {
    // 写不进去就只靠本次 relaunch 的 --disable-gpu 参数生效
  }
}

const GPU_DISABLED =
  process.env.DICKSON_NO_GPU === "1" ||
  process.argv.indexOf("--disable-gpu") !== -1 ||
  app.commandLine.hasSwitch("disable-gpu") ||
  (process.env.DICKSON_GPU !== "1" && gpuFallbackMarked());

if (GPU_DISABLED) {
  app.disableHardwareAcceleration();
  gpuLog("本次启动使用软件渲染（环境变量或历史崩溃标记）");
}

const GPU_CRASH_REASONS = ["crashed", "abnormal-exit", "oom", "launch-failed"];
const GPU_RELAUNCH_AFTER = 3; // 达到这次数才强制重启，前两次交给 Chromium 自恢复
let gpuCrashCount = 0;

// 第 2 次崩溃：不擅自重启，弹窗让用户决定是否立即切 CPU；选“稍后”则本次继续 GPU，下次启动按标记降级
function promptRestartToCpu() {
  showCustomDialog({
    kind: "warning",
    title: "显示加速异常",
    message: "GPU 渲染进程已连续崩溃。",
    detail:
      "是否立即重启并切换为 CPU 软件渲染（画面更稳，滚动略慢）？\n选择“稍后”则本次继续使用 GPU，下次启动自动切换为软件渲染。",
    buttons: [
      { label: "立即重启切换", kind: "primary" },
      { label: "稍后", kind: "secondary" },
    ],
  })
    .then((index) => {
      if (index === 0) {
        gpuLog("用户选择立即重启，切换软件渲染");
        app.relaunch({ args: process.argv.slice(1).concat(["--disable-gpu"]) });
        app.exit(0);
      }
    })
    .catch(() => {
      // 弹窗失败保持现状，下次启动按标记降级
    });
}

app.on("child-process-gone", (_event, details) => {
  if (!details || details.type !== "GPU") return;
  if (GPU_DISABLED) return; // 已经是软件渲染，再崩就不是 GPU 的事
  const reason = String(details.reason || "");
  if (GPU_CRASH_REASONS.indexOf(reason) === -1) return;

  gpuCrashCount += 1;
  gpuLog("GPU 进程崩溃 #" + gpuCrashCount + " reason=" + reason);

  // 第 2 次：写降级标记并弹窗询问，由用户决定是否立即重启切 CPU
  if (gpuCrashCount >= 2 && !gpuFallbackMarked()) {
    markGpuFallback(reason);
    gpuLog("已标记：下次启动改用软件渲染");
    promptRestartToCpu();
    return;
  }

  // 第 3 次（用户上次选择稍后、又再次崩溃）：不再询问，直接自动重启切 CPU
  if (gpuCrashCount < GPU_RELAUNCH_AFTER) return; // 不打断用户正在做的事

  gpuLog("GPU 反复崩溃，立即带 --disable-gpu 重启");
  app.relaunch({ args: process.argv.slice(1).concat(["--disable-gpu"]) });
  app.exit(0);
});

// ------------------------- 工具函数 -------------------------
function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

// 当前渲染模式：默认 GPU 硬件加速，只有手动强制或 GPU 反复崩溃降级后才用 CPU 软件渲染
function renderModeInfo() {
  if (!GPU_DISABLED) return { label: "GPU", isGpu: true };
  return { label: "CPU", isGpu: false };
}

// 授权剩余分钟数（纯数字，菜单里直接显示）
// 到期时间的唯一来源是原生模块 expireAt()，JS 里不再保留第二份常量，
// 避免“菜单显示还剩 N 分钟”和“真正自毁的时刻”对不上
function licenseMinutesLeft() {
  let expireAt = 0;
  try {
    expireAt = typeof native.expireAt === "function" ? Number(native.expireAt()) || 0 : 0;
  } catch (err) {
    // 原生模块抛错时退化为“不显示倒计时”，不能因为菜单刷新失败拖垮主进程
    console.warn("[license] expireAt 读取失败:", err && err.message);
    return null;
  }
  if (!expireAt) return null; // 开发模式（无原生模块）：不显示倒计时
  const left = expireAt - Date.now();
  return left <= 0 ? 0 : Math.ceil(left / 60000);
}

// ------------------------- 通用自绘弹窗（与“检查更新”同一套 UI） -------------------------
// 替代原生 dialog.showErrorBox / showMessageBox，全部走 frame:false 的自绘窗口
const DIALOG_UI = {
  HTML: path.join(__dirname, "dialog-ui/index.html"),
  PRELOAD: path.join(__dirname, "dialog-ui/preload.js"),
  WIDTH: 420,
  HEIGHT: 236,
};

let dialogWin = null;
let dialogResolve = null;
let pendingDialogState = null;
let dialogIpcBound = false;

// ------------------------- 保存文件（原生另存为） -------------------------
// 渲染进程里 a[download] 在无边框 Electron 窗口下只会留下一个 .tmp，不会真正落盘，
// 所以保存图片 / 保存 HTML 统一走 IPC + 原生 dialog.showSaveDialog 自己写文件。
let saveIpcBound = false;

// 文件名净化：只保留一个安全、长度可控的文件名，调用方再和目录拼路径
// 以前只替换 \/:*?"<>|，剩下的控制字符、结尾的点/空格、“.”“..”都没处理
function sanitizeFileName(name, fallback = "未命名") {
  const raw = String(name == null ? "" : name).replace(/[\u0000-\u001f\u007f<>:"/\\|?*]/g, "-");
  // Windows 不允许文件名以点或空格结尾，也不接受纯 "." / ".."
  const cleaned = raw.replace(/[. ]+$/g, "").trim();
  if (!cleaned || cleaned === "." || cleaned === "..") return fallback;

  const ext = path.extname(cleaned);
  const base = path.basename(cleaned, ext) || fallback;
  const maxBase = Math.max(1, LIMITS.FILE_NAME_MAX_LEN - ext.length);
  return base.slice(0, maxBase) + ext.slice(0, LIMITS.FILE_NAME_MAX_LEN);
}

// 同名文件不覆盖：自动加 -1、-2 …… 后缀。
// 这里只生成“当前没被占用”的候选名，真正落盘用 writeFileExclusive 的 wx 独占写入，
// 避免“检查—写入”之间被别人抢先创建导致覆盖
function uniqueFilePath(dir, safeName) {
  const ext = path.extname(safeName);
  const base = path.basename(safeName, ext) || "未命名";
  let target = path.join(dir, safeName);
  let i = 1;
  while (i <= LIMITS.UNIQUE_NAME_MAX_TRIES) {
    try {
      fsSync.accessSync(target);
    } catch (_) {
      return target; // 不存在，可以用
    }
    target = path.join(dir, `${base}-${i}${ext}`);
    i += 1;
  }
  // 极端情况（同名文件超过 500 个）：带时间戳兜底，绝不返回已存在的路径覆盖用户文件
  return path.join(dir, `${base}-${Date.now()}${ext}`);
}

// 独占写入（wx）：目标已存在时自动换名，最多重试 UNIQUE_NAME_MAX_TRIES 次
async function writeFileExclusive(dir, safeName, payload) {
  const ext = path.extname(safeName);
  const base = path.basename(safeName, ext) || "未命名";
  for (let i = 0; i <= LIMITS.UNIQUE_NAME_MAX_TRIES; i += 1) {
    const target = i === 0
      ? path.join(dir, `${base}${ext}`)
      : path.join(dir, `${base}-${i}${ext}`);
    try {
      await fs.writeFile(target, payload, { flag: "wx" });
      return target;
    } catch (err) {
      if (err && err.code === "EEXIST") continue;
      throw err;
    }
  }
  const fallback = path.join(dir, `${base}-${Date.now()}${ext}`);
  await fs.writeFile(fallback, payload, { flag: "wx" });
  return fallback;
}

function bindSaveIpc() {
  if (saveIpcBound) return;
  saveIpcBound = true;
  // 渲染进程点「保存」前先问主窗口状态：窗口被最小化 / 不可见时 Chromium 会节流渲染，
  // html-to-image 迟迟不返回，只会白等一次超时，所以要把状态告诉前端，让它先提示。
  // 点「保存」时把窗口还原到前台：窗口最小化时 Chromium 会节流渲染，导出会一直停在「生成中」
  ipcMain.handle("app:ensure-visible", (event) => {
    const win = BrowserWindow.fromWebContents(event.sender) || mainWin;
    if (!win || win.isDestroyed()) return { ok: false };
    try {
      if (win.isMinimized()) win.restore();
      if (!win.isVisible()) win.show();
      win.focus();
      return { ok: true };
    } catch (e) {
      return { ok: false, error: e && e.message ? e.message : String(e) };
    }
  });
  ipcMain.handle("app:window-state", (event) => {
    const win = BrowserWindow.fromWebContents(event.sender) || mainWin;
    if (!win || win.isDestroyed()) return { minimized: false, visible: true };
    return { minimized: win.isMinimized(), visible: win.isVisible() };
  });
  // 本进程真正写过盘的路径：reveal-file 只认这些，避免渲染进程被注入后
  // 凭 invoke("app:reveal-file", 任意路径) 让系统资源管理器打开任意文件
  const writtenFiles = new Set();

  // 入参 → 可写盘的数据。png 解 base64，html 原样 utf8；
  // 以前这段逻辑在「直接保存」和「另存为」两个分支里各抄了一遍
  function encodeSavePayload(type, data) {
    if (type !== "png") return String(data);
    const base64 = String(data).replace(/^data:[^;]+;base64,/, "");
    if (!/^[A-Za-z0-9+/=\r\n]+$/.test(base64)) {
      throw new Error("图片数据不是合法的 base64");
    }
    return Buffer.from(base64, "base64");
  }

  function normalizeSavePayload(payload) {
    if (!payload || typeof payload !== "object") return { error: "invalid-payload" };
    const type = payload.type === "png" || payload.type === "html" ? payload.type : null;
    if (!type) return { error: "unsupported-type" };
    if (typeof payload.name !== "string" || !payload.name.trim()) return { error: "empty-name" };
    if (typeof payload.data !== "string" || !payload.data) return { error: "empty-data" };

    const limit = type === "png" ? LIMITS.SAVE_IMAGE_MAX_BYTES : LIMITS.SAVE_TEXT_MAX_BYTES;
    if (payload.data.length > limit) return { error: "too-large" };

    // 强制扩展名与类型一致，避免存出“图片内容 .html 后缀”这种打不开的文件
    let name = sanitizeFileName(payload.name, type === "png" ? "配色方案.png" : "配色方案.html");
    const wantExt = type === "png" ? ".png" : ".html";
    if (path.extname(name).toLowerCase() !== wantExt) {
      name = sanitizeFileName(path.basename(name, path.extname(name)) + wantExt);
    }

    return {
      type,
      name,
      direct: payload.direct === true,
      data: payload.data,
    };
  }

  ipcMain.handle("app:save-file", async (event, payload) => {
    // 只受理主窗口发来的保存请求（更新窗口 / 弹窗窗口的 preload 不暴露这个能力）
    if (!mainWin || mainWin.isDestroyed() || event.sender !== mainWin.webContents) {
      return { ok: false, error: "forbidden" };
    }

    const normalized = normalizeSavePayload(payload);
    if (normalized.error) return { ok: false, error: normalized.error };

    const { type, name, direct, data } = normalized;
    const owner = BrowserWindow.fromWebContents(event.sender) || mainWin;
    const baseDir = type === "png" ? app.getPath("pictures") : app.getPath("documents");

    let encoded;
    try {
      encoded = encodeSavePayload(type, data);
    } catch (err) {
      return { ok: false, error: err && err.message ? err.message : String(err) };
    }

    // direct=true：不弹原生对话框，直接落到「图片 / 文档」目录（HTML 导出还在用）
    if (direct) {
      try {
        const directPath = await writeFileExclusive(baseDir, name, encoded);
        writtenFiles.add(directPath);
        return { ok: true, path: directPath };
      } catch (err) {
        return { ok: false, error: err && err.message ? err.message : String(err) };
      }
    }

    // 弹系统「另存为」：无边框窗口下对话框容易被主窗盖住并让主窗进入
    // 不可交互的模态状态，这里临时把主窗置顶并聚焦，保证对话框一定在最前面
    const ownerWin = owner && !owner.isDestroyed() ? owner : null;
    let restoreTop = false;
    if (ownerWin) {
      try {
        if (ownerWin.isMinimized()) ownerWin.restore();
        if (!ownerWin.isAlwaysOnTop()) {
          ownerWin.setAlwaysOnTop(true, "floating");
          restoreTop = true;
        }
        ownerWin.focus();
      } catch (_) {
        // 置顶失败不影响弹窗
      }
    }
    let result;
    try {
      result = await dialog.showSaveDialog(ownerWin || undefined, {
        title: "另存为",
        buttonLabel: "保存",
        defaultPath: uniqueFilePath(baseDir, name),
        filters:
          type === "png"
            ? [{ name: "PNG 图片", extensions: ["png"] }]
            : [{ name: "HTML 文件", extensions: ["html", "htm"] }],
      });
    } finally {
      if (restoreTop && ownerWin && !ownerWin.isDestroyed()) {
        try {
          ownerWin.setAlwaysOnTop(false);
        } catch (_) {
          // 忽略
        }
      }
    }
    const { canceled, filePath } = result || {};
    if (canceled || !filePath || typeof filePath !== "string") return { ok: false, canceled: true };
    try {
      await fs.writeFile(filePath, encoded);
      writtenFiles.add(filePath);
      return { ok: true, path: filePath };
    } catch (err) {
      return { ok: false, error: err && err.message ? err.message : String(err) };
    }
  });


  // 保存成功后「在文件夹中显示」：只对已经存在、且由本进程写过的路径生效
  ipcMain.handle("app:reveal-file", async (event, filePath) => {
    // 与 save-file 同样的来源校验：只有主窗口能请求
    if (!mainWin || mainWin.isDestroyed() || event.sender !== mainWin.webContents) {
      return { ok: false, error: "forbidden" };
    }
    try {
      if (typeof filePath !== "string" || !filePath) return { ok: false };
      // 白名单：必须是 save-file 真正写成功的路径，渲染进程无法借此打开任意本地文件
      if (!writtenFiles.has(filePath)) return { ok: false, error: "not-written-by-app" };
      await fs.access(filePath);
      shell.showItemInFolder(filePath);
      return { ok: true };
    } catch (e) {
      return { ok: false, error: e && e.message ? e.message : String(e) };
    }
  });
}

function isDialogSender(event) {
  return !!(dialogWin && !dialogWin.isDestroyed() && event.sender === dialogWin.webContents);
}

function bindDialogIpc() {
  if (dialogIpcBound) return;
  dialogIpcBound = true;
  ipcMain.on("dialog:ready", (event) => {
    if (!isDialogSender(event) || !pendingDialogState) return;
    event.sender.send("dialog:state", pendingDialogState);
  });
  ipcMain.on("dialog:action", (event, index) => {
    if (!isDialogSender(event)) return;
    const value = Number(index);
    const cb = dialogResolve;
    dialogResolve = null;
    pendingDialogState = null;
    if (dialogWin && !dialogWin.isDestroyed()) dialogWin.close();
    dialogWin = null;
    if (cb) cb(Number.isFinite(value) ? value : -1);
  });
  // 弹窗渲染完回传真实内容高度：按内容撑开，清单不再被挤成一条
  ipcMain.on("dialog:resize", (event, height) => {
    if (!isDialogSender(event) || !dialogWin || dialogWin.isDestroyed()) return;
    const h = Math.round(Number(height));
    if (!Number.isFinite(h) || h <= 0) return;
    const next = Math.max(DIALOG_UI.HEIGHT, Math.min(LIMITS.DIALOG_MAX_HEIGHT, h));
    const [w] = dialogWin.getContentSize();
    if (dialogWin.getContentSize()[1] !== next) {
      try { dialogWin.setContentSize(w, next); } catch (_) {}
    }
  });
}

// 返回 Promise<按钮序号>；点标题栏关闭 / Esc 返回 -1
function showCustomDialog(options = {}) {
  bindDialogIpc();
  return new Promise((resolve) => {
    // 被新弹窗顶掉时，旧 Promise 必须有结果，否则调用方永远挂起
    if (dialogResolve) {
      const prev = dialogResolve;
      dialogResolve = null;
      prev(-1);
    }
    if (dialogWin && !dialogWin.isDestroyed()) {
      try { dialogWin.close(); } catch (_) {}
    }
    pendingDialogState = {
      kind: options.kind || "info",
      title: options.title || "提示",
      message: options.message || "",
      detail: options.detail || "",
      checks: Array.isArray(options.checks) ? options.checks : null,
      buttons: Array.isArray(options.buttons) && options.buttons.length
        ? options.buttons
        : [{ label: "确定", kind: "primary" }],
    };
    dialogResolve = resolve;

    // 体检清单一多就会被固定高度挤成一条，按条数长高（有上限）
    const checkCount = (pendingDialogState.checks || []).length;
    const dialogHeight =
      options.height ||
      Math.min(
        LIMITS.DIALOG_MAX_HEIGHT,
        LIMITS.DIALOG_BASE_HEIGHT + Math.max(0, checkCount - 2) * LIMITS.DIALOG_HEIGHT_PER_CHECK
      );

    const parent = mainWin && !mainWin.isDestroyed() ? mainWin : null;
    dialogWin = new BrowserWindow({
      width: DIALOG_UI.WIDTH,
      height: dialogHeight,
      useContentSize: true,
      resizable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      frame: false,
      show: false,
      backgroundColor: "#ffffff",
      title: pendingDialogState.title,
      icon: CONSTANTS.APP_ICON,
      parent: parent || undefined,
      modal: false,
      webPreferences: {
        preload: DIALOG_UI.PRELOAD,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: !SANDBOX_DISABLED,
        devTools: false,
      },
    });
    dialogWin.removeMenu();
    lockDownWindowNavigation(dialogWin);
    const win = dialogWin;
    // 页面缺失 / 加载失败时，ready-to-show 永远不会来，Promise 会一直挂着：
    // 这里必须兜底 settle，否则调用方（过期弹窗、GPU 降级弹窗）永远等不到结果
    const settleOnLoadFailure = (reason) => {
      console.warn("[dialog] 弹窗加载失败:", reason);
      if (dialogWin === win) {
        dialogWin = null;
        const cb = dialogResolve;
        dialogResolve = null;
        pendingDialogState = null;
        if (cb) cb(-1);
      }
      if (win && !win.isDestroyed()) {
        try { win.destroy(); } catch (_) {}
      }
    };
    win.webContents.once("did-fail-load", (_e, code, desc) => settleOnLoadFailure(code + " " + desc));
    win.loadFile(DIALOG_UI.HTML).catch((err) => settleOnLoadFailure(err && err.message));
    dialogWin.once("ready-to-show", () => {
      if (win.isDestroyed()) return;
      win.show();
      win.focus();
    });
    dialogWin.on("closed", () => {
      // 已被新弹窗替换时不处理，避免旧窗关闭误把新回调以 -1 结束
      if (dialogWin !== win) return;
      dialogWin = null;
      const cb = dialogResolve;
      dialogResolve = null;
      pendingDialogState = null;
      if (cb) cb(-1);
    });
  });
}

// ------------------------- 核心功能 -------------------------
// 单实例锁
const gotTheLock = app.requestSingleInstanceLock();
if (!gotTheLock) {
  app.quit();
  return; // 未拿到锁立即终止，避免继续注册窗口与事件
}

// 应用版本：app.getVersion() 启动时读一次 package.json 并缓存结果，
// 不再每次刷新菜单都重新读盘 + JSON.parse
const APP_VERSION = app.getVersion() || "未知版本";

// 获取网络状态
function getNetworkStatus() {
  let interfaces = {};
  try {
    interfaces = os.networkInterfaces() || {};
  } catch (err) {
    return { status: "未知", ip: "无" };
  }
  for (const name of Object.keys(interfaces)) {
    const list = interfaces[name];
    // Node 文档明确说某个网卡可能是 undefined，直接 for...of 会抛 TypeError
    if (!Array.isArray(list)) continue;
    for (const iface of list) {
      if (!iface) continue;
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
  // 编辑器的画布是 1920×1080 固定 1:1，工具栏还有一整排按钮：
  // 800×600 会把工具栏截到“页面”为止，页面标签/缩放都点不到，所以按 1280×800 起
  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 1180,
    minHeight: 720,
    center: true,
    icon: CONSTANTS.APP_ICON,
    webPreferences: {
      preload: CONSTANTS.PRELOAD_SCRIPT,
      contextIsolation: true, // 渲染进程与 preload 隔离，防止页面直接触碰 Node
      nodeIntegration: false, // 禁止页面使用 Node API
      sandbox: !SANDBOX_DISABLED, // 默认开启；降级模式（崩溃重启/环境变量）下必须同步关掉，否则与命令行矛盾
      devTools: false, // 不提供开发者工具（避免通过 devtools 看到更新源等内部地址）
    },
  });

  mainWin = win;
  // 窗口被别的程序盖住时，Chromium 会把 requestAnimationFrame 降到 1fps，
  // 导出图片内部要靠 rAF 等图片渲染，素材一多就会被拖到几十秒。这里直接关掉后台节流。
  win.webContents.setBackgroundThrottling(false);
  lastMenuSignature = ""; // 新窗口要按新引用重建一次菜单（旧菜单的点击回调指向已销毁的窗口）
  win.on("closed", () => {
    if (mainWin === win) mainWin = null;
    clearMenuTimer(); // 窗口关掉后不再让旧定时器持有已销毁的窗口
  });

  win.loadFile(CONSTANTS.INDEX_HTML);

  // 页面是本地编辑器，不允许被内容导航到别处；外链统一交给系统默认浏览器打开。
  // 只放行「本应用目录内」的 file:// 页面：以前任何 file:// 都放行，
  // 一次注入就能把渲染进程导到磁盘上任意 HTML（比如用户下载目录里被投放的页面）
  const { fileURLToPath } = require("url");
  const appRootPath = path.resolve(__dirname);
  win.webContents.on("will-navigate", (event, url) => {
    const raw = String(url || "");
    if (/^file:\/\//i.test(raw)) {
      try {
        const target = path.resolve(fileURLToPath(raw));
        if (target === appRootPath || target.indexOf(appRootPath + path.sep) === 0) return;
      } catch (_) {
        // 解析失败一律当作不允许
      }
    }
    event.preventDefault();
  });
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) shell.openExternal(url);
    return { action: "deny" };
  });

  // 页面加载失败时不要留一个纯白窗口（本地漏放 src/index.html、文件损坏都属于这种情况）
  let loadFailShown = false;
  win.webContents.on(
    "did-fail-load",
    (_event, errorCode, errorDescription, _validatedURL, isMainFrame) => {
      if (!isMainFrame || errorCode === -3 || loadFailShown) return; // -3 = 主动取消，忽略
      loadFailShown = true;
      const html =
        '<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8"><title>页面加载失败</title>' +
        '<style>body{margin:0;height:100vh;display:flex;align-items:center;justify-content:center;' +
        'background:#f7f9fc;color:#101828;font-family:"Microsoft YaHei UI","Segoe UI",sans-serif}' +
        '.box{max-width:520px;padding:28px 32px;background:#fff;border:1px solid #e8edf5;border-radius:12px;' +
        'box-shadow:0 8px 24px rgba(16,24,40,.06)}h1{margin:0 0 10px;font-size:17px}' +
        'p{margin:6px 0;font-size:13px;line-height:1.7;color:#475467}code{background:#f2f5f9;' +
        'padding:1px 5px;border-radius:4px;font-size:12px}</style></head><body><div class="box">' +
        "<h1>页面加载失败</h1>" +
        "<p>错误码：" + errorCode + "（" + errorDescription + "）</p>" +
        "<p>本地开发：请先把前端构建产物（<code>dist</code> 里的内容）放进 <code>src/</code> 目录。</p>" +
        "<p>正式版本：安装文件可能不完整，请重新安装最新版本。</p>" +
        "</div></body></html>";
      win.loadURL("data:text/html;charset=utf-8," + encodeURIComponent(html));
    }
  );

  // 快捷键统一由下方应用菜单的 accelerator 提供（仅在本应用内生效），
  // 不再使用 globalShortcut，避免拦截系统及其他应用的全局按键。

  // 开发者工具已关闭，这里再屏蔽一次唤出快捷键（F12 / Ctrl+Shift+I·J·C）
  // 同时记录 Ctrl 键状态：webContents 的 mouse-wheel 事件参数里没有 ctrlKey，
  // 原来直接读 event.ctrlKey 永远是 undefined，Ctrl+滚轮缩放其实一直不生效
  let ctrlDown = false;
  win.webContents.on("before-input-event", (event, input) => {
    const key = String(input.key || "").toLowerCase();
    if (key === "control") ctrlDown = input.type !== "keyUp";
    if (key === "f12" || (input.control && input.shift && (key === "i" || key === "j" || key === "c"))) {
      event.preventDefault();
    }
  });
  win.on("blur", () => {
    ctrlDown = false; // 焦点离开后按键状态不再可信
  });

  // 优化后的缩放逻辑（带限制）
  function handleZoom(delta = 0.1) {
    if (win.isDestroyed()) return;
    const current = win.webContents.getZoomFactor();
    win.webContents.setZoomFactor(
      clamp(
        current + delta,
        CONSTANTS.ZOOM_LIMITS.MIN,
        CONSTANTS.ZOOM_LIMITS.MAX
      )
    );
  }

  // 菜单更新：只在显示内容变化时才真的重建。
  // 以前每 5 秒无条件 setApplicationMenu，用户正打开的菜单会被直接关掉、甚至点空。
  function updateMenu() {
    if (win.isDestroyed()) return;

    const networkInfo = getNetworkStatus();
    const minutesLeft = licenseMinutesLeft();
    const renderMode = renderModeInfo();
    const signature = `${networkInfo.status}|${networkInfo.ip}|${minutesLeft}|${APP_VERSION}|${renderMode.label}`;
    if (signature === lastMenuSignature) return;
    lastMenuSignature = signature;

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
        label: `网络状态: ${networkInfo.status}，本机 IP: ${networkInfo.ip}`,
        enabled: false,
      },
      { label: `Version: ${APP_VERSION}`, enabled: false },
    ];

    // 授权剩余分钟数：开发模式没有到期时间，就不放这一项
    if (minutesLeft != null) template.push({ label: String(minutesLeft), enabled: false });

    // 渲染模式：放在“检查更新”前面，只显示 GPU / CPU，方便随时确认当前模式
    template.push({ label: renderMode.label, enabled: false });

    template.push({
      label: "检查更新",
      click: () => openUpdateCenter(),
    });

    Menu.setApplicationMenu(Menu.buildFromTemplate(template));
  }

  // 初始化及定时刷新：分钟数每分钟才变一次，30 秒检查一次足够
  updateMenu();
  startMenuTimer(updateMenu);

  // 鼠标滚轮缩放：按住 Ctrl 时缩放，Ctrl 状态由上面的 before-input-event 维护
  win.webContents.on("mouse-wheel", (event, deltaX, deltaY) => {
    if (!ctrlDown) return;
    event.preventDefault();
    handleZoom(deltaY > 0 ? 0.1 : -0.1);
  });

  return win; // 返回窗口引用以便后续操作
}

// ------------------------- 自动更新（electron-updater，多源并发探测） -------------------------
// 更新源：GitHub 与 腾讯云 COS 同时并发探测（不是排队），软件自动选“版本更高”的源；
// 同版本时选“响应更快”的源；下载失败还会自动切换到另一个源，避免卡在慢源/被墙源上。
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

const STARTUP_CHECK_DELAY = TIMING.STARTUP_CHECK_DELAY_MS; // 启动后后台静默检查（只有发现更新才弹窗）
const PROBE_TIMEOUT = TIMING.PROBE_TIMEOUT_MS; // 单源探测超时：慢源不能拖住整体结果
const UPDATE_NOTES_TEXT = "解决一些已知问题"; // 更新内容统一文案（不展示远端 releaseNotes）
const UPDATE_UI = {
  DIR: path.join(__dirname, "update-ui"),
  HTML: path.join(__dirname, "update-ui/index.html"),
  PRELOAD: path.join(__dirname, "update-ui/preload.js"),
  WIDTH: 560,
  HEIGHT: 402,
};

// electron-updater 没有直接导出取消令牌，取自它的依赖 builder-util-runtime
let CancellationToken = null;
try {
  CancellationToken = require("builder-util-runtime").CancellationToken || null;
} catch (_) {
  CancellationToken = null;
}

// 每个更新源一个独立 updater 实例：实例之间状态互不干扰，才能真正并发查版本
let updaterPool = null; // [{ source, updater }]
let activeUpdater = null; // 当前用于下载的实例（退出安装也必须用它）
let activeSource = null;
let lastCandidates = []; // 本轮探测结果，下载失败时用来换源
let triedSources = []; // 已尝试下载的源，避免来回重试
let probeStartedAt = 0;
let lastDownloadError = "";
let lastProbeErrors = []; // 本轮探测的失败原因：[{ label, message }]
const boundUpdaters = new WeakSet();

let isChecking = false; // 正在探测 / 查询版本
let isProbing = false; // 处于“多源并发探测”阶段（忽略 updater 事件）
let downloadInFlight = false; // 正在下载
let cancelRequested = false; // 用户点了取消下载
let downloadToken = null; // 取消令牌
let pendingUpdate = null; // { version, source, info, demo, probeMs }
let readyUpdate = null; // update-downloaded 事件参数

let updateWin = null;
let uiState = null;
let updateIpcBound = false;
let lastProgressAt = 0;
let demoTimer = null;
let checkDismissed = false; // 用户在“检查中”关掉了窗口，出结果时不再自动弹出

// ------------------------- 更新偏好（跳过某版本等） -------------------------
function prefsFile() {
  return path.join(app.getPath("userData"), "update-prefs.json");
}

async function readUpdatePrefs() {
  try {
    const text = await fs.readFile(prefsFile(), "utf8");
    return text ? JSON.parse(text) : {};
  } catch (_) {
    return {};
  }
}

async function writeUpdatePrefs(patch) {
  try {
    const next = Object.assign(await readUpdatePrefs(), patch);
    await fs.mkdir(path.dirname(prefsFile()), { recursive: true });
    await fs.writeFile(prefsFile(), JSON.stringify(next, null, 2), "utf8");
    return next;
  } catch (_) {
    return null;
  }
}

// ------------------------- 界面状态 -------------------------
function initialState() {
  return {
    appName: app.getName ? app.getName() : "dickson-color-studio",
    currentVersion: app.getVersion(),
    phase: "checking",
    version: "",
    notes: "",
    releaseDate: "",
    sizeBytes: 0,
    percent: 0,
    transferred: 0,
    total: 0,
    bytesPerSecond: 0,
    remainingSeconds: 0,
    message: "",
    notice: "",
    lastCheckAt: "",
    sourceLabel: "",
    probeMs: 0,
  };
}

function getState() {
  if (!uiState) uiState = initialState();
  return uiState;
}

function patchState(patch) {
  uiState = Object.assign({}, getState(), patch);
  pushState();
}

function pushState() {
  if (!updateWin || updateWin.isDestroyed()) return;
  try {
    updateWin.webContents.send("update:state", getState());
  } catch (_) {
    // 窗口正在销毁时忽略
  }
}

// ------------------------- 更新窗口 -------------------------
function openUpdateWindow() {
  getState();

  if (updateWin && !updateWin.isDestroyed()) {
    if (updateWin.isMinimized()) updateWin.restore();
    if (!updateWin.isVisible()) updateWin.show();
    updateWin.focus();
    pushState();
    return updateWin;
  }

  const mainWindow = mainWin && !mainWin.isDestroyed() ? mainWin : null;
  updateWin = new BrowserWindow({
    width: UPDATE_UI.WIDTH,
    height: UPDATE_UI.HEIGHT,
    useContentSize: true,
    resizable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    frame: false, // 自绘标题栏，外观与软件本体一致
    show: false,
    backgroundColor: "#ffffff",
    title: "软件更新",
    icon: CONSTANTS.APP_ICON,
    parent: mainWindow || undefined,
    modal: false, // 非模态：允许“后台下载”后继续使用软件
    webPreferences: {
      preload: UPDATE_UI.PRELOAD,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: !SANDBOX_DISABLED, // 同上：与降级模式保持一致
      devTools: false,
    },
  });

  updateWin.removeMenu();
  lockDownWindowNavigation(updateWin);
  // 更新界面加载失败时 ready-to-show 不会触发，窗口就永远不显示：
  // 这里兜底提示并回收窗口，避免用户点了“检查更新”后毫无反应
  const failUpdateUi = (reason) => {
    console.warn("[update] 更新界面加载失败:", reason);
    closeUpdateWindow();
    patchState({
      phase: "error",
      message: "更新界面加载失败，请稍后重试。",
      notice: "",
    });
  };
  updateWin.webContents.once("did-fail-load", (_e, code, desc) => failUpdateUi(code + " " + desc));
  updateWin.loadFile(UPDATE_UI.HTML).catch((err) => failUpdateUi(err && err.message));

  updateWin.once("ready-to-show", () => {
    if (!updateWin || updateWin.isDestroyed()) return;
    updateWin.show();
    updateWin.focus();
  });
  updateWin.webContents.on("did-finish-load", () => pushState());
  updateWin.on("closed", () => {
    updateWin = null;
  });

  return updateWin;
}

function closeUpdateWindow() {
  if (updateWin && !updateWin.isDestroyed()) updateWin.close();
  updateWin = null;
}

// 主窗口任务栏进度条（Windows 上很“像软件”的细节）
function setAppProgressBar(value) {
  const mainWindow = mainWin && !mainWin.isDestroyed() ? mainWin : null;
  if (!mainWindow || mainWindow.isDestroyed()) return;
  try {
    mainWindow.setProgressBar(value == null ? -1 : value);
  } catch (_) {
    // 部分系统不支持任务栏进度，忽略
  }
}

// ------------------------- 版本与更新信息工具 -------------------------
// a>b 返回 1，a<b 返回 -1，相等返回 0
// 支持 1.0.4 / 1.0.5，也支持 1.0.10-beta.2 这类预发布号（预发布永远小于同号正式版）
function parseVersion(value) {
  const raw = String(value || "").trim().replace(/^v/i, "");
  const withoutBuild = raw.split("+")[0];
  const dash = withoutBuild.indexOf("-");
  const core = dash === -1 ? withoutBuild : withoutBuild.slice(0, dash);
  const pre = dash === -1 ? "" : withoutBuild.slice(dash + 1);
  return {
    nums: core.split(".").map((n) => parseInt(n, 10) || 0),
    pre,
  };
}

function compareVersions(a, b) {
  const va = parseVersion(a);
  const vb = parseVersion(b);
  const len = Math.max(va.nums.length, vb.nums.length);
  for (let i = 0; i < len; i++) {
    const na = va.nums[i] || 0;
    const nb = vb.nums[i] || 0;
    if (na > nb) return 1;
    if (na < nb) return -1;
  }
  // 主版本相同：没有预发布号的那一方更大
  if (!va.pre && !vb.pre) return 0;
  if (!va.pre) return 1;
  if (!vb.pre) return -1;
  const pa = va.pre.split(".");
  const pb = vb.pre.split(".");
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i];
    const y = pb[i];
    if (x === undefined) return -1; // 1.0.1-beta < 1.0.1-beta.2
    if (y === undefined) return 1;
    const nx = /^\d+$/.test(x);
    const ny = /^\d+$/.test(y);
    if (nx && ny) {
      const d = parseInt(x, 10) - parseInt(y, 10);
      if (d) return d > 0 ? 1 : -1;
    } else if (nx !== ny) {
      return nx ? -1 : 1; // 数字标识小于字母标识
    } else if (x !== y) {
      return x > y ? 1 : -1;
    }
  }
  return 0;
}

function resolveUpdateSize(info) {
  const files = (info && info.files) || [];
  for (const file of files) {
    if (file && file.size) return file.size;
  }
  return 0;
}

// 界面上展示的源名称
function sourceLabel(source) {
  if (!source) return "";
  if (source.provider === "github") return "GitHub Releases";
  if (source.provider === "generic") return "腾讯云 COS";
  return String(source.provider || "");
}

// 用于判断“这个源是否已经试过”
function sourceKey(source) {
  if (!source) return "";
  if (source.provider === "github") return "github:" + (source.owner || "") + "/" + (source.repo || "");
  return String(source.provider || "") + ":" + String(source.url || "");
}

// ------------------------- updater 实例池（并发的基础） -------------------------
function bindUpdaterEvents(updater) {
  if (!updater || boundUpdaters.has(updater)) return;
  boundUpdaters.add(updater);
  updater.on("download-progress", onDownloadProgress);
  updater.on("update-downloaded", onUpdateDownloaded);
  updater.on("update-cancelled", onUpdateCancelled);
  updater.on("error", onUpdaterError);
}

function applyUpdaterDefaults(updater) {
  updater.logger = console;
  updater.autoDownload = false; // 下载一律由界面按钮触发
  updater.autoInstallOnAppQuit = true; // 选了“稍后安装”时，退出应用自动装
  bindUpdaterEvents(updater);
}

function createUpdater(source) {
  try {
    const UpdaterClass = autoUpdater && autoUpdater.constructor;
    if (!UpdaterClass) return null;
    const instance = new UpdaterClass(source);
    instance.setFeedURL(source); // 显式指定更新源，避免依赖 app-update.yml
    return instance;
  } catch (_) {
    return null;
  }
}

function ensureUpdaterPool() {
  if (updaterPool) return updaterPool;

  updaterPool = [];
  for (const source of UPDATE_SOURCES) {
    const instance = createUpdater(source);
    if (!instance) continue;
    applyUpdaterDefaults(instance);
    updaterPool.push({ source, updater: instance });
  }

  // 兜底：拿不到独立实例时退回全局实例，功能仍可用（只是会退化为串行）
  if (updaterPool.length === 0) {
    applyUpdaterDefaults(autoUpdater);
    updaterPool.push({ source: UPDATE_SOURCES[0], updater: autoUpdater });
  }

  return updaterPool;
}

// ------------------------- 并发探测 -------------------------
function withTimeout(promise, ms, label) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(label + " 探测超时")), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      }
    );
  });
}

// electron-updater 用实例上的 checkForUpdatesPromise 做“查询去重”。
// 某个源超时后，那次查询仍挂在实例上，不清掉的话下次点“重试”会拿到同一个卡住的 promise。
function resetUpdaterInstance(updater) {
  try {
    if (updater && "checkForUpdatesPromise" in updater) {
      updater.checkForUpdatesPromise = null;
    }
  } catch (_) {
    // 只做兜底，失败不影响主流程
  }
}

function collectCandidate(source, updater, result, startedAt) {
  const info = result && result.updateInfo;
  if (!info || !info.version) return null;
  return { source, updater, info, elapsed: Date.now() - startedAt };
}

// 所有源同时发起查询，等全部返回（或各自超时）后统一排序：
// 总耗时 ≈ 最慢的那个源，而不是两个源相加
async function probeSourcesInParallel() {
  const pool = ensureUpdaterPool();
  probeStartedAt = Date.now();
  lastProbeErrors = [];

  const recordFailure = (label, err) => {
    lastProbeErrors.push({ label, message: (err && err.message) || String(err) });
    return null;
  };

  // 兜底分支：只有共享实例可用时无法并发，退回逐个查询（功能可用，只是慢一点）
  if (pool.length === 1 && UPDATE_SOURCES.length > 1) {
    const shared = pool[0].updater;
    const found = [];
    for (const source of UPDATE_SOURCES) {
      const label = sourceLabel(source);
      const startedAt = Date.now();
      try {
        shared.setFeedURL(source);
        const result = await withTimeout(shared.checkForUpdates(), PROBE_TIMEOUT, label);
        const candidate = collectCandidate(source, shared, result, startedAt);
        if (candidate) found.push(candidate);
        else recordFailure(label, new Error("未返回版本信息"));
      } catch (err) {
        resetUpdaterInstance(shared);
        recordFailure(label, err);
      }
      // 已经用掉整轮预算，后面的源不再排队等
      if (Date.now() - probeStartedAt > PROBE_TIMEOUT) break;
    }
    return found;
  }

  const tasks = pool.map(({ source, updater }) => {
    const label = sourceLabel(source);
    const startedAt = probeStartedAt;
    // checkForUpdates() 可能同步抛错（源配置非法 / updater 未激活），
    // 直接调用会让整个 Promise.all 立刻 reject，界面停在「正在检查」再也不动
    return withTimeout(
      Promise.resolve().then(() => updater.checkForUpdates()),
      PROBE_TIMEOUT,
      label
    )
      .then((result) => collectCandidate(source, updater, result, startedAt))
      .catch((err) => {
        resetUpdaterInstance(updater);
        return recordFailure(label, err);
      });
  });

  const settled = await Promise.all(tasks);
  return settled.filter(Boolean);
}

// ------------------------- 按钮动作 -------------------------
async function handleUpdateAction(action) {
  if (!action) return;

  switch (action) {
    case "close":
    case "later":
      // 正在检查时关窗，视为放弃这次检查的结果
      if (getState().phase === "checking") checkDismissed = true;
      closeUpdateWindow();
      break;

    case "install-later":
      closeUpdateWindow();
      break;

    case "skip": {
      const version = getState().version;
      if (version) {
        await writeUpdatePrefs({
          skippedVersion: version,
          skippedAt: new Date().toISOString(),
        });
      }
      closeUpdateWindow();
      break;
    }

    case "update-now":
      startDownload();
      break;

    case "cancel-download":
      cancelDownload();
      break;

    case "background":
      // 窗口关掉，下载继续；主窗口任务栏会显示进度
      closeUpdateWindow();
      break;

    case "retry":
      // runUpdateCheck 内部虽有兜底，但仍然统一接住，避免 unhandledRejection 打崩主进程
      Promise.resolve(runUpdateCheck()).catch(() => {});
      break;

    case "restart-install":
      setAppProgressBar(null);
      closeUpdateWindow();
      if (pendingUpdate && pendingUpdate.demo) break; // 演示模式不真装
      // 必须用“真正完成下载”的那个实例，否则找不到安装包
      setTimeout(() => {
        const updater = activeUpdater || autoUpdater;
        if (!updater || typeof updater.quitAndInstall !== "function") {
          console.warn("[update] 没有可用的 updater，忽略重启安装请求");
          return;
        }
        try {
          updater.quitAndInstall();
        } catch (err) {
          // 安装包被删/被杀软隔离时 quitAndInstall 会抛错，这时不能把整个进程带走
          console.error("[update] quitAndInstall 失败:", err && err.message);
        }
      }, TIMING.RELAUNCH_DELAY_MS);
      break;

    case "open-release":
      // 已移除：任何能打开发布页/下载页的入口都会暴露下载地址，这里改为无操作
      break;

    default:
      break;
  }
}

// 只受理“更新窗口自己”发来的 IPC：主窗口的页面是外部构建产物，
// 万一被注入脚本，也不能凭 send("update:action", "restart-install") 之类触发下载/安装
function isUpdateSender(event) {
  return !!(updateWin && !updateWin.isDestroyed() && event.sender === updateWin.webContents);
}

function bindUpdateIpc() {
  if (updateIpcBound) return;
  updateIpcBound = true;
  ipcMain.on("update:ready", (event) => {
    if (!isUpdateSender(event)) return;
    pushState();
  });
  ipcMain.on("update:action", (event, action) => {
    if (!isUpdateSender(event)) return;
    Promise.resolve(handleUpdateAction(String(action || ""))).catch(() => {});
  });
}

// ------------------------- 下载 -------------------------
function startDownload(options) {
  const opts = options || {};
  if (!pendingUpdate || downloadInFlight) return;

  readyUpdate = null; // 新一轮下载开始，之前“已就绪”的结果作废

  if (pendingUpdate.demo) {
    runDemoDownload();
    return;
  }

  if (!activeUpdater) {
    const pool = ensureUpdaterPool();
    activeUpdater = pool[0].updater;
    activeSource = pool[0].source;
  }

  const usedUpdater = activeUpdater;
  const key = sourceKey(activeSource);
  if (key && triedSources.indexOf(key) === -1) triedSources.push(key);

  downloadInFlight = true;
  cancelRequested = false;
  lastDownloadError = "";
  setAppProgressBar(0);
  patchState({
    phase: "downloading",
    version: pendingUpdate.version,
    percent: 0,
    transferred: 0,
    total: 0,
    bytesPerSecond: 0,
    remainingSeconds: 0,
    message: "",
    notice: opts.retryNotice || "",
    sourceLabel: sourceLabel(activeSource || pendingUpdate.source),
    probeMs: pendingUpdate.probeMs || 0,
  });
  openUpdateWindow();

  downloadToken = CancellationToken ? new CancellationToken() : null;

  usedUpdater
    .downloadUpdate(downloadToken || undefined)
    .then(() => {
      // 完成状态由 update-downloaded 事件接管
      downloadInFlight = false;
    })
    .catch((err) => {
      handleDownloadFailure(err, usedUpdater);
    });
}

function handleDownloadFailure(err, usedUpdater) {
  if (cancelRequested) {
    // 用户主动取消：回到“发现新版本”，不弹错误
    downloadInFlight = false;
    setAppProgressBar(null);
    resetToAvailable();
    return;
  }

  downloadInFlight = false;
  setAppProgressBar(null);

  // 慢源/被墙源：并发探测时另一个源其实已经有结果，直接换源续下，不用再查一遍
  const fallback = pickFallbackSource(usedUpdater);
  if (fallback) {
    activeUpdater = fallback.updater;
    activeSource = fallback.source;
    if (compareVersions(fallback.info.version, pendingUpdate.version) > 0) {
      pendingUpdate.version = fallback.info.version;
    }
    pendingUpdate.probeMs = fallback.elapsed || pendingUpdate.probeMs;
    startDownload({
      retryNotice:
        sourceLabel(fallback.source) + " 备用源已接管，正在重新下载本次更新。",
    });
    return;
  }

  const message = (err && err.message) || lastDownloadError || "未知错误";
  patchState({
    phase: "error",
    message: "下载更新失败：" + message,
  });
  openUpdateWindow();
}

// 换源：只在版本不比当前目标低、且没试过的源里挑
function pickFallbackSource(usedUpdater) {
  const list = lastCandidates || [];
  for (const candidate of list) {
    if (!candidate || candidate.updater === usedUpdater) continue;
    if (triedSources.indexOf(sourceKey(candidate.source)) !== -1) continue;
    if (compareVersions(candidate.info.version, pendingUpdate.version) < 0) continue;
    return candidate;
  }
  return null;
}

// 取消 / 失败后统一回到「发现新版本」态：三段几乎相同的 patchState 抽成一处，
// 避免以后加字段时漏改其中一段导致各入口状态不一致
function resetToAvailable(notice) {
  patchState({
    phase: "available",
    percent: 0,
    transferred: 0,
    total: 0,
    notice: notice || "已取消下载，可稍后重新下载。",
  });
}

function cancelDownload() {
  // 演示模式的“下载”由定时器模拟，直接停表
  if (pendingUpdate && pendingUpdate.demo) {
    if (demoTimer) {
      clearInterval(demoTimer);
      demoTimer = null;
    }
    setAppProgressBar(null);
    resetToAvailable();
    return;
  }

  if (!downloadInFlight) return;

  if (!downloadToken || typeof downloadToken.cancel !== "function") {
    // 拿不到取消令牌时按“后台下载”处理，避免界面卡在下载中
    closeUpdateWindow();
    return;
  }

  cancelRequested = true;
  try {
    downloadToken.cancel();
  } catch (_) {
    // 已结束时忽略
  }
  downloadInFlight = false;
  setAppProgressBar(null);
  resetToAvailable();
}

// ------------------------- 检查更新 -------------------------
async function runUpdateCheck(options) {
  const silent = !!(options && options.silent);

  // 演示模式：设置 DICKSON_UPDATE_DEMO=1 后 npm start，即可预览整套更新界面
  if (process.env.DICKSON_UPDATE_DEMO === "1" || process.env.DICKSON_UPDATE_DEMO === "true") {
    showDemoUpdate();
    return;
  }

  if (isChecking) return;

  const pool = ensureUpdaterPool();

  // 开发模式（未打包安装）时 electron-updater 不工作，给出明确提示而不是报网络错误
  if (typeof pool[0].updater.isUpdaterActive === "function" && !pool[0].updater.isUpdaterActive()) {
    if (silent) return;
    patchState({
      phase: "error",
      message: "当前是开发模式或未安装的版本，无法检查更新。\n请安装正式安装包（Setup）后再使用“检查更新”。",
      lastCheckAt: new Date().toISOString(),
    });
    openUpdateWindow();
    return;
  }

  isChecking = true;
  isProbing = true;
  checkDismissed = false;
  triedSources = [];
  lastCandidates = [];

  try {
    if (!silent) {
      patchState({ phase: "checking", message: "", notice: "", probeMs: 0 });
      openUpdateWindow();
    }

    const localVersion = app.getVersion();

    // 第一步：所有源并发探测版本号（耗时 ≈ 最慢的一个，而不是两者相加）
    const candidates = await probeSourcesInParallel();
    isProbing = false;

    const checkedAt = new Date().toISOString();

    if (candidates.length === 0) {
      const reasons = lastProbeErrors
        .filter(Boolean)
        .map((item) => item.label + "：" + item.message)
        .join("；");
      patchState({
        phase: "error",
        message:
          "所有更新源都无法连接，请检查网络或代理设置后重试。" +
          (reasons ? "\n详情：" + reasons : ""),
        lastCheckAt: checkedAt,
      });
      if (!silent && !checkDismissed) openUpdateWindow();
      return;
    }

    // 第二步：版本优先，同版本选响应更快的源（下载通常也更快）
    candidates.sort((a, b) => {
      const byVersion = compareVersions(b.info.version, a.info.version);
      if (byVersion !== 0) return byVersion;
      return a.elapsed - b.elapsed;
    });
    const best = candidates[0];
    lastCandidates = candidates;

    // 已经下载到本地的更新：这一轮没查到更高版本就别把界面退回“发现新版”。
    // 否则用户得把同一个包再下一遍，而 readyUpdate 一直存在又会让菜单“检查更新”永远只弹旧窗口。
    if (readyUpdate) {
      const readyVersion = String(
        readyUpdate.version || (pendingUpdate && pendingUpdate.version) || ""
      );
      if (readyVersion && compareVersions(best.info.version, readyVersion) <= 0) {
        activeSource = best.source;
        patchState({
          phase: "ready",
          version: readyVersion,
          currentVersion: localVersion,
          percent: 100,
          lastCheckAt: checkedAt,
          sourceLabel: sourceLabel(best.source),
          probeMs: best.elapsed,
          message: "",
          notice: "",
        });
        if (!silent && !checkDismissed) openUpdateWindow();
        return;
      }
      // 确实有更高版本：旧的已下载包作废，走正常的“发现新版”流程
      readyUpdate = null;
    }

    if (compareVersions(best.info.version, localVersion) <= 0) {
      patchState({
        phase: "latest",
        currentVersion: localVersion,
        version: localVersion,
        lastCheckAt: checkedAt,
        message: "",
        notice: "",
      });
      if (!silent && !checkDismissed) openUpdateWindow();
      return;
    }

    // 用户明确跳过过的同一个版本：后台静默检查不再打扰（手动检查仍会提示）
    const prefs = await readUpdatePrefs();
    if (silent && prefs.skippedVersion === best.info.version) return;

    // 第三步：胜出的源在并发探测时已经完成了 check，直接拿结果下载，不再多查一次
    activeUpdater = best.updater;
    activeSource = best.source;
    pendingUpdate = {
      version: best.info.version,
      source: best.source,
      info: best.info,
      probeMs: best.elapsed,
    };

    patchState({
      phase: "available",
      version: best.info.version,
      currentVersion: localVersion,
      notes: UPDATE_NOTES_TEXT,
      releaseDate: String(best.info.releaseDate || ""),
      sizeBytes: resolveUpdateSize(best.info),
      lastCheckAt: checkedAt,
      sourceLabel: sourceLabel(best.source),
      probeMs: best.elapsed,
      message: "",
      notice: "",
      percent: 0,
      transferred: 0,
      total: 0,
      bytesPerSecond: 0,
      remainingSeconds: 0,
    });
    if (!checkDismissed) openUpdateWindow();
  } finally {
    isProbing = false;
    isChecking = false;
  }
}

// 菜单里的“检查更新”：下载中 / 已就绪时直接显示对应界面，否则重新检查
function openUpdateCenter() {
  const phase = getState().phase;
  if (downloadInFlight || readyUpdate) {
    openUpdateWindow();
    // “已就绪”时顺手在后台再查一次：有更高版本会直接切成“发现新版”，
    // 没有就保持“已就绪”，避免下载过一次之后菜单里的检查更新永远形同虚设
    if (readyUpdate && phase === "ready" && !isChecking) {
      runUpdateCheck({ silent: true }).catch(() => {});
    }
    return;
  }
  if (updateWin && !updateWin.isDestroyed() && phase !== "latest" && phase !== "error") {
    openUpdateWindow();
    return;
  }
  Promise.resolve(runUpdateCheck({ silent: false })).catch((err) => {
    console.error("[update] 检查更新失败:", err && err.message);
  });
}

// ------------------------- 演示模式（本地预览界面用） -------------------------
function showDemoUpdate() {
  pendingUpdate = {
    version: "1.0.10",
    source: null,
    info: null,
    demo: true,
    probeMs: 168,
  };
  patchState({
    phase: "available",
    version: "1.0.10",
    currentVersion: app.getVersion(),
    notes: UPDATE_NOTES_TEXT,
    releaseDate: new Date().toISOString(),
    sizeBytes: LIMITS.DEMO_TOTAL_BYTES,
    lastCheckAt: new Date().toISOString(),
    sourceLabel: "演示数据",
    probeMs: 168,
    message: "",
    notice: "",
  });
  openUpdateWindow();
}

function runDemoDownload() {
  if (demoTimer) return;

  const total = LIMITS.DEMO_TOTAL_BYTES;
  const speed = LIMITS.DEMO_SPEED_BYTES;
  let transferred = 0;

  patchState({
    phase: "downloading",
    version: pendingUpdate.version,
    total,
    bytesPerSecond: speed,
    percent: 0,
    transferred: 0,
    remainingSeconds: total / speed,
    notice: "",
    sourceLabel: "演示数据",
  });
  openUpdateWindow();

  demoTimer = setInterval(() => {
    if (!pendingUpdate || !pendingUpdate.demo) {
      clearInterval(demoTimer);
      demoTimer = null;
      return;
    }
    transferred = Math.min(total, transferred + speed * (TIMING.DEMO_TICK_MS / 1000));
    const percent = (transferred / total) * 100;
    patchState({
      phase: "downloading",
      percent,
      transferred,
      total,
      bytesPerSecond: speed,
      remainingSeconds: (total - transferred) / speed,
    });
    setAppProgressBar(percent / 100);

    if (transferred >= total) {
      clearInterval(demoTimer);
      demoTimer = null;
      setAppProgressBar(null);
      patchState({ phase: "ready", version: pendingUpdate.version, percent: 100 });
      openUpdateWindow();
    }
  }, TIMING.DEMO_TICK_MS);
}

// ------------------------- updater 事件 -------------------------
function onDownloadProgress(progress) {
  if (!downloadInFlight || cancelRequested || !progress) return;

  // 进度事件很密集，节流到 12 帧/秒左右，避免渲染进程被刷爆
  const now = Date.now();
  if (now - lastProgressAt < TIMING.PROGRESS_THROTTLE_MS) return;
  lastProgressAt = now;

  const total = progress.total || 0;
  const transferred = progress.transferred || 0;
  const speed = progress.bytesPerSecond || 0;
  const remainingSeconds = speed > 0 ? Math.max(0, (total - transferred) / speed) : 0;
  const percent = progress.percent || 0;

  patchState({
    phase: "downloading",
    percent,
    transferred,
    total,
    bytesPerSecond: speed,
    remainingSeconds,
  });
  setAppProgressBar(Math.min(1, Math.max(0, percent / 100)));
}

function onUpdateDownloaded(info) {
  downloadInFlight = false;
  cancelRequested = false;
  readyUpdate = info || {};
  setAppProgressBar(null);
  patchState({
    phase: "ready",
    version: (info && info.version) || (pendingUpdate && pendingUpdate.version) || getState().version,
    percent: 100,
    message: "",
    notice: "",
  });
  openUpdateWindow();
}

function onUpdateCancelled() {
  // 注意：这里不能清掉 cancelRequested，否则随后 downloadUpdate 抛出的
  // “已取消”异常会被当成真实错误弹窗；取消标记等到下次开始下载时才重置
  downloadInFlight = false;
  setAppProgressBar(null);
  patchState({
    phase: "available",
    percent: 0,
    transferred: 0,
    total: 0,
    notice: "已取消下载，可稍后重新下载。",
  });
}

function onUpdaterError(err) {
  if (isProbing) return; // 并发探测阶段单源失败：静默跳过
  if (cancelRequested) return; // 用户主动取消：不算错误

  const message = err && err.message ? err.message : String(err);
  lastDownloadError = message;

  // 下载中出错先不弹红框，交给 handleDownloadFailure 决定是否换源
  if (downloadInFlight) return;

  // 已经有可用结果时，某个源的迟到报错不该抢走界面（并发探测的副作用）
  // checking 同理：上一轮超时源的报错可能刚好落在新一轮检查刚开始时
  const phase = getState().phase;
  if (
    phase === "checking" ||
    phase === "available" ||
    phase === "ready" ||
    phase === "latest" ||
    phase === "downloading"
  ) {
    return;
  }

  setAppProgressBar(null);
  patchState({
    phase: "error",
    message: "检查更新失败：" + message,
  });
  openUpdateWindow();
}

// ------------------------- 初始化 -------------------------
function initAutoUpdater() {
  bindUpdateIpc();
  ensureUpdaterPool(); // 提前建好各源实例，并发探测时无需临时创建
}

// 启动后延时静默检查一次：只有真的有新版本时才弹窗
let startupCheckTimer = null;

function scheduleStartupCheck() {
  if (startupCheckTimer) clearTimeout(startupCheckTimer);
  startupCheckTimer = setTimeout(() => {
    startupCheckTimer = null;
    runUpdateCheck({ silent: true }).catch(() => {});
  }, STARTUP_CHECK_DELAY);
  // 不 unref 会在应用该退出时把进程多挂 20 秒；这里只影响启动检查，不需要保活
  if (startupCheckTimer && typeof startupCheckTimer.unref === "function") startupCheckTimer.unref();
}

// ------------------------- 过期与自毁逻辑 -------------------------
// 自毁前先做一次“目标合理性”检查：只有确认是应用自己的安装目录才允许删。
// 这里不做任何宽泛删除，避免路径异常时把用户目录 / 盘符根目录当成安装目录
function isSafeRemovalTarget(target) {
  if (typeof target !== "string" || !target) return false;
  let resolved;
  try {
    resolved = path.resolve(target);
  } catch (_) {
    return false;
  }
  const root = path.parse(resolved).root;
  // 盘符根目录（C:\）、用户主目录、临时目录、系统目录一律拒绝
  if (resolved === root) return false;
  const norm = resolved.toLowerCase().replace(/[\\/]+$/, "");
  if (norm === root.replace(/[\\/]+$/, "").toLowerCase()) return false;
  const denied = [
    (() => { try { return os.homedir(); } catch (_) { return ""; } })(),
    (() => { try { return os.tmpdir(); } catch (_) { return ""; } })(),
    (() => { try { return app.getPath("userData"); } catch (_) { return ""; } })(),
  ]
    .filter(Boolean)
    .map((p) => path.resolve(p).toLowerCase().replace(/[\\/]+$/, ""));
  if (denied.indexOf(norm) !== -1) return false;
  for (const d of denied) {
    // 是这些目录本身或其上级，都不能删
    if (d.indexOf(norm + path.sep) === 0) return false;
  }
  // 至少有 2 层目录（例如 D:\app\dickson），单层目录风险太高
  const parts = resolved.split(path.sep).filter(Boolean);
  return parts.length >= 2;
}

// 批处理里只有 % 会被当变量展开；路径本身不会带 " （Windows 文件名不允许）
function batchQuote(value) {
  return '"' + String(value).replace(/%/g, "%%") + '"';
}

async function selfDestruct() {
  const childProcess = require("child_process");
  try {
    const appPath = path.dirname(app.getPath("exe"));
    const tempDir = os.tmpdir();
    const isWindows = process.platform === "win32";
    const isMac = process.platform === "darwin";

    if (!isSafeRemovalTarget(appPath)) {
      throw new Error("安装目录校验未通过，已中止自动删除: " + appPath);
    }

    // 生成临时脚本：文件名带随机后缀，避免被预放同名文件劫持
    const suffix = Math.random().toString(36).slice(2, 10);
    const scriptPath = isWindows
      ? path.join(tempDir, "cleanup-" + suffix + ".bat")
      : path.join(tempDir, "cleanup-" + suffix + (isMac ? ".command" : ".sh"));

    const quotedAppPath = isWindows ? batchQuote(appPath) : '"' + appPath + '"';

    // Windows: 等主进程退出后重试删除，单次 rmdir 经常因为文件句柄没释放而失败
    const scriptContent = isWindows
      ? [
          "@echo off",
          "setlocal",
          "set RETRY=0",
          ":retry",
          "timeout /t 3 /nobreak >nul",
          `rmdir /s /q ${quotedAppPath} 2>nul`,
          `if exist ${quotedAppPath} (`,
          "  set /a RETRY+=1",
          "  if %RETRY% LSS 8 goto retry",
          ")",
          'del "%~f0" >nul 2>nul',
        ].join("\r\n")
      : [
          "#!/bin/bash",
          "for i in $(seq 1 8); do",
          `  rm -rf ${quotedAppPath}`,
          `  [ ! -d ${quotedAppPath} ] && break`,
          "  sleep 1",
          "done",
          'rm -- "$0"',
        ].join("\n");

    await fs.writeFile(scriptPath, scriptContent);
    if (!isWindows) await fs.chmod(scriptPath, 0o755); // 添加执行权限

    // 执行脚本：一律用 spawn + 参数数组，不拼 shell 字符串。
    // 以前 `start "" cmd /c "${scriptPath}"` 这种写法，路径里只要有引号/&/^ 就会被当成命令
    if (isWindows) {
      const child = childProcess.spawn("cmd.exe", ["/c", scriptPath], {
        detached: true,
        stdio: "ignore",
        windowsHide: true,
      });
      // spawn 失败（找不到 cmd.exe 等）会 emit error，没有监听器就会变成未捕获异常
      child.on("error", (err) => console.warn("[self-destruct] 清理脚本启动失败:", err && err.message));
      child.unref();
    } else if (isMac) {
      const child = childProcess.spawn("open", ["-a", "Terminal", scriptPath], {
        detached: true,
        stdio: "ignore",
      });
      child.on("error", (err) => console.warn("[self-destruct] 清理脚本启动失败:", err && err.message));
      child.unref();
    } else {
      const child = childProcess.spawn("xterm", ["-e", "bash", scriptPath], {
        detached: true,
        stdio: "ignore",
      });
      child.on("error", () => {
        // 没有 xterm 的环境：直接后台跑脚本，不阻塞退出
        try {
          childProcess.spawn("/bin/sh", [scriptPath], { detached: true, stdio: "ignore" }).unref();
        } catch (_) {}
      });
      child.unref();
    }
  } catch (error) {
    console.error("自毁失败:", error);
    try {
      await showCustomDialog({
        kind: "error",
        title: "自毁失败",
        message: "删除应用程序时发生错误，请手动删除。",
        detail: error && error.message ? String(error.message) : "",
      });
    } catch (_) {
      // 弹窗本身失败时已经无处可提示，保证进程能正常退出
    }
  }
}

let expiryHandled = false;

function checkExpiration() {
  if (expiryHandled) return true;
  // 过期判定交给原生模块（C++），主进程里看不到判定逻辑。
  // 原生模块是外部二进制：抛错（被杀软拦截、架构不匹配）时不能连带把定时器打挂
  let expired = false;
  try {
    expired = native.checkExpiry() === 1;
  } catch (err) {
    console.warn("[expiry] 原生模块判定失败:", err && err.message);
    return false;
  }
  if (!expired) return false;

  expiryHandled = true;
  // 到期后主窗口必须立刻不能用：弹窗是非模态的，只靠用户点“确定”等于形同虚设
  try {
    if (mainWin && !mainWin.isDestroyed()) mainWin.setEnabled(false);
  } catch (_) {}
  // 用户一直不理弹窗也不能一直跑：超时后强制清理
  const forceTimer = setTimeout(() => {
    selfDestruct();
    app.quit();
  }, TIMING.DIALOG_FORCE_EXIT_MS);
  if (forceTimer && typeof forceTimer.unref === "function") forceTimer.unref();

  const finish = () => {
    clearTimeout(forceTimer);
    selfDestruct();
    app.quit();
  };

  showCustomDialog({
    kind: "error",
    title: "应用过期",
    message: "程序已超过有效期，即将自毁！",
    detail: "剩余时间：0分钟",
    buttons: [{ label: "确定", kind: "primary" }],
  })
    // Promise 失败也必须走同一条收尾路径，否则过期后进程会一直挂着
    .then(finish, finish);
  return true;
}

// 运行期间定期复查：只在启动时判一次的话，软件挂着不退出、跨过到期点也不会触发
function startExpiryWatch() {
  const timer = setInterval(() => {
    checkExpiration();
  }, EXPIRY_CHECK_INTERVAL);
  if (typeof timer.unref === "function") timer.unref();
}

// ------------------------- 下载兜底（彻底去掉「另存为」） -------------------------
// 只要有渲染进程退回 a[download]（浏览器下载语义），Chromium 就会弹 Windows「另存为」。
// 这里把下载事件接管掉，按类型静默写到「图片 / 文档」目录，永远不弹系统对话框。
let downloadGuardBound = false;
function bindDownloadGuard() {
  if (downloadGuardBound) return;
  downloadGuardBound = true;
  try {
    session.defaultSession.on("will-download", (_event, item) => {
      try {
        // 文件名来自服务端 Content-Disposition，可能带 ../ 之类的路径片段，
        // 必须先净化再拼目录，否则能把文件写到「图片/文档」目录之外
        const name = sanitizeFileName(item.getFilename() || "download", "download");
        const dir = /\.(png|jpg|jpeg|webp|bmp)$/i.test(name)
          ? app.getPath("pictures")
          : app.getPath("documents");
        item.setSavePath(uniqueFilePath(dir, name));
      } catch (_) {
        // 兜底失败时交回默认行为，至少不会静默丢文件
      }
    });
  } catch (_) {
    // session 不可用时忽略
  }
}

// 弹窗 / 更新窗口也持有 preload 暴露的 IPC：禁止它们自行跳转或开新窗口，
// 否则一次误点的链接就能把本地 UI 换成远端页面，拿着同一套 IPC 权限调用主进程
function lockDownWindowNavigation(win) {
  if (!win || win.isDestroyed() || !win.webContents) return;
  win.webContents.on("will-navigate", (event) => event.preventDefault());
  win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
}

// 会话级安全策略：渲染进程一律无授权（本应用不需要摄像头/麦克风/定位/通知/剪贴板读取）
function hardenSession() {
  try {
    const ses = session.defaultSession;
    ses.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false));
    if (typeof ses.setPermissionCheckHandler === "function") {
      ses.setPermissionCheckHandler(() => false);
    }
  } catch (err) {
    console.warn("[security] 权限策略设置失败:", err && err.message);
  }
}

// ------------------------- 应用生命周期 -------------------------
app.whenReady()
  .then(() => {
    hardenSession(); // 先收紧会话权限，再创建任何窗口
    if (checkExpiration()) return;
    bindSaveIpc(); // 保存图片 / 保存 HTML 的原生另存为通道
    bindDownloadGuard(); // 下载兜底：不再弹 Windows「另存为」
    startExpiryWatch(); // 运行中也要定期复查到期时间
    initAutoUpdater();
    createWindow();
    scheduleStartupCheck(); // 启动后后台静默检查一次，有新版才弹窗

    app.on("activate", () => {
      if (!mainWin || mainWin.isDestroyed()) createWindow();
    });

    // 处理第二个实例启动：用保存的主窗口引用，不会误把更新窗口拉到前台
    app.on("second-instance", () => {
      const win = mainWin;
      if (!win || win.isDestroyed()) return;
      if (win.isMinimized()) win.restore();
      win.show();
      win.focus();
    });
  })
  .catch((err) => {
    // 初始化失败不要在用户面前静默退出：至少落到日志 + 一个可读的提示
    console.error("[startup] 初始化失败:", err);
    try {
      dialog.showErrorBox("启动失败", (err && err.message) || String(err));
    } catch (_) {}
    app.quit();
  });

// 退出前统一清理定时器：演示下载用的是 setInterval，不会自己停
app.on("before-quit", () => {
  if (demoTimer) {
    clearInterval(demoTimer);
    demoTimer = null;
  }
  if (startupCheckTimer) {
    clearTimeout(startupCheckTimer);
    startupCheckTimer = null;
  }
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit(); // 非macOS完全退出
});
