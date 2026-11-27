// 应用入口（明文引导层，保持极薄）：
// 生产：原生模块按 build-protect/manifest.json 逐文件校验完整性 → 加载混淆产物 app.js 执行
// 开发：未打包（app.isPackaged === false）直接跑源码 main.js，npm start 可直接测试
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const Module = require('module');
const { app, dialog } = require('electron');

let native = null;
try {
    native = require('./protect/protect.node');
} catch (_) {
    native = null;
}

// 判断“是不是生产包”只看 app.isPackaged，不再看原生模块能不能 require。
// 以前用 native 是否存在来判断：本地一旦编译过 protect.node，npm start 就会误入生产分支，
// 找不到 build-protect/app.js 就 process.exit(1)，表现为“启动毫无反应”。
if (!app.isPackaged) {
    require('./main.js');
    return;
}

// ------------------------- 生产模式 -------------------------
// 全部关键文件（含混淆产物 app.js）都留在 asar 里，只有 .node 被 electron-builder 解包：
// C++ 的 ifstream 读不到虚拟文件系统，所以由 Node 侧读出内容（异步透明支持 asar），
// 哈希计算仍在原生模块里做。security 上也不再需要把 build-protect 解包到磁盘。
const manifestPath = path.join(__dirname, 'build-protect', 'manifest.json');
const appPath = path.join(__dirname, 'build-protect', 'app.js');

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

// 老版本原生模块没有 verifyBuffer / verifyFile，能力不齐就没有校验意义；
// 另外杀毒软件把 protect.node 清掉时也走这里：不能悄悄退出，否则用户双击没反应
if (!native) {
    abort('protect.node 缺失或无法加载');
}
if (typeof native.verifyBuffer !== 'function' || typeof native.verifyFile !== 'function') {
    abort('native 模块缺少 verifyBuffer / verifyFile');
}

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
