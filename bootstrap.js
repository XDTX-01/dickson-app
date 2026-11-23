// 应用入口（明文引导层，保持极薄）：
// 生产：校验 app.jsc 完整性 → 加载字节码主程序
// 本地开发（无编译产物）：直接加载源码 main.js，npm start 可直接测试
const fs = require('fs');
const path = require('path');

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
const bytenode = require('bytenode');

const jscPath = path.join(__dirname, 'build-protect', 'app.jsc');
const sumPath = path.join(__dirname, 'build-protect', 'checksum.txt');

function abort() {
    // 完整性校验失败：静默退出，不给篡改者留信息
    process.exit(1);
}

if (!fs.existsSync(jscPath) || !fs.existsSync(sumPath)) abort();

const expected = fs.readFileSync(sumPath, 'utf8').trim();
if (!native.verifyFile(jscPath, expected)) abort();

// 注册 .jsc 加载器并运行字节码主程序（require('bytenode') 已自动注册扩展名）
require(jscPath);
