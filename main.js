const {
  app,
  BrowserWindow,
  Menu,
  dialog,
  ipcMain,
} = require("electron");
const { autoUpdater } = require("electron-updater");
const path = require("path");
const os = require("os");
const fs = require("fs/promises"); // 使用Promise版本的fs
// 原生保护模块：过期判定、文件完整性自检（C++ 编译，无明文逻辑）
// 本地开发（无编译产物）时降级为桩函数，保证 npm start 可直接跑；生产环境加载真实模块
// 部分受限环境（沙箱代理被策略禁用）渲染进程会直接崩溃，关闭沙箱保证可运行
app.commandLine.appendSwitch("no-sandbox");
app.disableHardwareAcceleration(); // 部分机器 GPU 初始化导致渲染进程崩溃，关闭硬加速
let native = null;
try {
  native = require("./protect/protect.node");
} catch (_) {
  native = { checkExpiry: () => 0, verifyFile: () => true };
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

// ------------------------- 工具函数 -------------------------
function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

// 授权剩余分钟数（纯数字，菜单里直接显示）
// 过期时刻与 protect/protect.cc 里的 EXPIRE_MS 必须一致：1798761599000 = 2026-12-31 23:59:59
const LICENSE_EXPIRE_MS = 1798761599000;
function licenseMinutesLeft() {
  const left = LICENSE_EXPIRE_MS - Date.now();
  return left <= 0 ? 0 : Math.ceil(left / 60000);
}

// ------------------------- 核心功能 -------------------------
// 单实例锁
const gotTheLock = app.requestSingleInstanceLock();
if (!gotTheLock) {
  app.quit();
  return; // 未拿到锁立即终止，避免继续注册窗口与事件
}

// 获取应用版本（Promise化）
async function getAppVersion() {
  try {
    const data = await fs.readFile(
      path.join(__dirname, "package.json"),
      "utf8"
    );
    const packageJson = JSON.parse(data);
    return packageJson.version;
  } catch (err) {
    console.error("读取版本失败:", err);
    return "未知版本";
  }
}

// 获取网络状态
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
  return { status: "未连接", ip: "无" };
}

