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

// L4：bootstrap.js 启动时逐字节校验。清单只写进 manifest.json 一处
// （原来的 checksum.txt 写出来没有任何地方读，已删除）
const sum = crypto.createHash('sha256').update(obfuscated).digest('hex');

// L4（扩展）：只校验 app.js / index.html 时，改任意一个 js chunk 都能悄悄换掉界面逻辑。
// 这里把 src 下的代码与样式产物、dialog-ui、update-ui 全部纳入清单（大图除外：
// 40MB+ 的 jpg 每次启动都哈希会明显拖慢启动，改图最多换个纹理，改代码才是真风险）。
const CHECKED_FILES = ['build-protect/app.js'];

// 原生模块自身必须进清单：它是校验的执行者，被换成永远返回 true 的桩，整条链就失效。
// 同一条在 bootstrap.js 里由 Node 侧 crypto 计算——不能用模块自己校验自己。
const NATIVE_MODULE = path.join(root, 'protect', 'protect.node');
if (!fs.existsSync(NATIVE_MODULE)) {
    console.error('[protect] ERROR: 找不到 protect/protect.node，请先执行 npm run build:native');
    process.exit(1);
}
CHECKED_FILES.push('protect/protect.node');

// 素材图不做逐字节哈希，改登记「路径 → 字节数」，启动时只 stat 不读内容：
// 能挡住"换掉一张材质图"，又不会把启动拖慢几秒
const ASSET_EXT = /\.(jpg|jpeg|png|gif|webp|bmp)$/i;
const SKIP_EXT = /\.(map|gz)$/i;
const assets = {};

function walk(dir, base, list) {
    const abs = path.join(root, dir);
    if (!fs.existsSync(abs)) return;
    for (const entry of fs.readdirSync(abs, { withFileTypes: true })) {
        const rel = base + '/' + entry.name;
        if (entry.isDirectory()) {
            walk(dir + '/' + entry.name, rel, list);
        } else {
            // 构建期 .gz 副本只是发布用（build.files 里也已排除），不参与校验
            if (SKIP_EXT.test(entry.name)) continue;
            if (ASSET_EXT.test(entry.name)) {
                assets[rel] = fs.statSync(path.join(root, rel)).size;
                continue;
            }
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
// 缺任何一个都意味着包打不开或校验形同虚设，直接失败，别等装完了才发现
const REQUIRED = ['build-protect/app.js', 'protect/protect.node', 'src/index.html', 'src/preload.js'];
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

const missingRequired = missing.filter((rel) => REQUIRED.indexOf(rel) !== -1);
if (missingRequired.length) {
    console.error('[protect] ERROR: 关键文件缺失，无法生成有效校验清单：' + missingRequired.join(', '));
    if (missingRequired.indexOf('src/index.html') !== -1) {
        console.error('[protect] 提示：请先把前端 dist 产物放进 src/ 再打包');
    }
    process.exit(1);
}
if (missing.length) {
    console.warn('[protect] 以下文件不存在，未纳入校验：', missing.join(', '));
}

fs.writeFileSync(
    path.join(outDir, 'manifest.json'),
    JSON.stringify(
        { version: 2, generatedAt: new Date().toISOString(), files, assets },
        null,
        2
    ),
    'utf8'
);

console.log('[protect] app.js 已生成，sha256 =', sum);
console.log(
    '[protect] 校验清单已生成：',
    Object.keys(files).length,
    '个文件 +',
    Object.keys(assets).length,
    '张素材大小'
);

