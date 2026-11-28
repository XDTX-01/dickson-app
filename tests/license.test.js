// 授权（license.json）验签用例：直接跑 bootstrap.js 里的真实实现
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { test, assert, eq } = require('./_t');
const { extract, newKeyPair, tmpDir, rmrf, ROOT } = require('./_helpers');

const CHUNK = extract(
    'bootstrap.js',
    'function ed25519PublicKey',
    'let license = null;'
);

// 用给定公钥装载一段“源码原样”的验签逻辑（缺的依赖全部显式注入）
// verifyPub 就是 verify-pub.json 的内容：传进去的公钥 = 客户端 bundle 里那份
function loadVerify(publicKeyB64, machineId) {
    const code = CHUNK + '\nreturn { ed25519PublicKey, verifyLicenseDoc, licensePubKey };';
    const fn = new Function('crypto', 'fs', 'path', 'app', 'native', 'verifyPub', code);
    const native = { machineId: () => machineId || '' };
    const app = { getPath: () => path.join(require('os').tmpdir(), 'lic-test-userdata') };
    const verifyPub = { alg: 'ed25519', license: publicKeyB64, update: '', requireLicense: false };
    return fn(crypto, fs, path, app, native, verifyPub);
}

function makeDoc(privateKey, fields) {
    const payload = JSON.stringify(fields || {});
    const sig = crypto.sign(null, Buffer.from(payload, 'utf8'), privateKey).toString('base64');
    return { payload: payload, sig: sig };
}

function fields(overrides) {
    return Object.assign(
        { v: 1, customer: '测试客户', expireAt: Date.now() + 86400000, issuedAt: Date.now(), machineId: '' },
        overrides || {}
    );
}

test('授权：公钥 base64 解码成 32 字节 JWK 才能加载', () => {
    const kp = newKeyPair();
    const api = loadVerify(kp.pubB64);
    assert(api.licensePubKey, '公钥应为有效 KeyObject');
});

test('授权：非法长度公钥被拒绝（返回 null 而不是抛错）', () => {
    const api = loadVerify(Buffer.alloc(16).toString('base64'));
    assert(api.licensePubKey === null, '16 字节公钥应视为无效');
});

test('授权：合法签名 → 返回 expireAt 与 customer', () => {
    const kp = newKeyPair();
    const api = loadVerify(kp.pubB64);
    const f = fields({ expireAt: 1861891199000 });
    const res = api.verifyLicenseDoc(makeDoc(kp.privateKey, f));
    assert(res, '应验签通过');
    eq(res.expireAt, 1861891199000, 'expireAt');
    eq(res.customer, '测试客户', 'customer');
});

test('授权：payload 改一个字符即失效', () => {
    const kp = newKeyPair();
    const api = loadVerify(kp.pubB64);
    const doc = makeDoc(kp.privateKey, fields());
    doc.payload = doc.payload.replace('测试客户', '另一个客户');
    assert(api.verifyLicenseDoc(doc) === null, '被改过的 payload 必须拒绝');
});

test('授权：换签名（截断）失效', () => {
    const kp = newKeyPair();
    const api = loadVerify(kp.pubB64);
    const doc = makeDoc(kp.privateKey, fields());
    doc.sig = doc.sig.slice(0, 40);
    assert(api.verifyLicenseDoc(doc) === null, '签名长度不对必须拒绝');
});

test('授权：其它密钥对签的授权失效', () => {
    const kp = newKeyPair();
    const other = newKeyPair();
    const api = loadVerify(kp.pubB64);
    assert(api.verifyLicenseDoc(makeDoc(other.privateKey, fields())) === null, '别的私钥签的必须拒绝');
});

test('授权：v 不等于 1 拒绝', () => {
    const kp = newKeyPair();
    const api = loadVerify(kp.pubB64);
    assert(api.verifyLicenseDoc(makeDoc(kp.privateKey, fields({ v: 2 }))) === null, '版本号不支持必须拒绝');
});

test('授权：expireAt 非法（0 / 负数 / 非数字）拒绝', () => {
    const kp = newKeyPair();
    const api = loadVerify(kp.pubB64);
    for (const bad of [0, -1, 'abc']) {
        assert(
            api.verifyLicenseDoc(makeDoc(kp.privateKey, fields({ expireAt: bad }))) === null,
            'expireAt=' + bad + ' 必须拒绝'
        );
    }
});