// ------------------------- 窗口管理 -------------------------
function createWindow() {
  const win = new BrowserWindow({
    width: 800,
    height: 600,
    icon: CONSTANTS.APP_ICON,
    webPreferences: {
      preload: CONSTANTS.PRELOAD_SCRIPT,
      contextIsolation: true, // 渲染进程与 preload 隔离，防止页面直接触碰 Node
      nodeIntegration: false, // 禁止页面使用 Node API
      sandbox: true, // 启用渲染进程沙箱
      devTools: false, // 不提供开发者工具（避免通过 devtools 看到更新源等内部地址）
    },
  });

  win.loadFile(CONSTANTS.INDEX_HTML);

  // 快捷键统一由下方应用菜单的 accelerator 提供（仅在本应用内生效），
  // 不再使用 globalShortcut，避免拦截系统及其他应用的全局按键。

  // 开发者工具已关闭，这里再屏蔽一次唤出快捷键（F12 / Ctrl+Shift+I·J·C）
  win.webContents.on("before-input-event", (event, input) => {
    const key = String(input.key || "").toLowerCase();
    if (key === "f12" || (input.control && input.shift && (key === "i" || key === "j" || key === "c"))) {
      event.preventDefault();
    }
  });

  // 优化后的缩放逻辑（带限制）
  function handleZoom(delta = 0.1) {
    const current = win.webContents.getZoomFactor();
    win.webContents.setZoomFactor(
      clamp(
        current + delta,
        CONSTANTS.ZOOM_LIMITS.MIN,
        CONSTANTS.ZOOM_LIMITS.MAX
      )
    );
  }

  // 菜单更新（Promise化）
  async function updateMenu() {
    const [networkInfo, appVersion] = await Promise.all([
      Promise.resolve(getNetworkStatus()),
      getAppVersion(),
    ]);

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
        label: "查看",
        submenu: [
          {
            label: "刷新",
            accelerator: CONSTANTS.SHORTCUTS.REFRESH,
            click: () => win.reload(),
          },
          {
            label: "放大",
            accelerator: "Ctrl+=",
            click: () => handleZoom(0.1),
          },
          {
            label: "缩小",
            accelerator: "Ctrl+-",
            click: () => handleZoom(-0.1),
          },
          {
            label: "重置缩放",
            accelerator: CONSTANTS.SHORTCUTS.ZOOM_RESET,
            click: () => win.webContents.setZoomFactor(1),
          },
        ],
      },
      {
        label: `网络状态: ${networkInfo.status}，本机 IP: ${networkInfo.ip}`,
        enabled: false,
      },
      { label: `Version: ${appVersion}`, enabled: false },
      { label: String(licenseMinutesLeft()), enabled: false },
      {
        label: "检查更新",
        click: () => openUpdateCenter(),
      },
    ];

    Menu.setApplicationMenu(Menu.buildFromTemplate(template));
  }

  // 初始化及定时更新（倒计时需周期性刷新）
  updateMenu();
  setInterval(updateMenu, 5000);

  // 鼠标滚轮缩放（带Ctrl键检测）
  win.webContents.on("mouse-wheel", (event, _, deltaY) => {
    if (event.ctrlKey) {
      event.preventDefault();
      handleZoom(deltaY > 0 ? 0.1 : -0.1);
    }
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

const STARTUP_CHECK_DELAY = 20 * 1000; // 启动后后台静默检查（只有发现更新才弹窗）
const PROBE_TIMEOUT = 15 * 1000; // 单源探测超时：慢源不能拖住整体结果
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

  const mainWindow = BrowserWindow.getAllWindows().find((w) => w !== updateWin) || null;
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
      sandbox: true,
      devTools: false,
    },
  });

  updateWin.removeMenu();
  updateWin.loadFile(UPDATE_UI.HTML);

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
  const mainWindow = BrowserWindow.getAllWindows().find((w) => w !== updateWin);
  if (!mainWindow || mainWindow.isDestroyed()) return;
  try {
    mainWindow.setProgressBar(value == null ? -1 : value);
  } catch (_) {
    // 部分系统不支持任务栏进度，忽略
  }
}

// ------------------------- 版本与更新信息工具 -------------------------
// a>b 返回 1，a<b 返回 -1，相等返回 0（支持 1.0.4 / 1.0.5 这类版本）
function compareVersions(a, b) {
  const pa = String(a).split(".").map((n) => parseInt(n, 10) || 0);
  const pb = String(b).split(".").map((n) => parseInt(n, 10) || 0);
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const na = pa[i] || 0;
    const nb = pb[i] || 0;
    if (na > nb) return 1;
    if (na < nb) return -1;
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
    return withTimeout(updater.checkForUpdates(), PROBE_TIMEOUT, label)
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
      runUpdateCheck();
      break;

    case "restart-install":
      setAppProgressBar(null);
      closeUpdateWindow();
      if (pendingUpdate && pendingUpdate.demo) break; // 演示模式不真装
      // 必须用“真正完成下载”的那个实例，否则找不到安装包
      setTimeout(() => {
        const updater = activeUpdater || autoUpdater;
        updater.quitAndInstall();
      }, 60);
      break;

    case "open-release":
      // 已移除：任何能打开发布页/下载页的入口都会暴露下载地址，这里改为无操作
      break;

    default:
      break;
  }
}

function bindUpdateIpc() {
  if (updateIpcBound) return;
  updateIpcBound = true;
  ipcMain.on("update:ready", () => pushState());
  ipcMain.on("update:action", (_event, action) => {
    handleUpdateAction(String(action || ""));
  });
}

