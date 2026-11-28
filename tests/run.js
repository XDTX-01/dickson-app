#!/usr/bin/env node
// 加固链路回归测试入口（纯 Node，不依赖 electron / native / 真机密钥）
//
//   node tests/run.js
//   npm test
//
// 每个用例跑的都不是“复制品”，而是仓库里那份真实源码里抽出来的逻辑，
// 所以源码一改、用例不改，就会立刻变红（另有 sensitivity 组专门证明断言不是空的）。
const fs = require('fs');
const path = require('path');
const { cases } = require('./_t');

const TEST_DIR = __dirname;
const FILES = [
    'license.test.js',
    'update-verify.test.js',
    'static-audit.test.js',
    'sensitivity.test.js',
];

const startedAt = Date.now();
let passed = 0;
let failed = 0;
const failures = [];

function loadSuite() {
    for (const file of FILES) {
        const abs = path.join(TEST_DIR, file);
        if (!fs.existsSync(abs)) {
            failed += 1;
            failures.push({ name: file, error: '测试文件不存在' });
            continue;
        }
        // 每个文件里用 test() 注册用例，注册即执行顺序在下面统一跑
        require(abs);
    }
}

async function main() {
    loadSuite();

    for (const c of cases) {
        try {
            const result = c.fn();
            if (result && typeof result.then === 'function') await result;
            passed += 1;
            process.stdout.write('  PASS  ' + c.name + '\n');
        } catch (err) {
            failed += 1;
            failures.push({ name: c.name, error: (err && err.message) || String(err) });
            process.stdout.write('  FAIL  ' + c.name + '\n');
        }
    }

    const ms = Date.now() - startedAt;
    if (failed > 0) {
        process.stdout.write('\n失败用例：\n');
        for (const f of failures) {
            process.stdout.write('  - ' + f.name + '\n      ' + f.error + '\n');
        }
        process.stdout.write('\nFAILED ' + failed + ' / ' + (passed + failed) + ' cases (' + ms + 'ms)\n');
        process.exit(1);
    }
    process.stdout.write('\nALL PASS ' + passed + ' cases (' + ms + 'ms)\n');
}

main().catch((err) => {
    process.stdout.write('\n测试运行器异常: ' + ((err && err.stack) || err) + '\n');
    process.exit(1);
});
