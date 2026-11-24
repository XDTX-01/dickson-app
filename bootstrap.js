// 应用入口（明文引导层，保持极薄）：
// 生产：原生模块按 build-protect/manifest.json 逐文件校验完整性 → 加载混淆产物 app.js 执行
// 开发：未打包（app.isPackaged === false）直接跑源码 main.js，npm start 可直接测试
const fs = require('fs');
const path = require('path');
const Module = require('module');
const { app } = require('electron');

let native = null;
try {
    native = require('./protect/protect.node');
} catch (_) {
    native = null;
}

// 判断“是不是生产包”只看 app.isPackaged，不再看原生模块能不能 require。
// 以前用 native 是否存在来判断：本地一旦编译过 protect.node，npm start 就会误入生产分支，
// 找不到 build-protect/app.js 就 process.exit(1)，表现为“启动毫无反应”。
if (!native || !app.isPackaged) {
    require('./main.js');
    return;
}

// ------------------------- 生产模式 -------------------------
// 关键文件都在 asar 里，C++ 的 ifstream 读不到虚拟文件系统：
// 由 Node 侧读出内容（异步透明支持 asar），哈希计算仍在原生模块里做
const unpackedDir = path.join(__dirname, '..', 'app.asar.unpacked', 'build-protect');
const manifestPath = path.join(unpackedDir, 'manifest.json');
const appPath = path.join(unpackedDir, 'app.js');

function abort() {
    // 完整性校验失败：静默退出，不给篡改者留信息
    process.exit(1);
}

// 老版本原生模块没有 verifyBuffer，能力不齐就没有校验意义
if (typeof native.verifyBuffer !== 'function' || typeof native.verifyFile !== 'function') abort();

if (!fs.existsSync(manifestPath) || !fs.existsSync(appPath)) abort();

let manifest = null;
try {
    manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
} catch (_) {
    abort();
}

const expectedFiles = (manifest && manifest.files) || {};
const entries = Object.keys(expectedFiles);
if (entries.length === 0) abort();

for (const rel of entries) {
    const expected = String(expectedFiles[rel] || '');
    if (!expected) abort();

    // build-protect 下的文件在 asarUnpack 的真实目录，其余文件按 asar 根目录解析
    const abs = rel.indexOf('build-protect/') === 0
        ? path.join(unpackedDir, path.basename(rel))
        : path.join(__dirname, rel);

    let content = null;
    try {
        content = fs.readFileSync(abs);
    } catch (_) {
        abort();
    }
    if (!native.verifyBuffer(content, expected)) abort();
}

// 以 asar 根目录作为模块 __dirname 编译执行，保证 main.js 内的相对路径（src/、package.json）正确
const code = fs.readFileSync(appPath, 'utf8');
const mod = new Module('protected-main', null);
mod.filename = path.join(__dirname, 'app.js');
mod.paths = Module._nodeModulePaths(__dirname);
mod._compile(code, mod.filename);
