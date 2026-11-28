// 应用入口（明文引导层，保持极薄）：
// 生产：拦掉调试参数 → 打开原生会话 → 校验签名授权 → 按 build-protect/manifest.json 逐文件校验 → 加载混淆产物 app.js
// 开发：未打包（app.isPackaged === false）直接跑源码 main.js，npm start 可直接测试
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const Module = require('module');
const { app, dialog } = require('electron');

// ---------------------------------------------------------------------------
// 0 启动期硬拦：调试类命令行开关与环境变量
//
// fuse 已经关掉了 --inspect / NODE_OPTIONS / ELECTRON_RUN_AS_NODE，但
// --remote-debugging-* 系列 fuse 管不到，而且这些开关是 Chromium 解析的，
// 只要进程起来了就已经生效。所以在加载任何业务代码之前再拦一遍，
// 多层防御互不依赖：任一层被绕过，其它层还在。
const FORBIDDEN_SWITCHES = [
    '--inspect',
    '--inspect-brk',
    '--inspect-port',
    '--inspect-wait',
    '--remote-debugging-port',
    '--remote-debugging-pipe',
    '--remote-debugging-socket',
    '--remote-allow-origins',
    '--js-flags',
    '--devtools',
    '--enable-devtools',
];

const FORBIDDEN_ENV = [
    'NODE_OPTIONS',
    'ELECTRON_RUN_AS_NODE',
    'ELECTRON_NO_ATTACH_CONSOLE',
];

function hitForbiddenSwitch(argv) {
    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i];
        if (typeof arg !== 'string') continue;
        const low = arg.toLowerCase();
        for (let j = 0; j < FORBIDDEN_SWITCHES.length; j++) {
            const sw = FORBIDDEN_SWITCHES[j];
            if (low === sw || low.indexOf(sw + '=') === 0) return sw;
        }
    }
    return '';
}

function sanitizeEnvironment() {
    for (let i = 0; i < FORBIDDEN_ENV.length; i++) {
        try {
            delete process.env[FORBIDDEN_ENV[i]];
        } catch (_) {}
    }
    // 已经被 Chromium 解析过的开关：能删就删，删不掉的由下面的 fatal 兜底
    try {
        if (app.commandLine && typeof app.commandLine.removeSwitch === 'function') {
            for (let i = 0; i < FORBIDDEN_SWITCHES.length; i++) {
                app.commandLine.removeSwitch(FORBIDDEN_SWITCHES[i].replace(/^--/, ''));
            }
        }
    } catch (_) {}
}

// 校验失败：对篡改者只说“校验失败”，明细只写本地日志；
// 但不再静默退出——双击了没反应比弹出提示更让人抓狂
function abort(reason) {
    const detail = String(reason || 'unknown');
    try {
        const logDir = path.join(app.getPath('userData'), 'logs');
        fs.mkdirSync(logDir, { recursive: true });
        fs.appendFileSync(
            path.join(logDir, 'integrity.log'),
            '[' + new Date().toISOString() + '] ' + detail + '\n',
            'utf8'
        );
    } catch (_) {
        // 日志写不进去不影响退出流程
    }
    try {
        dialog.showErrorBox(
            '无法启动',
            '程序文件校验失败或已被修改，请重新安装最新版本。\n如反复出现，请联系客服并提供日志。'
        );
    } catch (_) {
        // 极少数环境在 ready 之前不允许弹窗，忽略
    }
    process.exit(1);
}

// 判断“是不是生产包”只看 app.isPackaged。开发模式不做任何原生校验，
// 否则本地没编译 native 时 npm start 会直接退出，表现为“启动毫无反应”。
if (!app.isPackaged) {
    require('./main.js');
    return;
}

sanitizeEnvironment();
{
    const hit = hitForbiddenSwitch(process.argv);
    if (hit) abort('启动参数含禁用开关: ' + hit);
}

// 一次性的 DevTools 兜底：即使用户从菜单/快捷键打开，也立刻关掉
try {
    app.on('browser-window-created', (_event, win) => {
        if (!win || !win.webContents) return;
        const wc = win.webContents;
        wc.on('devtools-opened', () => {
            try {
                wc.closeDevTools();
            } catch (_) {}
        });
    });
} catch (_) {}

let native = null;
try {
    native = require('./protect/protect.node');
} catch (_) {
    native = null;
}

// 原生模块能力必须齐：少一个，后面的校验链就是空的。杀软清掉 .node 也走这里
if (!native) abort('protect.node 缺失或无法加载');
const REQUIRED_NATIVE = [
    'openCore',
    'isCoreOpen',
    'hostCheck',
    'checkTamper',
    'checkExpiry',
    'expireAt',
    'applyLicense',
    'hasLicense',
    'machineId',
    'verifyBuffer',
    'verifyFile',
];
for (const fn of REQUIRED_NATIVE) {
    if (typeof native[fn] !== 'function') abort('native 模块缺少 ' + fn);
}

