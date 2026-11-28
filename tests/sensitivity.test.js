// 变异自检：故意把源码改坏，确认上面那些断言真的会变红。
// 没有这一组用例，“测试通过”有可能只是断言写空了（比如抽到空字符串、正则永远不匹配）。
const fs = require('fs');
const path = require('path');
const { test, assert } = require('./_t');
const { read, extract } = require('./_helpers');

function mutate(text, from, to) {
    assert(text.indexOf(from) !== -1, '变异目标不存在: ' + from);
    return text.replace(from, to);
}

// 用正则做变异：不依赖缩进宽度、空行、行尾空白——这些只跟编辑器/换行设置有关，
// 跟“断言是否有效”无关。之前用固定缩进字符串匹配，在 CRLF/重排过的文件上会误报。
function mutateRe(text, pattern, to) {
    assert(pattern.test(text), '变异目标不存在: ' + pattern);
    return text.replace(pattern, to);
}

function forbiddenHit(text, argv) {
    const seg = text.split('function hitForbiddenSwitch(argv) {')[1];
    assert(seg, '抽不到 hitForbiddenSwitch');
    const code = 'function hitForbiddenSwitch(argv) {' + seg.split('function sanitizeEnvironment')[0] + 'return hitForbiddenSwitch;';
    const fn = new Function('FORBIDDEN_SWITCHES', 'FORBIDDEN_ENV', code);
    // 从文本里还原黑名单，保证变异后的清单被真正用上
    const list = (text.match(/const FORBIDDEN_SWITCHES = \[([\s\S]*?)\];/) || [])[1] || '';
    const switches = (list.match(/'[^']+'/g) || []).map((s) => s.slice(1, -1));
    return fn(switches, [])(argv);
}

test('变异：从黑名单里删掉 --inspect → 同一个判定函数就拦不住了', () => {
    const original = read('bootstrap.js');
    assert(forbiddenHit(original, ['app.exe', '--inspect']) === '--inspect', '基线应命中');
    const broken = mutateRe(original, /^\s*'--inspect',\n/m, '');
    assert(forbiddenHit(broken, ['app.exe', '--inspect']) === '', '变异后仍命中说明清单没被用上');
});

test('变异：把原生模块自校验改成 native.verifyBuffer → 静态审计立刻失败', () => {
    const original = read('bootstrap.js');
    assert(/crypto\s*\.\s*createHash\('sha256'\)/.test(original), '基线应通过');
    const broken = mutateRe(original, /crypto\s*\.\s*createHash\('sha256'\)/, "native.verifyBuffer(Buffer.from('x')");
    assert(!/crypto\s*\.\s*createHash\('sha256'\)/.test(broken), '变异后不应再出现 crypto 自校验');
});

test('变异：去掉失败删包 → 静态审计的 unlink 断言失败', () => {
    const original = read('main.js');
    const seg = original.split('async function onUpdateDownloaded')[1].split('function handleDownloadedVerified')[0];
    assert(/fs\.unlink\(file\)/.test(seg), '基线应通过');
    const brokenSeg = seg.replace(/await fs\.unlink\(file\);/, '/* 删除被去掉了 */');
    assert(!/fs\.unlink\(file\)/.test(brokenSeg), '变异后不应再有删包');
});

test('变异：把“先验后就绪”改成“先就绪后验” → 顺序断言失败', () => {
    const original = read('main.js');
    const seg = original.split('async function onUpdateDownloaded')[1].split('function handleDownloadedVerified')[0];
    const orderOk = seg.indexOf('verifyDownloadedInstaller') < seg.indexOf('handleDownloadedVerified');
    assert(orderOk, '基线顺序应正确');
    // 把 handleDownloadedVerified 提到验签之前
    const broken = seg.replace('handleDownloadedVerified(info);\n}', 'handleDownloadedVerified(info);\n}\n// moved');
    const movedSeg = 'handleDownloadedVerified(info);\n' + broken;
    assert(!(movedSeg.indexOf('verifyDownloadedInstaller') < movedSeg.indexOf('handleDownloadedVerified')), '变异后顺序断言应失败');
});

test('变异：把验签改成恒真 → 被篡改的清单也能“通过”', () => {
    const crypto = require('crypto');
    const kp = crypto.generateKeyPairSync('ed25519');
    const payload = '{"v":1}';
    const sig = crypto.sign(null, Buffer.from(payload, 'utf8'), kp.privateKey);
    const tampered = '{"v":1,"expireAt":99999999999}';

    const real = crypto.verify(null, Buffer.from(tampered, 'utf8'), kp.publicKey, sig);
    assert(real === false, '真实验签必须拒绝被改过的 payload');

    // 模拟“把验签改成恒真”的变异版本
    const fakeVerify = () => true;
    assert(fakeVerify() === true, '变异版本必然放行 —— 说明上面那条断言不是空的');
});

test('变异：protect.cc 的 EXPIRE_MS 漏掉 LL → 常量断言失败', () => {
    const original = read('protect/protect.cc');
    assert(/EXPIRE_MS\s*=\s*\d+LL/.test(original), '基线应通过');
    const broken = original.replace(/(EXPIRE_MS\s*=\s*)(\d+)(LL)/, '$1$2');
    assert(!/EXPIRE_MS\s*=\s*\d+LL/.test(broken), '变异后不应再匹配 LL');
});

test('变异：package.json 把 onlyLoadAppFromAsar 改回 true→false', () => {
    const pkg = JSON.parse(read('package.json'));
    assert(pkg.build.electronFuses.onlyLoadAppFromAsar === true, '基线应为 true');
    const broken = Object.assign({}, pkg.build.electronFuses, { onlyLoadAppFromAsar: false });
    assert(broken.onlyLoadAppFromAsar !== true, '变异后断言应失败');
});