test('授权：payload 不是合法 JSON 拒绝', () => {
    const kp = newKeyPair();
    const api = loadVerify(kp.pubB64);
    const payload = '{不是JSON';
    const sig = crypto.sign(null, Buffer.from(payload, 'utf8'), kp.privateKey).toString('base64');
    assert(api.verifyLicenseDoc({ payload: payload, sig: sig }) === null, 'payload 解析失败必须拒绝');
});

test('授权：数组形式的 payload 拒绝', () => {
    const kp = newKeyPair();
    const api = loadVerify(kp.pubB64);
    const payload = '[1,2,3]';
    const sig = crypto.sign(null, Buffer.from(payload, 'utf8'), kp.privateKey).toString('base64');
    assert(api.verifyLicenseDoc({ payload: payload, sig: sig }) === null, '数组 payload 必须拒绝');
});

test('授权：缺 payload / sig 字段拒绝', () => {
    const kp = newKeyPair();
    const api = loadVerify(kp.pubB64);
    assert(api.verifyLicenseDoc(null) === null, 'null 文件');
    assert(api.verifyLicenseDoc({}) === null, '空对象');
    assert(api.verifyLicenseDoc({ payload: '{}' }) === null, '缺 sig');
    assert(api.verifyLicenseDoc({ sig: 'AAAA' }) === null, '缺 payload');
});

test('授权：机器绑定 —— 机器码一致时通过', () => {
    const kp = newKeyPair();
    const api = loadVerify(kp.pubB64, 'deadbeefdeadbeefdeadbeefdeadbeef');
    const res = api.verifyLicenseDoc(
        makeDoc(kp.privateKey, fields({ machineId: 'deadbeefdeadbeefdeadbeefdeadbeef' }))
    );
    assert(res && res.expireAt > 0, '机器码一致应通过');
});

test('授权：机器绑定 —— 机器码不一致时拒绝', () => {
    const kp = newKeyPair();
    const api = loadVerify(kp.pubB64, 'otherotherotherotherotherotherother');
    assert(
        api.verifyLicenseDoc(makeDoc(kp.privateKey, fields({ machineId: 'deadbeefdeadbeefdeadbeefdeadbeef' }))) === null,
        '机器码不一致必须拒绝'
    );
});

test('授权：机器绑定 —— 本机取不到机器码时拒绝', () => {
    const kp = newKeyPair();
    const api = loadVerify(kp.pubB64, '');
    assert(
        api.verifyLicenseDoc(makeDoc(kp.privateKey, fields({ machineId: 'anyidanyidanyidanyidanyidanyid00' }))) === null,
        '本机无机器码时不能放行'
    );
});

test('授权：无公钥时任何授权都不通过（fail-closed）', () => {
    const api = loadVerify('');
    assert(api.licensePubKey === null, '空公钥应为 null');
    const kp = newKeyPair();
    assert(api.verifyLicenseDoc(makeDoc(kp.privateKey, fields())) === null, '空公钥必须全部拒绝');
});

test('授权：license.json 带 BOM 时按无效处理（JSON.parse 失败 → null）', () => {
    const kp = newKeyPair();
    const api = loadVerify(kp.pubB64);
    const dir = tmpDir('lic-bom');
    try {
        const file = path.join(dir, 'license.json');
        const doc = makeDoc(kp.privateKey, fields());
        fs.writeFileSync(file, '\uFEFF' + JSON.stringify(doc), 'utf8');
        // 复刻 bootstrap 的 readLicenseDoc 行为：解析失败返回 null（不一致就当没有授权）
        let parsed = null;
        try {
            parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
        } catch (_) {
            parsed = null;
        }
        assert(parsed === null, '带 BOM 的 JSON 应解析失败');
        assert(api.verifyLicenseDoc(parsed) === null, '解析失败的文档按无授权处理');
    } finally {
        rmrf(dir);
    }
});

test('授权：verify-pub.json 结构合法（公钥要么空、要么 32 字节）', () => {
    const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'protect', 'verify-pub.json'), 'utf8'));
    eq(cfg.alg, 'ed25519', 'alg');
    eq(typeof cfg.requireLicense, 'boolean', 'requireLicense 必须是布尔值');
    for (const field of ['license', 'update']) {
        const raw = Buffer.from(String(cfg[field] || ''), 'base64');
        // 出厂允许为空（还没跑 licgen init），但一旦写了就必须是 32 字节的 Ed25519 公钥，
        // 否则验签侧会拿着一个形状不对的 key 一直失败（CI 上就踩过这个：报"公钥不是 32 字节"）
        assert(raw.length === 0 || raw.length === 32, field + ' 公钥长度必须是 0 或 32，实际 ' + raw.length);
    }
});