// ---------------------------------------------------------------------------
// 1 原生会话：宿主校验 + fuse 线强制 + 一次性令牌
// 从这里开始 native 的敏感导出才会响应；会话没打开时调用它们会直接抛异常
const coreSeed = crypto.randomBytes(16).toString('hex');
let coreToken = '';
try {
    coreToken = String(native.openCore(coreSeed) || '');
} catch (err) {
    abort('核心校验失败: ' + (err && err.message ? err.message : String(err)));
}
if (!coreToken) {
    let why = '';
    try {
        const hc = native.hostCheck();
        why = (hc && hc.reason) || '';
    } catch (_) {}
    abort('核心校验失败' + (why ? ': ' + why : ''));
}

// ---------------------------------------------------------------------------
// 1.5 授权校验（Ed25519 签名 license）
//
// 到期时间不是“编译进 exe 的一个数字”，而是写在 license.json 里、由你的私钥签名：
//   { "payload": "{\"v\":1,\"customer\":..,\"expireAt\":..,\"issuedAt\":..,\"machineId\":..}",
//     "sig": "<ed25519 signature over payload bytes, base64>" }
// 客户端只有公钥（protect/verify-pub.json，随 asar 一起受完整性保护），所以拿到全部
// 源码也造不出一份能延长到期的授权。验签通过后把 expireAt 交给原生模块，
// 之后 checkExpiry() 一律以这个值为准。
//
// 查找顺序：userData/license.json（续期授权，用户可替换）→ protect/license.default.json（包里自带）。
// 都找不到时：requireLicense=false 退回编译期常量（兼容老安装），=true 直接拒绝启动。
const verifyPubPath = path.join(__dirname, 'protect', 'verify-pub.json');
let verifyPub = null;
try {
    verifyPub = JSON.parse(fs.readFileSync(verifyPubPath, 'utf8'));
} catch (_) {
    verifyPub = null;
}

function ed25519PublicKey(b64) {
    try {
        const raw = Buffer.from(String(b64 || ''), 'base64');
        if (raw.length !== 32) return null;
        return crypto.createPublicKey({
            key: { kty: 'OKP', crv: 'Ed25519', x: raw.toString('base64url') },
            format: 'jwk',
        });
    } catch (_) {
        return null;
    }
}

const licensePubKey = ed25519PublicKey(verifyPub && verifyPub.license);
const requireLicense = !!(verifyPub && verifyPub.requireLicense);

