// 应用入口（明文引导层，保持极薄）：
// 生产：原生模块校验混淆产物 app.js 完整性 → 以 asar 根目录为 __dirname 加载执行
// 本地开发（无编译产物）：直接加载源码 main.js，npm start 可直接测试
const fs = require('fs');
const path = require('path');
const Module = require('module');

let native = null;
try {
    native = require('./protect/protect.node');
} catch (_) {
    native = null;
}

// 开发模式：原生模块不存在，直接跑源码
if (!native) {
    require('./main.js');
    return;
}

// ------------------------- 生产模式 -------------------------
// 原生 C++ 的 ifstream 无法透过 asar 虚拟文件系统读文件，
// app.js / checksum 必须使用 app.asar.unpacked 里的真实磁盘路径
const baseDir = path.join(__dirname, '..', 'app.asar.unpacked', 'build-protect');
const appPath = path.join(baseDir, 'app.js');
const sumPath = path.join(baseDir, 'checksum.txt');

function abort() {
    // 完整性校验失败：静默退出，不给篡改者留信息
    process.exit(1);
}

if (!fs.existsSync(appPath) || !fs.existsSync(sumPath)) abort();

const expected = fs.readFileSync(sumPath, 'utf8').trim();
if (!native.verifyFile(appPath, expected)) abort();

// 以 asar 根目录作为模块 __dirname 编译执行，保证 main.js 内的相对路径（src/、package.json）正确
const code = fs.readFileSync(appPath, 'utf8');
const mod = new Module('protected-main', null);
mod.filename = path.join(__dirname, 'app.js');
mod.paths = Module._nodeModulePaths(__dirname);
mod._compile(code, mod.filename);
