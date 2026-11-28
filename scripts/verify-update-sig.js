#!/usr/bin/env node
// 离线验签自检：确认“已经上传的那份 latest.yml 与 .sig 是配对的”
//
//   node scripts/verify-update-sig.js --yml dist/latest.yml --sig dist/latest.yml.sig
//   node scripts/verify-update-sig.js --yml dist/latest.yml --sig dist/latest.yml.sig --expect-version 2.1.0
//
// 用途：发布前 / 传完 COS 回读后跑一次。CI 里失败就中断发布，避免把
// “客户端永远拒绝”的坏清单推上线。
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
    console.error('[verify-update-sig] FAIL: ' + message);
    process.exit(1);
}

function stripBom(text) {
    return String(text).replace(/^\uFEFF/, '');
}

function loadPublicKey(pubPath) {
    const abs = path.resolve(process.cwd(), pubPath);
    if (!fs.existsSync(abs)) fail('找不到公钥配置: ' + abs);
    let cfg = null;
    try {
        cfg = JSON.parse(fs.readFileSync(abs, 'utf8'));
    } catch (_) {
        fail('公钥配置不是合法 JSON: ' + abs);
    }
    const raw = Buffer.from(String((cfg && cfg.update) || ''), 'base64');
    if (raw.length !== 32) fail('verify-pub.json 里的 update 公钥不是 32 字节');
    return crypto.createPublicKey({
        key: { kty: 'OKP', crv: 'Ed25519', x: raw.toString('base64url') },
        format: 'jwk',
    });
}

function main() {
    const ymlPath = path.resolve(process.cwd(), arg('yml', path.join('dist', 'latest.yml')));
    const sigPath = path.resolve(process.cwd(), arg('sig', ymlPath + '.sig'));
    const pubPath = arg('pub', path.join('protect', 'verify-pub.json'));
    const expectVersion = arg('expect-version', '');

    if (!fs.existsSync(ymlPath)) fail('找不到清单: ' + ymlPath);
    if (!fs.existsSync(sigPath)) fail('找不到签名文件: ' + sigPath);

    // 与客户端同口径：按去 BOM 的文本验签
    const text = stripBom(fs.readFileSync(ymlPath, 'utf8'));
    const sigBuf = Buffer.from(fs.readFileSync(sigPath, 'utf8').trim(), 'base64');
    if (sigBuf.length !== 64) fail('签名长度不是 64 字节（应为 base64 的 Ed25519 签名）');

    const pub = loadPublicKey(pubPath);
    let ok = false;
    try {
        ok = crypto.verify(null, Buffer.from(text, 'utf8'), pub, sigBuf);
    } catch (_) {
        ok = false;
    }
    if (!ok) fail('签名无法通过验签（清单被改过，或签名/公钥不匹配）');

    const m = text.match(/^version:\s*['"]?([^'"\r\n]+)/m);
    const version = m ? m[1].trim() : '';
    if (!version) fail('清单里没有 version');
    if (expectVersion && version !== expectVersion) {
        fail('版本不一致：清单=' + version + '，期望=' + expectVersion);
    }
    if (!/sha512\s*:/i.test(text)) fail('清单里没有 sha512，安装包无法校验');

    console.log('[verify-update-sig] OK');
    console.log('[verify-update-sig] 版本 = ' + version);
    console.log('[verify-update-sig] 清单 = ' + ymlPath);
}

main();
