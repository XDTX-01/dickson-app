// L1+L2 管线：高强度混淆 main.js → bytenode 在 Electron 主进程里编译为 app.jsc
// 运行方式：node scripts/protect.js（bytenode 自行拉起 Electron 完成 V8 编译）
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const root = path.join(__dirname, '..');
const outDir = path.join(root, 'build-protect');
const source = fs.readFileSync(path.join(root, 'main.js'), 'utf8');

// ---- L2：javascript-obfuscator 高强度预设 ----
const JavaScriptObfuscator = require('javascript-obfuscator');
const obfuscated = JavaScriptObfuscator.obfuscate(source, {
    compact: true,
    selfDefending: true,
    disableConsoleOutput: false,
    identifierNamesGenerator: 'hexadecimal',
    stringArray: true,
    stringArrayEncoding: ['rc4'],
    stringArrayThreshold: 1,
    transformObjectKeys: true,
    controlFlowFlattening: true,
    controlFlowFlatteningThreshold: 0.75,
    deadCodeInjection: true,
    deadCodeInjectionThreshold: 0.4,
    unicodeEscapeSequence: false,
    log: false,
}).getObfuscatedCode();

// 解析 Electron 可执行文件；缺失（纯本地无 Electron）时只做语法干跑
let electronPath = null;
try {
    electronPath = require('electron');
} catch (_) {
    electronPath = null;
}

if (!electronPath || !fs.existsSync(electronPath)) {
    new Function(obfuscated);
    console.log('[protect] 本地干跑：混淆产物语法校验通过（未编译 jsc）');
    process.exit(0);
}

(async () => {
    const bytenode = require('bytenode');
    fs.mkdirSync(outDir, { recursive: true });
    const obfPath = path.join(outDir, 'app.obf.js');
    fs.writeFileSync(obfPath, obfuscated);
    try {
        // ---- L1：在 Electron 主进程内编译字节码（V8 快照/版本匹配） ----
        await bytenode.compileFile({
            filename: obfPath,
            electronMain: true,
            electronPath,
            compileAsModule: true,
            output: path.join(outDir, 'app.jsc'),
        });
    } finally {
        fs.rmSync(obfPath, { force: true });
    }

    // L4：写入 jsc 的 sha256，bootstrap.js 启动时逐字节校验，被篡改直接退出
    const jsc = fs.readFileSync(path.join(outDir, 'app.jsc'));
    const sum = crypto.createHash('sha256').update(jsc).digest('hex');
    fs.writeFileSync(path.join(outDir, 'checksum.txt'), sum + '\n');
    console.log('[protect] app.jsc 已生成，sha256 =', sum);
})();
