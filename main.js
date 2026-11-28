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
const crypto = require("crypto"); // 更新清单/授权验签（Ed25519）
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

// 带这个标记启动，说明本次是“应用自己重新拉起自己”（沙箱/GPU 降级重启）。
// 这时必须跳过单实例锁：老进程还没释放锁，新进程一取锁就会失败直接退出，
// 用户看到的就是“点了没反应 / 闪退”。
const RELAUNCH_FLAG = "--dickson-relaunch";
const IS_RELAUNCHED = process.argv.indexOf(RELAUNCH_FLAG) !== -1;

let native = null;
try {
  native = require("./protect/protect.node");
} catch (_) {
  // 开发模式（未打包）用的桩：覆盖主进程会用到的全部方法。
  // 以后原生模块新增 API 时，桩里没有就会被调成 undefined is not a function——所以这里打一次警告
  console.warn("[native] 未加载 protect.node，过期判定/完整性自检降级为桩函数（仅开发模式）");
  const coreSeed = `dev-${Date.now()}-${Math.random()}`;
  native = {
    openCore: () => coreSeed,
    isCoreOpen: () => true,
    hostCheck: () => ({ ok: true, reason: "", debugger: false, fuse: "" }),
    checkTamper: () => ({ ok: true, debugger: false, reason: "" }),
    checkExpiry: () => 0, // 开发模式：永不过期
    expireAt: () => 0, // 0 = 没有到期时间，菜单里不显示倒计时
    applyLicense: () => true,
    hasLicense: () => false,
    machineId: () => "dev-machine",
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
    // 只在本应用菜单内生效（不用 globalShortcut，避免拦截系统和其他应用的按键）
    ZOOM_IN: "Ctrl+=",
    ZOOM_OUT: "Ctrl+-",
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

// ------------------------- 通用工具（重启用/日志/外链） -------------------------
// 所有“自己重启自己”的地方统一走这里：带上 RELAUNCH_FLAG，新进程据此跳过单实例锁，
// 避免老进程还没退出、新进程拿不到锁直接退出的“闪退”
function relaunchWith(switches) {
  const extra = Array.isArray(switches) ? switches : [];
  const keep = process.argv
    .slice(1)
    .filter((arg) => extra.indexOf(arg) === -1 && arg !== RELAUNCH_FLAG);
  app.relaunch({ args: keep.concat(extra, [RELAUNCH_FLAG]) });
  app.exit(0);
}

// 崩溃/异常落盘日志：生产包没有 devtools，只写 console 等于没写
function writeCrashLog(kind, text) {
  try {
    const dir = path.join(app.getPath("userData"), "logs");
    fsSync.mkdirSync(dir, { recursive: true });
    fsSync.appendFileSync(
      path.join(dir, "crash.log"),
      "[" + new Date().toISOString() + "] " + kind + " " + text + "\n",
      "utf8"
    );
  } catch (_) {
    // 日志失败不能影响崩溃处理本身
  }
}

// 外链统一入口：只放行 http(s)，其余（file:、javascript:、smb: 等）一律拒绝。
// 主窗口的 will-navigate、window.open、以及前端“组件点击跳转”都收敛到这一处。
function openExternalUrl(rawUrl) {
  const url = String(rawUrl || "").trim();
  if (!/^https?:\/\//i.test(url)) return false;
  try {
    shell.openExternal(url);
    return true;
  } catch (err) {
    console.warn("[external] 打开外链失败:", err && err.message);
    return false;
  }
}


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

app.on("render-process-gone", (_event, webContents, details) => {
  const reason = (details && details.reason) || "";
  const extra = details && details.exitCode != null ? " exitCode=" + details.exitCode : "";
  const url = webContents && !webContents.isDestroyed() ? String(webContents.getURL() || "") : "";

  // 不论是否降级，先把崩溃原因落盘：生产包没有 devtools，只写 console 等于没写
  writeCrashLog("render-process-gone", "reason=" + reason + extra + " url=" + url);

  if (SANDBOX_DISABLED) return; // 已经是关沙箱在跑，再崩就不是沙箱的事了
  if (SANDBOX_CRASH_REASONS.indexOf(reason) === -1) return;
  if (!canFallbackToNoSandbox()) return;

  writeCrashLog("sandbox-fallback", "渲染进程异常退出（" + reason + "），改用 --no-sandbox 重启");
  markNoSandboxFallback();
  relaunchWith(["--no-sandbox"]);
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
        relaunchWith(["--disable-gpu"]);
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
  relaunchWith(["--disable-gpu"]);
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
  // 只按“不含扩展名的主体”截断即可；扩展名本身很短，不需要再截
  const maxBase = Math.max(1, LIMITS.FILE_NAME_MAX_LEN - ext.length);
  return base.slice(0, maxBase) + ext;
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
  // 前端在切预览时会调用它把窗口还原到前台（避免最小化时渲染被节流）。
  // 保存路径不再依赖前端调用：app:save-file 自己会做同样的还原（见下）
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

  // 真实字节数：以前直接拿字符串长度当字节数比较，
  // base64 的 PNG 会被放宽到约 3/4 的图片体积（256MB 字符 ≈ 192MB 图），和注释里的“字节”对不上
  function payloadBytes(type, data) {
    const text = String(data);
    if (type === "png") {
      const base64 = text.replace(/^data:[^;]+;base64,/, "").replace(/[\r\n]/g, "");
      // base64 → 字节是向上取整 3/4，这里按上界估算，只会更严格不会更松
      return Math.ceil((base64.length * 3) / 4);
    }
    return Buffer.byteLength(text, "utf8");
  }

  function normalizeSavePayload(payload) {
    if (!payload || typeof payload !== "object") return { error: "invalid-payload" };
    const type = payload.type === "png" || payload.type === "html" ? payload.type : null;
    if (!type) return { error: "unsupported-type" };
    if (typeof payload.name !== "string" || !payload.name.trim()) return { error: "empty-name" };
    if (typeof payload.data !== "string" || !payload.data) return { error: "empty-data" };

    const limit = type === "png" ? LIMITS.SAVE_IMAGE_MAX_BYTES : LIMITS.SAVE_TEXT_MAX_BYTES;
    if (payloadBytes(type, payload.data) > limit) return { error: "too-large" };

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

  // 「图片 / 文档」目录在某些机器上可能不存在（OneDrive 重定向、精简系统），
  // 写之前先建出来，否则直接 ENOENT
  async function ensureDir(dir) {
    try {
      await fs.mkdir(dir, { recursive: true });
    } catch (err) {
      throw new Error("无法创建保存目录：" + ((err && err.message) || String(err)));
    }
  }

  ipcMain.handle("app:save-file", async (event, payload) => {
    // 只受理主窗口发来的保存请求（更新窗口 / 弹窗窗口的 preload 不暴露这个能力）
    if (!mainWin || mainWin.isDestroyed() || event.sender !== mainWin.webContents) {
      return { ok: false, error: "forbidden" };
    }

    const owner = BrowserWindow.fromWebContents(event.sender) || mainWin;

    // 窗口被最小化 / 不可见时 Chromium 会节流渲染（requestAnimationFrame 降到 1fps），
    // 前端的导出会一直停在「生成中」。以前靠前端先调 app:ensure-visible，
    // 但前端只在切预览时调过，保存路径从来没接上；这里由主进程自己兜底。
    if (owner && !owner.isDestroyed()) {
      try {
        if (owner.isMinimized()) owner.restore();
        if (!owner.isVisible()) owner.show();
        owner.focus();
      } catch (_) {
        // 还原失败不阻断保存
      }
    }

    const normalized = normalizeSavePayload(payload);
    if (normalized.error) return { ok: false, error: normalized.error };

    const { type, name, direct, data } = normalized;
    const baseDir = type === "png" ? app.getPath("pictures") : app.getPath("documents");

    let encoded;
    try {
      encoded = encodeSavePayload(type, data);
    } catch (err) {
      return { ok: false, error: err && err.message ? err.message : String(err) };
    }

    // direct=true：不弹原生对话框，直接落到「图片 / 文档」目录。
    // 当前前端产物固定传 direct=false（即每次都让用户选位置），这条是给
    // “静默保存 / HTML 导出”预留的能力，改动前先确认前端调用方
    if (direct) {
      try {
        await ensureDir(baseDir);
        const directPath = await writeFileExclusive(baseDir, name, encoded);
        return { ok: true, path: directPath };
      } catch (err) {
        return { ok: false, error: err && err.message ? err.message : String(err) };
      }
    }

    // 弹系统「另存为」：无边框窗口下对话框容易被主窗盖住并让主窗进入
    // 不可交互的模态状态，这里临时把主窗置顶并聚焦，保证对话框一定在最前面
    const ownerWin = owner && !owner.isDestroyed() ? owner : null;
    try {
      await ensureDir(baseDir);
    } catch (_) {
      // 目录建不出来时仍然允许用户自己选一个有权限的位置
    }
    let restoreTop = false;
    if (ownerWin) {
      try {
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
      return { ok: true, path: filePath };
    } catch (err) {
      return { ok: false, error: err && err.message ? err.message : String(err) };
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

    // 体检清单一多就会被固定高度挤成一条，按条数长高（有上限）。
    // 注意：调用方传的 height 也必须夹到同一区间，否则能一把撑到屏幕外、按钮点不到
    const checkCount = (pendingDialogState.checks || []).length;
    const wantedHeight =
      Number(options.height) ||
      DIALOG_UI.HEIGHT + Math.max(0, checkCount - 2) * LIMITS.DIALOG_HEIGHT_PER_CHECK;
    const dialogHeight = clamp(Math.round(wantedHeight), DIALOG_UI.HEIGHT, LIMITS.DIALOG_MAX_HEIGHT);

    // attachParent=false：用于“应用即将自毁”这类弹窗。
    // 挂到主窗当子窗时，主窗一旦被 disable/hide，子窗会跟着不可交互甚至不显示，
    // 结果就是过期提示弹不出来，用户只觉得“程序卡住了”
    const parent =
      options.attachParent === false
        ? null
        : mainWin && !mainWin.isDestroyed()
        ? mainWin
        : null;
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
      alwaysOnTop: !parent, // 没有父窗时自己置顶，避免被主窗盖住
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
// 单实例锁。
// 关键点：应用自己带 RELAUNCH_FLAG 重启（沙箱/GPU 降级、自毁后重装）时不能取锁——
// 老进程可能还没退干净，新进程取锁失败会立刻 quit，用户看到的就是“点了没反应”。
const gotTheLock = IS_RELAUNCHED ? true : app.requestSingleInstanceLock();
if (!gotTheLock) {
  app.quit();
  return; // 未拿到锁立即终止，避免继续注册窗口与事件
}

// 应用版本：app.getVersion() 启动时读一次 package.json 并缓存结果，
// 不再每次刷新菜单都重新读盘 + JSON.parse
const APP_VERSION = app.getVersion() || "未知版本";

// 获取网络状态
// 只取第一块 IPv4 非回环网卡是不够的：装了 WSL / VMware / VirtualBox / Tailscale / 各类 VPN 后，
// 虚拟网卡往往排序在前，菜单就会显示“已连接 172.x.x.x”这种实际上不了网的地址
const VIRTUAL_IFACE_PATTERNS = [
  /vEthernet/i,
  /^veth/i,
  /^docker/i,
  /^br-/i,
  /vmware/i,
  /virtualbox/i,
  /^vboxnet/i,
  /hyper-v/i,
  /tailscale/i,
  /^wg\d+/i,
  /wireguard/i,
  /openvpn/i,
  /tap-|tun-|^tap|^tun/i,
  /zerotier/i,
  /^utun/i,
  /npcap/i,
  /loopback/i,
];

function isVirtualIface(name) {
  const n = String(name || "");
  return VIRTUAL_IFACE_PATTERNS.some((re) => re.test(n));
}

// 172.16/12、169.254/16、100.64/10（运营商 NAT / Tailscale 常用）都按“不是真正的上网地址”处理
function isLinkLocalOrPrivate172(ip) {
  const parts = String(ip || "").split(".");
  if (parts.length !== 4) return false;
  const a = Number(parts[0]);
  const b = Number(parts[1]);
  if (a === 169 && b === 254) return true; // APIPA：网线没插好/没拿到 DHCP
  if (a === 100 && b >= 64 && b <= 127) return true; // CG-NAT / Tailscale
  return false;
}

function getNetworkStatus() {
  let interfaces = {};
  try {
    interfaces = os.networkInterfaces() || {};
  } catch (err) {
    return { status: "未知", ip: "无" };
  }

  const candidates = [];
  for (const name of Object.keys(interfaces)) {
    const list = interfaces[name];
    // Node 文档明确说某个网卡可能是 undefined，直接 for...of 会抛 TypeError
    if (!Array.isArray(list)) continue;
    for (const iface of list) {
      if (!iface) continue;
      if (iface.family !== "IPv4" || iface.internal) continue;
      if (isLinkLocalOrPrivate172(iface.address)) continue;
      candidates.push({ name, ip: iface.address, virt: isVirtualIface(name) });
    }
  }

  // 先给真实网卡，其次才轮到虚拟网卡；同类里按「192.168 → 10 → 其他」排，
  // 因为家里的路由器基本落在这两个段，172.16/12 多半是企业网/VPN 段。
  // 一块都没有就直接报“未连接”，不再拿虚拟网卡糊弄用户
  function score(c) {
    const ip = c.ip;
    if (/^192\.168\./.test(ip)) return 0;
    if (/^10\./.test(ip)) return 1;
    return 2;
  }
  const real = candidates.filter((c) => !c.virt).sort((x, y) => score(x) - score(y));
  const pick = real[0] || candidates[0];
  if (!pick) return { status: "未连接", ip: "无" };
  return { status: "已连接", ip: pick.ip };
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
    // 不原地拦掉了：http(s) 交给系统浏览器。
    // 前端「组件点击跳转」用的是 window.location.href，这里只 preventDefault 的话，
    // 用户点了链接就是“毫无反应”。非 http(s)（javascript:、file: 越界等）在 openExternalUrl 里被丢弃
    openExternalUrl(raw);
  });
  win.webContents.setWindowOpenHandler(({ url }) => {
    openExternalUrl(url);
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
    // 剩余时间要分桶，不能直接进 signature：
    // 按分钟数原样比较的话，签名每分钟都变 → 菜单每分钟重建一次，
    // 正好在用户操作菜单时被抽走。剩 10 分钟以内每分钟刷新（要提醒），否则 10 分钟粒度
    const minutesBucket =
      minutesLeft == null
        ? "none"
        : minutesLeft <= 10
        ? String(minutesLeft)
        : String(Math.floor(minutesLeft / 10));
    const signature = `${networkInfo.status}|${networkInfo.ip}|${minutesBucket}|${APP_VERSION}|${renderMode.label}`;
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
        // 缩放快捷键只在本应用内生效（用菜单 accelerator，不用 globalShortcut）
        label: "视图",
        submenu: [
          {
            label: "放大",
            accelerator: CONSTANTS.SHORTCUTS.ZOOM_IN,
            click: () => handleZoom(0.1),
          },
          {
            label: "缩小",
            accelerator: CONSTANTS.SHORTCUTS.ZOOM_OUT,
            click: () => handleZoom(-0.1),
          },
          {
            label: "实际大小",
            accelerator: CONSTANTS.SHORTCUTS.ZOOM_RESET,
            click: () => {
              if (!win.isDestroyed()) win.webContents.setZoomFactor(1);
            },
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
    if (minutesLeft != null) template.push({ label: ` ${minutesLeft} `, enabled: false });

    // 渲染模式：放在“检查更新”前面，只显示 GPU / CPU，方便随时确认当前模式
    template.push({ label: `${renderMode.label}`, enabled: false });

    template.push({
      label: "检查更新",
      click: () => openUpdateCenter(),
    });

    Menu.setApplicationMenu(Menu.buildFromTemplate(template));
  }

  // 初始化及定时刷新：分钟数变化的分桶见 updateMenu，30 秒检查一次足够
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

// ------------------------- 更新清单验签（latest.yml + latest.yml.sig） -------------------------
// 为什么需要：electron-updater 只校验它自己下载的 sha512，而那份 sha512 来自 latest.yml；
// latest.yml 本身没有任何保护，谁能在源上换掉它，就能让客户端装任意安装包。
// 这里用 Ed25519 给 latest.yml 签名，客户端只认“签名对得上、哈希对得上”的包。
const UPDATE_SIGN_CONFIG_PATH = path.join(__dirname, "protect", "verify-pub.json");
let updateSignPubKey = null;
try {
  const cfg = JSON.parse(fsSync.readFileSync(UPDATE_SIGN_CONFIG_PATH, "utf8"));
  const raw = Buffer.from(String((cfg && cfg.update) || ""), "base64");
  if (raw.length === 32) {
    updateSignPubKey = crypto.createPublicKey({
      key: { kty: "OKP", crv: "Ed25519", x: raw.toString("base64url") },
      format: "jwk",
    });
  }
} catch (_) {
  updateSignPubKey = null;
}

const SIGNED_MANIFEST_TIMEOUT = 15 * 1000;
const signedManifestCache = new Map(); // sourceKey -> { version, files: [{name, sha512}], path, sha512, at }

function signedManifestUrls(source) {
  if (!source) return null;
  if (source.provider === "generic" && source.url) {
    const base = String(source.url).replace(/\/+$/, "") + "/";
    return { yml: base + "latest.yml", sig: base + "latest.yml.sig" };
  }
  if (source.provider === "github" && source.owner && source.repo) {
    const base =
      "https://github.com/" + source.owner + "/" + source.repo + "/releases/latest/download/";
    return { yml: base + "latest.yml", sig: base + "latest.yml.sig" };
  }
  return null;
}

async function fetchText(url, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs || SIGNED_MANIFEST_TIMEOUT);
  try {
    const res = await fetch(url, { signal: controller.signal, redirect: "follow" });
    if (!res.ok) throw new Error("HTTP " + res.status);
    return await res.text();
  } finally {
    clearTimeout(timer);
  }
}

// latest.yml 结构由 electron-builder 生成，字段固定，用行级解析足够稳；
// 解析失败一律当“清单无效”，不做任何宽松兜底。
function parseLatestYml(text) {
  const out = { version: "", path: "", sha512: "", files: [] };
  if (typeof text !== "string" || !text) return out;
  // BOM 会让 ^version 之类的行首匹配全部落空（Windows 下手写/另存的文件常见）
  text = text.replace(/^\uFEFF/, "");

  const v = text.match(/^version:\s*['"]?([^'"\r\n]+)/m);
  if (v) out.version = v[1].trim();

  const p = text.match(/^path:\s*['"]?([^'"\r\n]+)/m);
  if (p) out.path = p[1].trim();

  const filesBlock = text.split(/^files\s*:\s*$/m)[1];
  if (filesBlock) {
    // 只取到下一个顶层键（顶格、非空白开头）为止
    const section = filesBlock.split(/\n(?=[^\s-])/)[0];
    const re = /url:\s*['"]?([^'"\r\n]+)[\r\n]+[\s\S]*?sha512:\s*['"]?([A-Za-z0-9+/=]+)/g;
    let m = null;
    while ((m = re.exec(section)) !== null) {
      out.files.push({ name: m[1].trim(), sha512: m[2].trim() });
    }
  }

  // 顶层 sha512（对应 path 指向的安装包）
  const top = text.match(/\nsha512:\s*['"]?([A-Za-z0-9+/=]{40,})/);
  if (top) out.sha512 = top[1].trim();

  return out;
}

async function fetchSignedManifest(source) {
  if (!updateSignPubKey) return null;
  const key = sourceKey(source);
  const urls = signedManifestUrls(source);
  if (!key || !urls) return null;

  const [ymlRes, sigRes] = await Promise.allSettled([
    fetchText(urls.yml),
    fetchText(urls.sig),
  ]);
  if (ymlRes.status !== "fulfilled" || sigRes.status !== "fulfilled") {
    writeCrashLog("update-sign", key + " 清单或签名下载失败");
    return null;
  }

  const ymlText = ymlRes.value;
  let sigBuf = null;
  try {
    sigBuf = Buffer.from(sigRes.value.trim(), "base64");
  } catch (_) {
    sigBuf = null;
  }
  if (!sigBuf || sigBuf.length !== 64) {
    writeCrashLog("update-sign", key + " 签名格式不合法");
    return null;
  }

  let ok = false;
  try {
    ok = crypto.verify(null, Buffer.from(ymlText, "utf8"), updateSignPubKey, sigBuf);
  } catch (_) {
    ok = false;
  }
  if (!ok) {
    writeCrashLog("update-sign", key + " latest.yml 签名校验失败（可能被替换）");
    return null;
  }

  const parsed = parseLatestYml(ymlText);
  if (!parsed.version || (!parsed.sha512 && parsed.files.length === 0)) {
    writeCrashLog("update-sign", key + " 清单内容不完整");
    return null;
  }

  const entry = {
    version: parsed.version,
    files: parsed.files,
    path: parsed.path,
    sha512: parsed.sha512,
    at: Date.now(),
  };
  signedManifestCache.set(key, entry);
  return entry;
}

function fileSha512Base64(file) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash("sha512");
    const stream = fsSync.createReadStream(file);
    stream.on("error", reject);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("end", () => resolve(hash.digest("base64")));
  });
}

// 校验已下载的安装包：
//   1) 该源必须有验签通过的清单（没有 = 失败，不允许安装）
//   2) 清单版本要和本次下载的版本一致
//   3) 本地文件的 sha512 必须等于清单里登记的值
async function verifyDownloadedInstaller(info) {
  if (!updateSignPubKey) {
    return { ok: true, skipped: true };
  }

  const source = activeSource;
  const key = sourceKey(source);
  if (!key) return { ok: false, reason: "无法确定更新源" };

  let manifest = signedManifestCache.get(key) || null;
  if (!manifest) {
    try {
      manifest = await fetchSignedManifest(source);
    } catch (_) {
      manifest = null;
    }
  }
  if (!manifest) return { ok: false, reason: "没有可验证的更新清单（latest.yml.sig）" };

  const version = String((info && info.version) || (pendingUpdate && pendingUpdate.version) || "");
  if (version && manifest.version && version !== manifest.version) {
    return { ok: false, reason: "清单版本不一致（" + manifest.version + " ≠ " + version + "）" };
  }

  const file = info && info.path ? String(info.path) : "";
  if (!file) return { ok: false, reason: "下载结果里没有文件路径" };

  let actual = "";
  try {
    actual = await fileSha512Base64(file);
  } catch (err) {
    return { ok: false, reason: "读取安装包失败: " + ((err && err.message) || String(err)) };
  }

  const baseName = path.basename(file);
  let expected = "";
  for (const f of manifest.files) {
    if (f && f.name === baseName) {
      expected = f.sha512;
      break;
    }
  }
  if (!expected && manifest.path === baseName) expected = manifest.sha512;
  if (!expected && manifest.files.length === 1) expected = manifest.files[0].sha512;
  if (!expected) return { ok: false, reason: "清单里没有登记这个安装包: " + baseName };

  if (expected !== actual) {
    return { ok: false, reason: "安装包哈希与签名清单不符" };
  }
  return { ok: true };
}

// ------------------------- updater 实例池（并发的基础） -------------------------
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
// 下载看门狗：源被墙 / 卡在 0% 时 downloadUpdate 既不 resolve 也不 reject，
// 界面会永远停在“下载中”，用户只能强退。这里按“多久没有任何字节增长”判死
const DOWNLOAD_STALL_MS = 60 * 1000;
let lastDownloadActivityAt = 0;
let downloadWatchdog = null;
let downloadAttempt = 0; // 每次下载一个自增号，用于让看门狗与 Promise 的失败只结算一次
let handledFailureAttempt = -1;

function stopDownloadWatchdog() {
  if (downloadWatchdog) {
    clearInterval(downloadWatchdog);
    downloadWatchdog = null;
  }
}

function startDownloadWatchdog(updater) {
  stopDownloadWatchdog();
  downloadWatchdog = setInterval(() => {
    if (!downloadInFlight) {
      stopDownloadWatchdog();
      return;
    }
    if (!lastDownloadActivityAt) return; // 还没开始，交给下面的宽限判断
    const idle = Date.now() - lastDownloadActivityAt;
    if (idle < DOWNLOAD_STALL_MS) return;
    stopDownloadWatchdog();
    writeCrashLog("download-stall", "超过 " + Math.round(idle / 1000) + " 秒没有任何下载进度");
    failDownloadAttempt(
      downloadAttempt,
      new Error("下载超过 " + Math.round(DOWNLOAD_STALL_MS / 1000) + " 秒没有任何进度，已自动中止"),
      updater
    );
  }, 5 * 1000);
  if (downloadWatchdog && typeof downloadWatchdog.unref === "function") downloadWatchdog.unref();
}

// 一次下载的失败只结算一次：
// 看门狗和 downloadUpdate 的 Promise catch 会同时/先后触发，重复处理会连着换源两遍
function failDownloadAttempt(attempt, err, updater) {
  if (attempt !== downloadAttempt) return; // 已经换源/开始新一轮，旧结果作废
  if (handledFailureAttempt === attempt) return;
  handledFailureAttempt = attempt;
  stopDownloadWatchdog();
  handleDownloadFailure(err, updater);
}

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

// ------------------------- updater 事件绑定 -------------------------
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
      // 跳过之后旧包必须一起清掉，否则“跳过”只是视觉上的
      await clearPendingArtifacts("skip " + version);
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
  // 实例池里每个 updater 在创建时 setFeedURL 过一次，但探测阶段的兜底分支会反复
  // setFeedURL(共享实例)，换源时也可能换到别的源。这里在真正下载前再钉一次，
  // 保证“下的是当前源、装的是同一个源”，否则会去错误域名下取包
  if (activeSource) {
    try {
      usedUpdater.setFeedURL(activeSource);
    } catch (err) {
      writeCrashLog("download", "setFeedURL 失败: " + ((err && err.message) || String(err)));
    }
  }

  const key = sourceKey(activeSource);
  if (key && triedSources.indexOf(key) === -1) triedSources.push(key);

  downloadAttempt += 1;
  handledFailureAttempt = -1;
  downloadInFlight = true;
  cancelRequested = false;
  lastDownloadError = "";
  lastDownloadActivityAt = Date.now();
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

  const attempt = downloadAttempt;
  startDownloadWatchdog(usedUpdater);

  usedUpdater
    .downloadUpdate(downloadToken || undefined)
    .then(() => {
      // 完成状态由 update-downloaded 事件接管
      downloadInFlight = false;
      stopDownloadWatchdog();
    })
    .catch((err) => {
      failDownloadAttempt(attempt, err, usedUpdater);
    });
}

function handleDownloadFailure(err, usedUpdater) {
  stopDownloadWatchdog();
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

// 让“已下载的包”作废：跳过版本、或查到更新版本时都必须调用。
// 以前只把 readyUpdate 置空，安装包还留在 userData/pending 里，
// 下次同一个版本被重新发现时会不会命中旧包全看 electron-updater 内部行为，行为不可控；
// 这里连缓存一起 best-effort 删掉，保证“跳过/换版本”之后真的从头来
async function clearPendingArtifacts(reason) {
  readyUpdate = null;
  pendingUpdate = null;
  if (downloadInFlight) {
    // 正在下载时不动文件：先让取消流程收尾，缓存留到下一轮再清
    writeCrashLog("update", "清理待装包时仍有下载在跑，跳过磁盘清理: " + reason);
    return;
  }
  try {
    await fs.rm(path.join(app.getPath("userData"), "pending"), { recursive: true, force: true });
  } catch (err) {
    writeCrashLog("update", "清理 pending 缓存失败: " + ((err && err.message) || String(err)));
  }
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
      // 确实有更高版本：旧的已下载包作废（连磁盘缓存一起清），走正常的“发现新版”流程
      await clearPendingArtifacts("发现更高版本 " + best.info.version);
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

  // 看门狗的活性时间戳必须在节流之前更新：
  // 放在节流后面的话，进度密集时它会一直等于上一个“推送”时刻，判断不出真实停滞
  lastDownloadActivityAt = Date.now();

  // 进度事件很密集，节流到 12 帧/秒左右，避免渲染进程被刷爆
  const now = lastDownloadActivityAt;
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

async function onUpdateDownloaded(info) {
  stopDownloadWatchdog();
  downloadInFlight = false;
  // 用户点了取消之后，底层可能仍然把最后一段下完并抛 update-downloaded：
  // 这时不能翻成“已就绪”，否则界面刚说“已取消”立刻又变成“可安装”，让人以为取消无效
  if (cancelRequested) {
    cancelRequested = false;
    setAppProgressBar(null);
    resetToAvailable();
    return;
  }

  // 先验后给“就绪”：签名清单 / 版本 / 哈希三重对上才算下载成功。
  // 验不过就删包 + 走失败流程（可能换源重下），绝不让未经校验的安装包留在磁盘上，
  // 更不能走到“重启安装”——那一步会把恶意包直接装进系统。
  let verdict = { ok: true, skipped: true };
  try {
    verdict = await verifyDownloadedInstaller(info);
  } catch (err) {
    verdict = { ok: false, reason: (err && err.message) || String(err) };
  }

  if (!verdict || !verdict.ok) {
    const reason = (verdict && verdict.reason) || "校验未通过";
    writeCrashLog("update-verify", "安装包拒绝安装：" + reason);
    const file = info && info.path ? String(info.path) : "";
    if (file) {
      try {
        await fs.unlink(file);
      } catch (_) {
        // 删不掉也要继续走失败流程，不能因为一个残留文件卡在这里
      }
    }
    lastDownloadError = "更新包校验失败：" + reason;
    handleDownloadFailure(new Error(lastDownloadError), activeUpdater);
    return;
  }

  handleDownloadedVerified(info);
}

function handleDownloadedVerified(info) {
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

  // 最硬的一道：目标目录必须真的是“当前 exe 所在目录”，且这个 exe 现在还存在。
  // 只要 exe 路径没落在该目录里（比如以后改成直接删某个缓存目录），就一律拒绝——
  // 这比单纯判断“目录层数 ≥ 2”靠谱得多
  try {
    const exePath = app.getPath("exe");
    const exeDir = path.resolve(path.dirname(exePath));
    if (exeDir.toLowerCase() !== resolved.toLowerCase()) return false;
    if (!fsSync.existsSync(exePath)) return false;
  } catch (_) {
    return false;
  }

  // 至少有 2 层目录（例如 D:\app\dickson），单层目录风险太高
  const parts = resolved.split(path.sep).filter(Boolean);
  return parts.length >= 2;
}

// 批处理里只有 % 会被当变量展开；路径本身不会带 " （Windows 文件名不允许）
function batchQuote(value) {
  return '"' + String(value).replace(/%/g, "%%") + '"';
}

// userData 目录的删除范围要比安装目录更严：只允许“AppData\Roaming 下、目录名就是本应用名”的那个
function isSafeRemovalTargetForUserData(target) {
  try {
    const resolved = path.resolve(target);
    if (!fsSync.existsSync(resolved)) return false;
    const roaming = path.resolve(app.getPath("appData")); // Windows: %APPDATA%
    if (resolved.indexOf(roaming + path.sep) !== 0) return false;
    const base = path.basename(resolved).toLowerCase();
    const allowed = ["dickson-color-studio", String(app.getName() || "").toLowerCase()].filter(Boolean);
    return allowed.indexOf(base) !== -1;
  } catch (_) {
    return false;
  }
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
    // userData（设置、日志、更新缓存）平时不会被 rmdir 安装目录带走，单独清一遍
    let quotedUserData = "";
    try {
      const userData = app.getPath("userData");
      if (userData && isSafeRemovalTargetForUserData(userData)) {
        quotedUserData = isWindows ? batchQuote(userData) : '"' + userData + '"';
      }
    } catch (_) {
      // 拿不到就只清安装目录
    }

    // Windows：先跑安装目录里的 NSIS 卸载器（它能一并清注册表/开始菜单项），
    // 再兜底 rmdir 循环。以前只做 rmdir：注册表里的卸载项、快捷方式、
    // 以及“程序与功能”里的条目都会残留，机器上看起来还装着这个软件。
    // 注意 batch 里的括号块在解析时就会展开 %RETRY%，所以循环必须用 goto 写法
    const scriptContent = isWindows
      ? [
          "@echo off",
          "setlocal",
          "set RETRY=0",
          "timeout /t 3 /nobreak >nul",
          `for %%F in ("${path.join(appPath, "Uninstall*.exe")}") do (`,
          '  if exist "%%~fF" start "" /wait "%%~fF" /S',
          ")",
          ":retry",
          "timeout /t 2 /nobreak >nul",
          `rmdir /s /q ${quotedAppPath} 2>nul`,
          `if not exist ${quotedAppPath} goto dirgone`,
          "set /a RETRY+=1",
          "if %RETRY% LSS 8 goto retry",
          ":dirgone",
          quotedUserData ? `rmdir /s /q ${quotedUserData} 2>nul` : "rem no userData",
          'del "%~f0" >nul 2>nul',
        ].join("\r\n")
      : [
          "#!/bin/bash",
          "for i in $(seq 1 8); do",
          `  rm -rf ${quotedAppPath}`,
          `  [ ! -d ${quotedAppPath} ] && break`,
          "  sleep 1",
          "done",
          quotedUserData ? `rm -rf ${quotedUserData}` : "true",
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
    writeCrashLog("self-destruct", (error && error.message) || String(error));
    try {
      await showCustomDialog({
        kind: "error",
        title: "自毁失败",
        message: "删除应用程序时发生错误，请手动删除。",
        detail: error && error.message ? String(error.message) : "",
        // 主窗此时已被 disable + hide，挂上去就弹不出来
        attachParent: false,
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
  // 到期后主窗口必须立刻不能用：弹窗是非模态的，只靠用户点“确定”等于形同虚设。
  // 这里同时隐藏主窗——只 setEnabled(false) 的话，无边框窗口会剩一张灰色尸体窗口，
  // 而父窗被 disable 后又会让子弹窗一起不可交互（弹窗就不挂 parent 了，见下）
  try {
    if (mainWin && !mainWin.isDestroyed()) {
      mainWin.setEnabled(false);
      mainWin.hide();
    }
  } catch (_) {}

  // 用户一直不理弹窗也不能一直跑：超时后强制清理
  const forceTimer = setTimeout(() => {
    Promise.resolve()
      .then(() => selfDestruct())
      .catch(() => {})
      .then(() => app.quit());
  }, TIMING.DIALOG_FORCE_EXIT_MS);
  if (forceTimer && typeof forceTimer.unref === "function") forceTimer.unref();

  // 自毁是异步的（删目录可能要等几秒），必须等它跑完再 quit，
  // 否则 app.quit() 先把进程带走，安装目录还留在磁盘上——所谓“自毁”就成了空话。
  // finishing 守卫：forceTimer 和用户点按钮可能撞在一起
  let finishing = false;
  const finish = () => {
    if (finishing) return;
    finishing = true;
    clearTimeout(forceTimer);
    Promise.resolve()
      .then(() => selfDestruct())
      .catch(() => {})
      .then(() => app.quit());
  };

  showCustomDialog({
    kind: "error",
    title: "应用过期",
    message: "程序已超过有效期，即将自毁！",
    detail: "剩余时间：0分钟",
    buttons: [{ label: "确定", kind: "primary" }],
    // 关键：不能挂到主窗当子窗（主窗已 disable + hide），否则弹窗自己不显示
    attachParent: false,
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

// ------------------------- 运行期自检（原生会话 / DevTools / 逆向检测） -------------------------
// bootstrap 已经做过一次宿主与 fuse 校验，但那是“启动那一刻”。运行中 exe 被替换、
// 或者有人用浏览器协议连上调试端口，都得能发现。
const TAMPER_CHECK_INTERVAL = 60 * 1000;
const TAMPER_STRIKES = 2; // 连续命中两次才动手：避免杀软/输入法注入造成误杀
let tamperStrikes = 0;
let tamperTimer = null;
let tamperHandled = false;

// 原生会话在这次改版里是“一次性”的：openCore 成功后才能调敏感导出。
// 主进程若拿不到会话，说明 native 被换成了桩或被提前加载过，直接按篡改处理。
function ensureNativeCore() {
  try {
    if (typeof native.isCoreOpen === "function" && native.isCoreOpen()) {
      return true;
    }
  } catch (_) {}
  writeCrashLog("native-session", "原生会话未建立");
  return false;
}

function closeStrayDevTools() {
  try {
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win || win.isDestroyed() || !win.webContents) continue;
      if (win.webContents.isDevToolsOpened()) win.webContents.closeDevTools();
    }
  } catch (_) {}
}

function checkRuntimeTamper() {
  if (tamperHandled) return false;

  let hit = false;
  let reason = "";
  try {
    const res = native.checkTamper();
    if (res && res.ok === false) {
      hit = true;
      reason = String((res && res.reason) || "tamper");
    }
  } catch (err) {
    // 原生模块抛错（被替换/被杀软摘除）本身就是异常状态
    hit = true;
    reason = "native-error:" + ((err && err.message) || "unknown");
  }

  // DevTools 的出现也是“有人在看内部”的强信号，单独统计，不并进 native 判定
  try {
    for (const win of BrowserWindow.getAllWindows()) {
      if (win && !win.isDestroyed() && win.webContents && win.webContents.isDevToolsOpened()) {
        hit = true;
        reason = reason || "devtools";
        win.webContents.closeDevTools();
      }
    }
  } catch (_) {}

  if (!hit) {
    tamperStrikes = 0;
    return false;
  }

  tamperStrikes += 1;
  writeCrashLog("tamper", "第 " + tamperStrikes + " 次命中: " + reason);
  if (tamperStrikes < TAMPER_STRIKES) return false;

  tamperHandled = true;
  Promise.resolve()
    .then(() => selfDestruct())
    .catch(() => {})
    .then(() => app.quit());
  return true;
}

function startTamperWatch() {
  if (tamperTimer) return;
  tamperTimer = setInterval(() => {
    checkRuntimeTamper();
    closeStrayDevTools();
  }, TAMPER_CHECK_INTERVAL);
  if (typeof tamperTimer.unref === "function") tamperTimer.unref();
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
    // 让 Windows 任务栏/开始菜单把窗口和本应用归成一组（通知、跳转列表、任务栏进度都依赖它）。
    // 必须和 package.json 的 build.appId 保持一致；改 appId 会让 NSIS 卸载注册键变化、
    // 新老版本被系统当成两份软件共存，所以这两处都不能随手改
    if (process.platform === "win32") {
      try {
        app.setAppUserModelId("com.example.dickson");
      } catch (err) {
        writeCrashLog("app-user-model-id", (err && err.message) || String(err));
      }
    }
    hardenSession(); // 先收紧会话权限，再创建任何窗口
    // 原生会话必须在这里仍然有效：bootstrap 拿到会话后，任何人抢在前面把 native 换掉，
    // isCoreOpen() 就会变 false。这一步失败说明运行环境不可信，直接退出（不做自毁，
    // 避免把“杀软拦截 native”的误判升级成删文件）
    if (!ensureNativeCore()) {
      try {
        dialog.showErrorBox("无法启动", "运行环境校验失败，请重新安装。");
      } catch (_) {}
      app.quit();
      return;
    }
    if (checkExpiration()) return;
    bindSaveIpc(); // 保存图片 / 保存 HTML 的原生另存为通道
    bindDownloadGuard(); // 下载兜底：不再弹 Windows「另存为」
    startExpiryWatch(); // 运行中也要定期复查到期时间
    startTamperWatch(); // 运行中复核调试器/DevTools/native 会话
    initAutoUpdater();
    createWindow();
    closeStrayDevTools();
    scheduleStartupCheck(); // 启动后后台静默检查一次，有新版才弹窗

    app.on("activate", () => {
      if (expiryHandled) return; // 已过期：不再重开窗口
      if (!mainWin || mainWin.isDestroyed()) createWindow();
    });

    // 处理第二个实例启动：用保存的主窗口引用，不会误把更新窗口拉到前台
    app.on("second-instance", () => {
      // 过期流程里主窗已 disable + hide，再 show 出来就是一张点不动的窗口，看着像卡死
      if (expiryHandled) return;
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
  if (tamperTimer) {
    clearInterval(tamperTimer);
    tamperTimer = null;
  }
  stopDownloadWatchdog();
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit(); // 非macOS完全退出
});