function readLicenseDoc(file) {
    try {
        if (!fs.existsSync(file)) return null;
        return JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (_) {
        return null;
    }
}

// 返回 { expireAt, customer } 或 null（null 表示“这份授权无效/不存在”）
function verifyLicenseDoc(doc) {
    if (!doc || typeof doc.payload !== 'string' || typeof doc.sig !== 'string') return null;
    if (!licensePubKey) return null;

    const sigBuf = Buffer.from(doc.sig, 'base64');
    if (sigBuf.length !== 64) return null;

    let ok = false;
    try {
        ok = crypto.verify(
            null,
            Buffer.from(doc.payload, 'utf8'),
            licensePubKey,
            sigBuf
        );
    } catch (_) {
        ok = false;
    }
    if (!ok) return null;

    let fields = null;
    try {
        fields = JSON.parse(doc.payload);
    } catch (_) {
        return null;
    }
    if (!fields || typeof fields !== 'object' || Array.isArray(fields)) return null;
    if (fields.v !== 1) return null;

    const expireAt = Number(fields.expireAt);
    if (!isFinite(expireAt) || expireAt <= 0) return null;

    // 机器绑定是可选的：payload.machineId 为空或缺失表示“不绑定”
    const boundId = String(fields.machineId || '');
    if (boundId) {
        let localId = '';
        try {
            localId = String(native.machineId() || '');
        } catch (_) {
            localId = '';
        }
        if (!localId || localId !== boundId) return null;
    }

    return { expireAt: expireAt, customer: String(fields.customer || '') };
}

let license = null;
const licenseCandidates = [
    path.join(app.getPath('userData'), 'license.json'),
    path.join(__dirname, 'protect', 'license.default.json'),
];
for (const candidate of licenseCandidates) {
    const parsed = verifyLicenseDoc(readLicenseDoc(candidate));
    if (parsed) {
        license = parsed;
        break;
    }
}

if (license) {
    try {
        if (!native.applyLicense(license.expireAt)) abort('授权生效失败');
    } catch (err) {
        abort('授权生效失败: ' + (err && err.message ? err.message : String(err)));
    }
} else if (requireLicense) {
    abort('缺少有效授权文件 license.json');
}

// ---------------------------------------------------------------------------
// 2 文件完整性：按 manifest 逐文件校验
// 全部关键文件（含混淆产物 app.js）都留在 asar 里，只有 .node 被 electron-builder 解包：
// C++ 的 ifstream 读不到虚拟文件系统，所以由 Node 侧读出内容（异步透明支持 asar），
// 哈希计算仍在原生模块里做。
const manifestPath = path.join(__dirname, 'build-protect', 'manifest.json');
const appPath = path.join(__dirname, 'build-protect', 'app.js');

if (!fs.existsSync(manifestPath) || !fs.existsSync(appPath)) {
    abort('manifest.json 或 app.js 不存在');
}

let manifest = null;
try {
    manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
} catch (_) {
    abort('manifest.json 解析失败');
}

const expectedFiles = manifest && manifest.files;
// 清单必须是“相对路径 → sha256”的普通对象：数组、null、字符串都不能直接当清单用
if (!expectedFiles || typeof expectedFiles !== 'object' || Array.isArray(expectedFiles)) {
    abort('manifest.json 结构不正确');
}
const entries = Object.keys(expectedFiles);
if (entries.length === 0) abort('manifest.json 未登记任何文件');

// 清单里的相对路径统一做一次合法性校验：不允许绝对路径 / ../，也不允许空字节，
// 否则可以把校验目标指到应用目录之外
function resolveEntry(rel) {
    if (typeof rel !== 'string' || rel.indexOf('\0') !== -1) abort('非法文件名: ' + rel);
    if (path.isAbsolute(rel) || rel.split(/[\\/]/).indexOf('..') !== -1) {
        abort('清单包含越界路径: ' + rel);
    }
    return path.join(__dirname, rel);
}

// 第一步：先校验原生模块自己。它是下面所有校验的执行者，被换成“永远返回 true”的桩，
// 整条完整性链条就等于没有。所以这一条必须用 Node 的 crypto 算，不能用它自己验自己。
const NATIVE_REL = 'protect/protect.node';
if (entries.indexOf(NATIVE_REL) === -1) abort('校验清单未登记原生模块: ' + NATIVE_REL);
{
    const expected = String(expectedFiles[NATIVE_REL] || '').toLowerCase();
    if (!expected) abort('校验清单内容为空: ' + NATIVE_REL);
    let actual = '';
    try {
        actual = crypto
            .createHash('sha256')
            .update(fs.readFileSync(resolveEntry(NATIVE_REL)))
            .digest('hex');
    } catch (_) {
        abort('原生模块读取失败: ' + NATIVE_REL);
    }
    if (actual !== expected) abort('原生模块校验不一致: ' + NATIVE_REL);
}

// 第二步：其余文件交给原生模块逐字节校验
for (const rel of entries) {
    if (rel === NATIVE_REL) continue; // 上面已经用 crypto 验过

    const expected = String(expectedFiles[rel] || '');
    if (!expected) abort('校验清单内容为空: ' + rel);

    let content = null;
    try {
        content = fs.readFileSync(resolveEntry(rel));
    } catch (_) {
        abort('读取失败: ' + rel);
    }
    if (!native.verifyBuffer(content, expected)) abort('校验不一致: ' + rel);
}

// 第三步：素材图只比对字节数（protect 阶段登记，启动时只 stat 不读内容，几乎不占时间）
const expectedAssets = manifest.assets;
if (expectedAssets && typeof expectedAssets === 'object' && !Array.isArray(expectedAssets)) {
    for (const rel of Object.keys(expectedAssets)) {
        const expected = Number(expectedAssets[rel]);
        let stat = null;
        try {
            stat = fs.statSync(resolveEntry(rel));
        } catch (_) {
            abort('素材缺失: ' + rel);
        }
        if (!stat.isFile() || stat.size !== expected) abort('素材大小不一致: ' + rel);
    }
}

// 以 asar 根目录作为模块 __dirname 编译执行，保证 main.js 内的相对路径（src/、package.json）正确
let code = null;
try {
    code = fs.readFileSync(appPath, 'utf8');
} catch (err) {
    abort('读取 app.js 失败: ' + (err && err.message));
}
const mod = new Module('protected-main', null);
mod.filename = path.join(__dirname, 'app.js');
mod.paths = Module._nodeModulePaths(__dirname);
try {
    mod._compile(code, mod.filename);
} catch (err) {
    // 混淆产物自身语法/初始化异常时给出可诊断信息，而不是一个没有窗口的进程
    abort('app.js 执行失败: ' + (err && err.message ? err.message : String(err)));
}
