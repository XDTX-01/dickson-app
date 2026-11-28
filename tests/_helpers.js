// 测试公共设施：要被验证的不是“重新写一遍”的函数，而是仓库里那份真实代码。
// 做法是按标记把源码里的整段逻辑抽出来，用注入依赖的方式执行——
// 源码改了、而这几个用例没跟着改，就会立刻变红。
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');

function read(rel) {
    return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}

// 抽 [startMarker, endMarker) 之间的代码；标记找不到直接抛错（避免静默抽到空字符串后“全都通过”）
function extract(rel, startMarker, endMarker) {
    const text = read(rel);
    const start = text.indexOf(startMarker);
    if (start === -1) throw new Error('标记未找到(' + rel + '): ' + startMarker);
    const end = text.indexOf(endMarker, start);
    if (end === -1) throw new Error('结束标记未找到(' + rel + '): ' + endMarker);
    return text.slice(start, end);
}

function tmpDir(prefix) {
    const dir = path.join(require('os').tmpdir(), prefix + '-' + process.pid + '-' + Date.now() + '-' + Math.random().toString(16).slice(2));
    fs.mkdirSync(dir, { recursive: true });
    return dir;
}

function rmrf(dir) {
    try {
        fs.rmSync(dir, { recursive: true, force: true });
    } catch (_) {}
}

// 生成一次性 Ed25519 密钥对（测试用，绝不与真实私钥混用）
function newKeyPair() {
    const crypto = require('crypto');
    const pair = crypto.generateKeyPairSync('ed25519');
    const jwk = pair.privateKey.export({ format: 'jwk' });
    const pubB64 = Buffer.from(jwk.x.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('base64');
    return { privateKey: pair.privateKey, publicKey: pair.publicKey, jwk, pubB64 };
}

module.exports = { ROOT, read, extract, tmpDir, rmrf, newKeyPair };