// ------------------------- 下载 -------------------------
function startDownload(options) {
  const opts = options || {};
  if (!pendingUpdate || downloadInFlight) return;

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
    patchState({
      phase: "available",
      percent: 0,
      transferred: 0,
      total: 0,
      notice: "已取消下载，可稍后重新下载。",
    });
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

function cancelDownload() {
  // 演示模式的“下载”由定时器模拟，直接停表
  if (pendingUpdate && pendingUpdate.demo) {
    if (demoTimer) {
      clearInterval(demoTimer);
      demoTimer = null;
    }
    setAppProgressBar(null);
    patchState({
      phase: "available",
      percent: 0,
      transferred: 0,
      total: 0,
      notice: "已取消下载，可稍后重新下载。",
    });
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
  patchState({
    phase: "available",
    percent: 0,
    transferred: 0,
    total: 0,
    notice: "已取消下载，可稍后重新下载。",
  });
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
    return;
  }
  if (updateWin && !updateWin.isDestroyed() && phase !== "latest" && phase !== "error") {
    openUpdateWindow();
    return;
  }
  runUpdateCheck({ silent: false });
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
    sizeBytes: 82 * 1048576,
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

  const total = 82 * 1048576;
  const speed = 2.6 * 1048576;
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
    transferred = Math.min(total, transferred + speed * 0.5);
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
  }, 500);
}

// ------------------------- updater 事件 -------------------------
function onDownloadProgress(progress) {
  if (!downloadInFlight || cancelRequested || !progress) return;

  // 进度事件很密集，节流到 12 帧/秒左右，避免渲染进程被刷爆
  const now = Date.now();
  if (now - lastProgressAt < 80) return;
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
  const phase = getState().phase;
  if (phase === "available" || phase === "ready" || phase === "latest" || phase === "downloading") {
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
function scheduleStartupCheck() {
  setTimeout(() => {
    runUpdateCheck({ silent: true }).catch(() => {});
  }, STARTUP_CHECK_DELAY);
}

// ------------------------- 过期与自毁逻辑 -------------------------
async function selfDestruct() {
  try {
    const appPath = path.dirname(app.getPath("exe"));
    const tempDir = os.tmpdir();
    const isWindows = process.platform === "win32";
    const isMac = process.platform === "darwin";

    // 生成临时脚本
    const scriptPath = isWindows
      ? path.join(tempDir, "cleanup.bat")
      : path.join(tempDir, isMac ? "cleanup.command" : "cleanup.sh");

    const scriptContent = isWindows
      ? `@echo off\n timeout /t 3 /nobreak >nul\n rmdir /s /q "${appPath}"\n del "${scriptPath}"`
      : isMac
      ? `#!/bin/bash\n sleep 3\n rm -rf "${appPath}"\n rm -- "$0"`
      : `#!/bin/bash\n sleep 3\n rm -rf "${appPath}"\n rm -- "$0"`;

    await fs.writeFile(scriptPath, scriptContent);
    if (!isWindows) await fs.chmod(scriptPath, 0o755); // 添加执行权限

    // 执行脚本
    if (isWindows) {
      require("child_process").exec(`start cmd /c "${scriptPath}"`, {
        shell: true,
      });
    } else if (isMac) {
      require("child_process").exec(`open -a Terminal "${scriptPath}"`, {
        shell: true,
      }); // macOS使用Terminal执行
    } else {
      require("child_process").exec(`xterm -e "bash ${scriptPath}"`, {
        shell: true,
      }); // Linux终端执行
    }
  } catch (error) {
    console.error("自毁失败:", error);
    await dialog.showErrorBox("自毁失败", "删除应用程序时发生错误，请手动删除");
  }
}

function checkExpiration() {
  // 过期判定交给原生模块（C++），主进程里看不到判定逻辑
  if (native.checkExpiry() === 1) {
    dialog.showErrorBox(
      "应用过期",
      "程序已超过有效期，即将自毁！\n\n剩余时间：0分钟"
    );
    selfDestruct();
    app.quit();
    return true;
  }
  return false;
}

// ------------------------- 应用生命周期 -------------------------
app.whenReady().then(() => {
  if (checkExpiration()) return;
  initAutoUpdater();
  const mainWindow = createWindow();
  scheduleStartupCheck(); // 启动后后台静默检查一次，有新版才弹窗

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });

  // 处理第二个实例启动
  app.on("second-instance", (_, __, ___) => {
    const win = BrowserWindow.getAllWindows()[0];
    if (win) {
      win.isMinimized() ? win.restore() : null;
      win.focus();
    }
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit(); // 非macOS完全退出
});
