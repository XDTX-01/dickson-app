// L2 管线：高强度混淆 main.js → build-protect/app.js；L4 写入 sha256 校验值
// 运行方式：node scripts/protect.js（纯 Node，不依赖 Electron，CI/本地一致）
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

fs.mkdirSync(outDir, { recursive: true });
const appPath = path.join(outDir, 'app.js');
fs.writeFileSync(appPath, obfuscated);

// L4：写入混淆产物的 sha256，bootstrap.js 启动时由原生模块逐字节校验，被篡改直接退出
const sum = crypto.createHash('sha256').update(obfuscated).digest('hex');
fs.writeFileSync(path.join(outDir, 'checksum.txt'), sum + '\n');
console.log('[protect] app.js 已生成，sha256 =', sum);
