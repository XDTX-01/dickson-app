#!/usr/bin/env node
// 授权签发工具（离线运行，绝不进 CI）
//
//   node scripts/licgen.js init   [--key license-key.json] [--pub protect/verify-pub.json]
//   node scripts/licgen.js mid                     # 打印本机机器码（要在客户机器上跑）
//   node scripts/licgen.js issue  --customer "某某家具" --expire 2028-12-31 [--machine <mid>] [--out license.json]
//   node scripts/licgen.js verify --license license.json [--pub protect/verify-pub.json]
//
// 关键点：签名用的私钥只在 init 时生成一次，之后所有签发都用它；
// 一旦丢失，已发出的授权无法续签，只能换密钥对 + 全量重发新包。所以第一次 init
// 之后必须把 license-key.json 离线备份（U 盘 / 密码管理器），不要提交到 Git。
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

const root = path.join(__dirname, '..');

function arg(name, fallback) {
    const idx = process.argv.indexOf('--' + name);
    if (idx === -1) return fallback;
    const value = process.argv[idx + 1];
    if (value === undefined || value.startsWith('--')) return fallback;
    return value;
}

function fail(message) {
    console.error('[licgen] ERROR: ' + message);
    process.exit(1);
}

function b64urlToBuf(s) {
    return Buffer.from(String(s).replace(/-/g, '+').replace(/_/g, '/'), 'base64');
}

// 与 protect.cc 里的 computeMachineId 保持逐字一致：
// sha256("dickson-mid:" + MachineGuid 原始字符串) 的前 32 个 hex 字符
function machineIdFromGuid(guid) {
    return crypto
        .createHash('sha256')
        .update('dickson-mid:' + String(guid || '').trim())
        .digest('hex')
        .slice(0, 32);
}

function readMachineGuid() {
    if (process.platform !== 'win32') fail('机器码只能在 Windows 上读取（本机为 ' + process.platform + '）');
    let out = '';
    try {
        out = execFileSync(
            'reg',
            ['query', 'HKLM\\SOFTWARE\\Microsoft\\Cryptography', '/v', 'MachineGuid'],
            { encoding: 'utf8', windowsHide: true }
        );
    } catch (err) {
        fail('读取 MachineGuid 失败: ' + ((err && err.message) || String(err)));
    }
    const m = out.match(/MachineGuid\s+REG_SZ\s+([0-9a-fA-F-]+)/);
    if (!m) fail('MachineGuid 解析失败，请确认注册表项存在');
    return machineIdFromGuid(m[1]);
}

function loadPrivateKey(keyPath) {
    if (!fs.existsSync(keyPath)) fail('找不到私钥文件: ' + keyPath + '（先执行 init）');
    let jwk = null;
    try {
        jwk = JSON.parse(fs.readFileSync(keyPath, 'utf8'));
    } catch (_) {
        fail('私钥文件不是合法 JSON: ' + keyPath);
    }
    // createPrivateKey 要求完整 JWK：缺 kty:"OKP" 会直接报 ERR_INVALID_ARG_VALUE
    if (!jwk || jwk.kty !== 'OKP' || jwk.crv !== 'Ed25519' || !jwk.d) {
        fail('私钥不是 Ed25519 JWK（需要 kty=OKP / crv=Ed25519 / x / d）');
    }
    try {
        return crypto.createPrivateKey({ key: jwk, format: 'jwk' });
    } catch (err) {
        fail('私钥加载失败: ' + ((err && err.message) || String(err)));
    }
}

function publicKeyB64(keyObject) {
    const jwk = keyObject.export({ format: 'jwk' });
    return b64urlToBuf(jwk.x).toString('base64');
}

function parseExpire(expireArg, daysArg) {
    if (daysArg) {
        const days = Number(daysArg);
        if (!isFinite(days) || days <= 0) fail('--days 必须是正整数');
        return Date.now() + Math.round(days) * 24 * 3600 * 1000;
    }
    if (!expireArg) return 0;
    const m = String(expireArg).match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (!m) fail('--expire 格式必须是 YYYY-MM-DD');
    // 到期时刻统一取当天 23:59:59（+08:00），避免不同机器时区导致“还没到期就过期”
    const ms = Date.parse(m[1] + '-' + m[2] + '-' + m[3] + 'T23:59:59+08:00');
    if (!isFinite(ms)) fail('--expire 不是合法日期');
    return ms;
}

function cmdInit() {
    const keyPath = path.resolve(root, arg('key', 'license-key.json'));
    const pubPath = path.resolve(root, arg('pub', 'protect/verify-pub.json'));

    let pubB64 = '';
    if (fs.existsSync(keyPath)) {
        // 已有私钥：不覆盖，只把公钥同步进 verify-pub.json（换机器后恢复用）
        const keyObject = loadPrivateKey(keyPath);
        pubB64 = publicKeyB64(keyObject);
        console.log('[licgen] 已存在私钥，未重新生成：' + keyPath);
    } else {
        const pair = crypto.generateKeyPairSync('ed25519');
        const jwk = pair.privateKey.export({ format: 'jwk' });
        fs.writeFileSync(keyPath, JSON.stringify(jwk, null, 2), { encoding: 'utf8', mode: 0o600 });
        pubB64 = publicKeyB64(pair.publicKey);
        console.log('[licgen] 已生成新密钥对：' + keyPath);
    }

    let cfg = { alg: 'ed25519', license: pubB64, update: pubB64, requireLicense: false };
    if (fs.existsSync(pubPath)) {
        try {
            cfg = Object.assign(cfg, JSON.parse(fs.readFileSync(pubPath, 'utf8')));
        } catch (_) {}
        cfg.alg = 'ed25519';
        cfg.license = pubB64;
        cfg.update = pubB64;
    }
    fs.mkdirSync(path.dirname(pubPath), { recursive: true });
    fs.writeFileSync(pubPath, JSON.stringify(cfg, null, 2), 'utf8');
    console.log('[licgen] 公钥已写入：' + pubPath);
    console.log('[licgen] 公钥(base64) = ' + pubB64);
    console.log('[licgen] 提醒：license-key.json 是唯一私钥，务必离线备份，不要提交到仓库');
}

