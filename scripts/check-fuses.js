#!/usr/bin/env node
// 检查打出来的 exe 里，Electron fuse 线是否真的是我们要求的那一串
//
//   node scripts/check-fuses.js dist/win-unpacked/dickson-color-studio.exe
//   node scripts/check-fuses.js            # 默认找 dist/win-unpacked/*.exe
//
// 为什么值得单独检查：fuse 是否写进 exe 完全取决于 electron-builder 的配置，
// 写错了不会有任何报错——包照样能装、能跑，但 --inspect / NODE_OPTIONS 依然生效。
// 这个脚本和 protect.cc 里的 readFuseWire 用同一套哨兵与索引口径，本地与 CI 都跑
const fs = require('fs');
const path = require('path');

const SENTINEL = Buffer.from('dL7pKGdnNz796PbbjQWNKmHXBZaB9tsX', 'utf8');

// 索引与含义（Electron 官方顺序）
const INDEXES = [
    [0, 'RunAsNode', '0'],
    [1, 'EnableCookieEncryption', '1'],
    [2, 'EnableNodeOptionsEnvironmentVariable', '0'],
    [3, 'EnableNodeCliInspectArguments', '0'],
    [4, 'EnableEmbeddedAsarIntegrityValidation', '1'],
    [5, 'OnlyLoadAppFromAsar', '1'],
    [6, 'LoadBrowserProcessSpecificV8Snapshot', '0'],
];

function fail(msg) {
    console.error('[check-fuses] FAIL: ' + msg);
    process.exit(1);
}

function findWire(buf) {
    let from = 0;
    while (true) {
        const idx = buf.indexOf(SENTINEL, from);
        if (idx === -1) return null;
        // 哨兵可能命中多处（比如被其它资源包含），形状不对就往后继续找
        from = idx + 1;
        const pos = idx + SENTINEL.length;
        if (pos + 2 > buf.length) continue;
        const version = buf[pos];
        const count = buf[pos + 1];
        if (!(version >= 1 && version <= 5) || !(count >= 1 && count <= 40)) {
            continue;
        }
        const pos2 = pos + 2;
        if (pos2 + count > buf.length) continue;
        let good = true;
        for (let i = 0; i < count; i++) {
            const b = buf[pos2 + i];
            if (b !== 0x30 && b !== 0x31) {
                good = false; // 只允许 '0' / '1'
                break;
            }
        }
        if (!good) continue;
        let wire = '';
        for (let i = 0; i < count; i++) wire += String.fromCharCode(buf[pos2 + i]);
        return { version, count, wire, offset: idx };
    }
}

function pickExe(argv) {
    if (argv[2]) return path.resolve(process.cwd(), argv[2]);
    const dir = path.resolve(process.cwd(), 'dist', 'win-unpacked');
    if (!fs.existsSync(dir)) fail('没有传 exe 路径，且 dist/win-unpacked 不存在');
    const exes = fs.readdirSync(dir).filter((n) => n.toLowerCase().endsWith('.exe'));
    if (exes.length === 0) fail('dist/win-unpacked 里没有 exe');
    return path.join(dir, exes[0]);
}

const exePath = pickExe(process.argv);
if (!fs.existsSync(exePath)) fail('找不到 exe: ' + exePath);

const buf = fs.readFileSync(exePath);
const wire = findWire(buf);
if (!wire) fail('exe 里找不到 fuse 线（fuses 没写进去，或配置没生效）');

console.log('[check-fuses] exe = ' + exePath);
console.log('[check-fuses] fuse 线 = ' + wire.wire + '（version ' + wire.version + ', ' + wire.count + ' 项）');

let bad = 0;
for (const [index, name, expect] of INDEXES) {
    if (index >= wire.count) {
        console.log('  [' + index + '] ' + name + ' = (缺失) 期望 ' + expect);
        bad++;
        continue;
    }
    const actual = wire.wire[index];
    const ok = actual === expect;
    if (!ok) bad++;
    console.log('  [' + index + '] ' + name + ' = ' + actual + (ok ? '  OK' : '  期望 ' + expect + ' ← 不符'));
}
if (bad > 0) fail(bad + ' 项与要求不符');
console.log('[check-fuses] 全部通过');
