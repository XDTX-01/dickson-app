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

// L4（扩展）：只校验 app.js / index.html 时，改任意一个 js chunk 都能悄悄换掉界面逻辑。
// 这里把 src 下的代码与样式产物、dialog-ui、update-ui 全部纳入清单（图片素材除外：
// 40MB+ 的 jpg 每次启动都哈希会明显拖慢启动，而且改图最多换个纹理，改代码才是真风险）。
const CHECKED_FILES = ['build-protect/app.js'];

function walk(dir, base, list) {
    const abs = path.join(root, dir);
    if (!fs.existsSync(abs)) return;
    for (const entry of fs.readdirSync(abs, { withFileTypes: true })) {
        const rel = base + '/' + entry.name;
        if (entry.isDirectory()) {
            // 素材图不参与完整性校验
            if (entry.name === 'img') continue;
            walk(dir + '/' + entry.name, rel, list);
        } else {
            // 素材图、构建期 .gz 副本不参与完整性校验（图片 40MB+ 会拖慢启动，gz 只是发布用副本）
            if (/\.(map|gz|jpg|jpeg|png|gif|webp)$/i.test(entry.name)) continue;
            list.push(rel);
        }
    }
}

walk('src', 'src', CHECKED_FILES);
walk('dialog-ui', 'dialog-ui', CHECKED_FILES);
walk('update-ui', 'update-ui', CHECKED_FILES);
CHECKED_FILES.sort();

const files = {};
const missing = [];
for (const rel of CHECKED_FILES) {
    let buf;
    try {
        buf = fs.readFileSync(path.join(root, rel));
    } catch (_) {
        missing.push(rel);
        continue;
    }
    files[rel] = crypto.createHash('sha256').update(buf).digest('hex');
}

fs.writeFileSync(
    path.join(outDir, 'manifest.json'),
    JSON.stringify({ version: 1, generatedAt: new Date().toISOString(), files }, null, 2),
    'utf8'
);

console.log('[protect] app.js 已生成，sha256 =', sum);
console.log('[protect] 校验清单已生成，共', Object.keys(files).length, '个文件');

if (missing.length) {
    console.warn('[protect] 以下文件不存在，未纳入校验：', missing.join(', '));
    // 前端产物没灌进来时打出来的包必然是白屏，这里直接失败，别等装完了才发现
    if (missing.indexOf('src/index.html') !== -1) {
        console.error('[protect] ERROR: src/index.html 不存在，请先把前端 dist 产物放进 src/ 再打包');
        process.exit(1);
    }
}
