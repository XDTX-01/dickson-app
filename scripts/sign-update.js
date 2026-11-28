#!/usr/bin/env node
// 给 electron-builder 生成的 latest.yml 签名 → latest.yml.sig
//
//   node scripts/sign-update.js --yml dist/latest.yml --key license-key.json
//   UPDATE_SIGN_KEY=<私钥 base64> node scripts/sign-update.js --yml dist/latest.yml
//
// 私钥来源优先级：--key 文件 > 环境变量 UPDATE_SIGN_KEY（CI 用）
// UPDATE_SIGN_KEY 接受两种写法：license-key.json 的原文（以 { 开头）或它 base64 编码后的串。
//
// ⚠️ BOM 口径：客户端用 fetch().text() 读清单，按 WHATWG 规范会自动丢掉开头的 BOM，
// 所以这里必须对“去掉 BOM 的文本”签名。Windows 上 PowerShell Out-File / 记事本另存
// 极易带 BOM，如果签名侧对原始字节签名，客户端就永远验不过，而且只会看到“校验失败”。
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

function arg(name, fallback) {
    const idx = process.argv.indexOf('--' + name);
    if (idx === -1) return fallback;
    const value = process.argv[idx + 1];
    if (value === undefined || value.startsWith('--')) return fallback;
    return value;
}

function fail(message) {
    console.error('[sign-update] ERROR: ' + message);
    process.exit(1);
}

function stripBom(text) {
    return String(text).replace(/^\uFEFF/, '');
}

function loadPrivateKey() {
    const keyPath = arg('key', '');
    let raw = '';

    if (keyPath) {
        const abs = path.resolve(process.cwd(), keyPath);
        if (!fs.existsSync(abs)) fail('找不到私钥文件: ' + abs);
        raw = fs.readFileSync(abs, 'utf8');
    } else {
        const env = process.env.UPDATE_SIGN_KEY || '';
        if (!env) fail('缺少私钥：用 --key <文件> 或设置环境变量 UPDATE_SIGN_KEY');
        raw = env.trim();
        if (raw[0] !== '{') {
            // base64 包装：CI secret 里存一整行更不容易被换行搞坏
            try {
                raw = Buffer.from(raw, 'base64').toString('utf8');
            } catch (_) {
                fail('UPDATE_SIGN_KEY 既不是 JSON 也不是合法 base64');
            }
        }
    }

    let jwk = null;
    try {
        jwk = JSON.parse(stripBom(raw).trim());
    } catch (_) {
        fail('私钥内容不是合法 JSON（应为 license-key.json 的原文或其 base64）');
    }
    if (!jwk || jwk.kty !== 'OKP' || jwk.crv !== 'Ed25519' || !jwk.d) {
        fail('私钥不是 Ed25519 JWK（需要 kty=OKP / crv=Ed25519 / x / d）');
    }
    try {
        return crypto.createPrivateKey({ key: jwk, format: 'jwk' });
    } catch (err) {
        fail('私钥加载失败: ' + ((err && err.message) || String(err)));
    }
}

function main() {
    const ymlPath = path.resolve(process.cwd(), arg('yml', path.join('dist', 'latest.yml')));
    if (!fs.existsSync(ymlPath)) fail('找不到清单文件: ' + ymlPath + '（先跑 electron-builder）');

    const text = stripBom(fs.readFileSync(ymlPath, 'utf8'));
    if (!/\bversion\s*:\s*\S/.test(text)) fail('latest.yml 里没有 version 字段，签了也没用');
    if (!/sha512\s*:/i.test(text)) fail('latest.yml 里没有 sha512 字段，签了也没用');

    const key = loadPrivateKey();
    const sig = crypto.sign(null, Buffer.from(text, 'utf8'), key);

    // 自检：签完立刻用自己的公钥验一遍，避免“签出来了但永远验不过”
    const pubJwk = key.export({ format: 'jwk' });
    const pub = crypto.createPublicKey({
        key: { kty: 'OKP', crv: 'Ed25519', x: pubJwk.x },
        format: 'jwk',
    });
    if (!crypto.verify(null, Buffer.from(text, 'utf8'), pub, sig)) {
        fail('自检失败：刚生成的签名无法通过验签');
    }

    const sigPath = ymlPath + '.sig';
    fs.writeFileSync(sigPath, sig.toString('base64'), 'utf8');

    const line = text.match(/^version:\s*['"]?([^'"\r\n]+)/m);
    console.log('[sign-update] 已签名：' + ymlPath);
    console.log('[sign-update] 签名文件：' + sigPath);
    console.log('[sign-update] 版本 = ' + (line ? line[1].trim() : '(未识别)'));
    console.log('[sign-update] 签名 = ' + sig.toString('base64').slice(0, 16) + '...(共 ' + sig.length + ' 字节)');
}

main();