function cmdMid() {
    console.log(readMachineGuid());
}

function cmdIssue() {
    const keyPath = path.resolve(root, arg('key', 'license-key.json'));
    const outPath = path.resolve(root, arg('out', 'license.json'));
    const customer = arg('customer', '');
    const expireMs = parseExpire(arg('expire', ''), arg('days', ''));
    if (!expireMs) fail('必须指定 --expire YYYY-MM-DD 或 --days N');
    if (expireMs <= Date.now()) fail('到期时间必须晚于当前时间');

    let machine = arg('machine', '');
    if (machine === 'auto') machine = readMachineGuid();

    const keyObject = loadPrivateKey(keyPath);

    // payload 字段顺序固定（v / customer / expireAt / issuedAt / machineId），
    // 签名对象就是这串文本本身：客户端解析后逐字节验签，任何改动都会失败
    const payload = JSON.stringify({
        v: 1,
        customer: customer,
        expireAt: Math.round(expireMs),
        issuedAt: Date.now(),
        machineId: machine,
    });
    const sig = crypto.sign(null, Buffer.from(payload, 'utf8'), keyObject).toString('base64');

    const doc = { payload: payload, sig: sig };
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.writeFileSync(outPath, JSON.stringify(doc, null, 2), 'utf8');

    console.log('[licgen] 授权已生成：' + outPath);
    console.log('[licgen] 客户 = ' + (customer || '(未填)'));
    console.log('[licgen] 到期 = ' + new Date(expireMs).toISOString() + ' (' + Math.round(expireMs) + ')');
    console.log('[licgen] 机器 = ' + (machine || '不绑定（任意机器可用）'));
}

function cmdVerify() {
    const licensePath = path.resolve(root, arg('license', 'license.json'));
    const pubPath = path.resolve(root, arg('pub', 'protect/verify-pub.json'));
    if (!fs.existsSync(licensePath)) fail('找不到授权文件: ' + licensePath);
    if (!fs.existsSync(pubPath)) fail('找不到公钥配置: ' + pubPath);

    const cfg = JSON.parse(fs.readFileSync(pubPath, 'utf8'));
    const raw = Buffer.from(String(cfg.license || ''), 'base64');
    if (raw.length !== 32) fail('verify-pub.json 里的 license 公钥不是 32 字节');
    const pubKey = crypto.createPublicKey({
        key: { kty: 'OKP', crv: 'Ed25519', x: raw.toString('base64url') },
        format: 'jwk',
    });

    let doc = null;
    try {
        doc = JSON.parse(fs.readFileSync(licensePath, 'utf8'));
    } catch (_) {
        fail('授权文件不是合法 JSON');
    }
    if (!doc || typeof doc.payload !== 'string' || typeof doc.sig !== 'string') {
        fail('授权结构不正确（需要 payload / sig）');
    }
    const sigBuf = Buffer.from(doc.sig, 'base64');
    if (sigBuf.length !== 64) fail('签名长度不是 64 字节');

    let ok = false;
    try {
        ok = crypto.verify(null, Buffer.from(doc.payload, 'utf8'), pubKey, sigBuf);
    } catch (_) {
        ok = false;
    }
    if (!ok) fail('签名校验失败（授权被改过，或用的是别的密钥对）');

    const fields = JSON.parse(doc.payload);
    const expireAt = Number(fields.expireAt);
    if (!isFinite(expireAt) || expireAt <= 0) fail('payload 里的 expireAt 不合法');
    if (expireAt <= Date.now()) fail('授权已过期：' + new Date(expireAt).toISOString());

    console.log('[licgen] 签名有效');
    console.log('[licgen] 客户 = ' + (fields.customer || '(未填)'));
    console.log('[licgen] 到期 = ' + new Date(expireAt).toISOString());
    console.log('[licgen] 机器 = ' + (fields.machineId || '不绑定'));
}

const cmd = process.argv[2] || '';
if (cmd === 'init') cmdInit();
else if (cmd === 'mid') cmdMid();
else if (cmd === 'issue') cmdIssue();
else if (cmd === 'verify') cmdVerify();
else {
    console.error('用法：');
    console.error('  node scripts/licgen.js init   [--key license-key.json] [--pub protect/verify-pub.json]');
    console.error('  node scripts/licgen.js mid');
    console.error('  node scripts/licgen.js issue  --customer "客户名" --expire 2028-12-31 [--machine <mid>] [--days N] [--out license.json]');
    console.error('  node scripts/licgen.js verify --license license.json');
    process.exit(1);
}
