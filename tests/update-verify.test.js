// 更新清单验签用例：跑 main.js 里真实的 manifest 解析 / 签名校验 / 安装包哈希比对
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { test, assert, eq } = require('./_t');
const { extract, newKeyPair, tmpDir, rmrf } = require('./_helpers');

// 抽出 main.js 中从验签配置到实例池之前的一整段（真源码，不是复制品）
const CHUNK = extract(
    'main.js',
    'const UPDATE_SIGN_CONFIG_PATH',
    '// ------------------------- updater 实例池（并发的基础）'
);

function loadVerifyUpdate(opts) {
    const dir = tmpDir('update-sig');
    const kp = newKeyPair();
    const publicKeyB64 = opts && opts.emptyKey ? '' : kp.pubB64;
    fs.mkdirSync(path.join(dir, 'protect'), { recursive: true });
    fs.writeFileSync(
        path.join(dir, 'protect', 'verify-pub.json'),
        JSON.stringify({ alg: 'ed25519', license: publicKeyB64, update: publicKeyB64, requireLicense: false }),
        'utf8'
    );

    // main.js 里这段代码引用了几个模块级变量，这里补上同名声明，避免抽出来执行时 ReferenceError
    const pre =
        'let activeSource = null;\n' +
        'const pendingUpdate = { version: "" };\n';
    const post =
        '\nreturn {' +
        ' parseLatestYml: parseLatestYml,' +
        ' verifyDownloadedInstaller: verifyDownloadedInstaller,' +
        ' signedManifestCache: signedManifestCache,' +
        ' fileSha512Base64: fileSha512Base64,' +
        ' setSource: function (s) { activeSource = s; },' +
        ' setPendingVersion: function (v) { pendingUpdate.version = v; }' +
        ' };';
    const fn = new Function(
        'crypto',
        'path',
        'fsSync',
        'fetch',
        'writeCrashLog',
        'sourceKey',
        '__dirname',
        pre + CHUNK + post
    );

    const fetchImpl = (opts && opts.fetch) || (() => Promise.reject(new Error('no fetch')));
    const api = fn(
        crypto,
        path,
        fs,
        fetchImpl,
        () => {},
        (source) =>
            source
                ? source.provider === 'generic'
                    ? 'generic:' + source.url
                    : 'github:' + source.owner + '/' + source.repo
                : '',
        dir
    );
    api.__dir = dir;
    api.__keyPair = kp;
    api.__cleanup = () => rmrf(dir);
    return api;
}

function signText(privateKey, text) {
    return crypto.sign(null, Buffer.from(text, 'utf8'), privateKey).toString('base64');
}

function latestYml(version, fileName, sha512) {
    return [
        'version: ' + version,
        'files:',
        '  - url: ' + fileName,
        '    sha512: ' + sha512,
        '    size: 12345',
        'path: ' + fileName,
        'sha512: ' + sha512,
        'releaseDate: \'2026-11-28T10:00:00.000Z\'',
        '',
    ].join('\n');
}

function fakeFetch(map) {
    return (url, init) => {
        const key = Object.keys(map).find((k) => url.endsWith(k));
        if (!key) return Promise.resolve({ ok: false, status: 404, text: () => Promise.resolve('') });
        return Promise.resolve({
            ok: true,
            status: 200,
            text: () => Promise.resolve(map[key]),
        });
    };
}

// 造一个真实的临时“安装包”，返回路径与它真实的 sha512
function makeInstaller(content) {
    const dir = tmpDir('installer');
    const file = path.join(dir, 'dickson-color-studio-Setup-1.2.3.exe');
    fs.writeFileSync(file, content);
    const sha = crypto.createHash('sha512').update(content).digest('base64');
    return { file, sha, dir };
}

test('清单解析：version / path / files 全部识别', () => {
    const api = loadVerifyUpdate();
    try {
        const parsed = api.parseLatestYml(latestYml('1.2.3', 'a.exe', 'AAAA'));
        eq(parsed.version, '1.2.3', 'version');
        eq(parsed.path, 'a.exe', 'path');
        eq(parsed.files.length, 1, 'files 数量');
        eq(parsed.files[0].name, 'a.exe', 'files[0].name');
        eq(parsed.files[0].sha512, 'AAAA', 'files[0].sha512');
    } finally {
        api.__cleanup();
    }
});

test('清单解析：带 BOM 也能解析（Windows 另存常见）', () => {
    const api = loadVerifyUpdate();
    try {
        const parsed = api.parseLatestYml('\uFEFF' + latestYml('9.9.9', 'b.exe', 'BBBB'));
        eq(parsed.version, '9.9.9', '带 BOM 的 version');
    } finally {
        api.__cleanup();
    }
});

test('清单解析：空字符串 / 垃圾内容不抛错，返回空结构', () => {
    const api = loadVerifyUpdate();
    try {
        eq(api.parseLatestYml(''), { version: '', path: '', sha512: '', files: [] }, '空串');
        eq(api.parseLatestYml('hello'), { version: '', path: '', sha512: '', files: [] }, '垃圾内容');
    } finally {
        api.__cleanup();
    }
});

test('更新校验：无 update 公钥时跳过（保持老版本行为）', async () => {
    const api = loadVerifyUpdate({ emptyKey: true });
    try {
        const res = await api.verifyDownloadedInstaller({ path: '/nope.exe', version: '1.0.0' });
        eq(res, { ok: true, skipped: true }, '空公钥应 skipped');
    } finally {
        api.__cleanup();
    }
});

test('更新校验：签名正确 + 哈希匹配 → ok', async () => {
    const inst = makeInstaller(Buffer.from('installer-payload'));
    const src = { provider: 'generic', url: 'https://example.com/app-update' };
    // 先建 api（此时才知道它的测试密钥对），再让 fetch 用这对密钥签清单
    const holder = { api: null };
    const api = loadVerifyUpdate({
        fetch: (url) => {
            const yml = latestYml('1.2.3', path.basename(inst.file), inst.sha);
            const sig = signText(holder.api.__keyPair.privateKey, yml);
            if (url.endsWith('latest.yml.sig')) return Promise.resolve({ ok: true, status: 200, text: () => Promise.resolve(sig) });
            if (url.endsWith('latest.yml')) return Promise.resolve({ ok: true, status: 200, text: () => Promise.resolve(yml) });
            return Promise.resolve({ ok: false, status: 404, text: () => Promise.resolve('') });
        },
    });
    holder.api = api;
    try {
        api.setSource(src);
        const res = await api.verifyDownloadedInstaller({ path: inst.file, version: '1.2.3' });
        assert(res.ok === true, '应通过：' + JSON.stringify(res));
    } finally {
        api.__cleanup();
        rmrf(inst.dir);
    }
});

test('更新校验：签名被改 → 拒绝', async () => {
    const inst = makeInstaller(Buffer.from('payload-2'));
    const api = loadVerifyUpdate({
        fetch: (url) => {
            const yml = latestYml('1.0.0', path.basename(inst.file), inst.sha);
            if (url.endsWith('latest.yml')) return Promise.resolve({ ok: true, status: 200, text: () => Promise.resolve(yml) });
            // 签名内容换掉一个字节
            return Promise.resolve({ ok: true, status: 200, text: () => Promise.resolve(Buffer.alloc(64, 1).toString('base64')) });
        },
    });
    try {
        api.setSource({ provider: 'generic', url: 'https://example.com/app-update' });
        const res = await api.verifyDownloadedInstaller({ path: inst.file, version: '1.0.0' });
        assert(res.ok === false, '签名不符必须拒绝');
        assert(/清单/.test(res.reason), '原因应指向清单，实际: ' + res.reason);
    } finally {
        api.__cleanup();
        rmrf(inst.dir);
    }
});

test('更新校验：清单签名正确但安装包被替换（哈希不符）→ 拒绝', async () => {
    const inst = makeInstaller(Buffer.from('good-installer'));
    // 清单登记的是另一个哈希（模拟攻击者换了包但只有旧清单）
    const wrongSha = crypto.createHash('sha512').update('evil').digest('base64');
    let api = null;
    api = loadVerifyUpdate({
        fetch: (url) => {
            if (url.endsWith('latest.yml')) {
                const yml = latestYml('1.0.0', path.basename(inst.file), wrongSha);
                const sig = signText(api.__keyPair.privateKey, yml);
                return Promise.resolve({ ok: true, status: 200, text: () => Promise.resolve(yml) });
            }
            const yml = latestYml('1.0.0', path.basename(inst.file), wrongSha);
            return Promise.resolve({ ok: true, status: 200, text: () => Promise.resolve(signText(api.__keyPair.privateKey, yml)) });
        },
    });
    try {
        api.setSource({ provider: 'generic', url: 'https://example.com/app-update' });
        const res = await api.verifyDownloadedInstaller({ path: inst.file, version: '1.0.0' });
        assert(res.ok === false, '哈希不符必须拒绝');
        assert(/哈希/.test(res.reason), '原因应指向哈希，实际: ' + res.reason);
    } finally {
        api.__cleanup();
        rmrf(inst.dir);
    }
});

test('更新校验：清单版本与下载版本不一致 → 拒绝', async () => {
    const inst = makeInstaller(Buffer.from('v3'));
    let api = null;
    api = loadVerifyUpdate({
        fetch: (url) => {
            const yml = latestYml('9.0.0', path.basename(inst.file), inst.sha);
            if (url.endsWith('latest.yml')) return Promise.resolve({ ok: true, status: 200, text: () => Promise.resolve(yml) });
            return Promise.resolve({ ok: true, status: 200, text: () => Promise.resolve(signText(api.__keyPair.privateKey, yml)) });
        },
    });
    try {
        api.setSource({ provider: 'generic', url: 'https://example.com/app-update' });
        const res = await api.verifyDownloadedInstaller({ path: inst.file, version: '1.0.0' });
        assert(res.ok === false, '版本不一致必须拒绝');
        assert(/版本/.test(res.reason), '原因应指向版本，实际: ' + res.reason);
    } finally {
        api.__cleanup();
        rmrf(inst.dir);
    }
});

test('更新校验：清单里没登记这个包 → 拒绝', async () => {
    const inst = makeInstaller(Buffer.from('v4'));
    // 清单登记两个别的文件（多于一个时才不会有“只有一个就当成它”的兜底），本次下载的包名不在其中
    const ymlText = [
        'version: 1.0.0',
        'files:',
        '  - url: another-setup.exe',
        '    sha512: ' + inst.sha,
        '    size: 111',
        '  - url: third-setup.exe',
        '    sha512: ' + inst.sha,
        '    size: 222',
        'path: another-setup.exe',
        'sha512: ' + inst.sha,
        '',
    ].join('\n');
    const holder = { api: null };
    const api = loadVerifyUpdate({
        fetch: (url) => {
            const sig = signText(holder.api.__keyPair.privateKey, ymlText);
            if (url.endsWith('latest.yml.sig')) return Promise.resolve({ ok: true, status: 200, text: () => Promise.resolve(sig) });
            return Promise.resolve({ ok: true, status: 200, text: () => Promise.resolve(ymlText) });
        },
    });
    holder.api = api;
    try {
        api.setSource({ provider: 'generic', url: 'https://example.com/app-update' });
        const res = await api.verifyDownloadedInstaller({ path: inst.file, version: '1.0.0' });
        assert(res.ok === false, '未登记的包必须拒绝');
        assert(/没有登记/.test(res.reason), '原因应指出未登记，实际: ' + res.reason);
    } finally {
        api.__cleanup();
        rmrf(inst.dir);
    }
});

test('更新校验：源上没有 .sig（404 场景）→ 拒绝而不是放行', async () => {
    const inst = makeInstaller(Buffer.from('v5'));
    const api = loadVerifyUpdate({ fetch: fakeFetch({}) });
    try {
        api.setSource({ provider: 'generic', url: 'https://example.com/app-update' });
        const res = await api.verifyDownloadedInstaller({ path: inst.file, version: '1.0.0' });
        assert(res.ok === false, '没有可验证清单时必须拒绝（fail-closed）');
    } finally {
        api.__cleanup();
        rmrf(inst.dir);
    }
});

test('更新校验：文件不存在时给出读取失败原因', async () => {
    let api = null;
    api = loadVerifyUpdate({
        fetch: (url) => {
            const yml = latestYml('1.0.0', 'x.exe', 'ZZZ');
            if (url.endsWith('latest.yml')) return Promise.resolve({ ok: true, status: 200, text: () => Promise.resolve(yml) });
            return Promise.resolve({ ok: true, status: 200, text: () => Promise.resolve(signText(api.__keyPair.privateKey, yml)) });
        },
    });
    try {
        api.setSource({ provider: 'generic', url: 'https://example.com/app-update' });
        const res = await api.verifyDownloadedInstaller({ path: path.join(api.__dir, 'missing.exe'), version: '1.0.0' });
        assert(res.ok === false, '文件缺失必须拒绝');
        assert(/读取安装包失败/.test(res.reason), '原因应指向读取失败，实际: ' + res.reason);
    } finally {
        api.__cleanup();
    }
});

test('更新校验：github 源拼出的清单地址是 releases/latest/download', async () => {
    // 通过 fetch 收到的 URL 反查拼接规则
    const seen = [];
    const inst = makeInstaller(Buffer.from('v6'));
    let api = null;
    api = loadVerifyUpdate({
        fetch: (url) => {
            seen.push(url);
            const yml = latestYml('1.0.0', path.basename(inst.file), inst.sha);
            if (url.endsWith('latest.yml')) return Promise.resolve({ ok: true, status: 200, text: () => Promise.resolve(yml) });
            return Promise.resolve({ ok: true, status: 200, text: () => Promise.resolve(signText(api.__keyPair.privateKey, yml)) });
        },
    });
    try {
        api.setSource({ provider: 'github', owner: 'XDTX-01', repo: 'dickson-app' });
        await api.verifyDownloadedInstaller({ path: inst.file, version: '1.0.0' });
        assert(
            seen.some((u) => u === 'https://github.com/XDTX-01/dickson-app/releases/latest/download/latest.yml'),
            'github 清单地址不对: ' + seen.join(', ')
        );
        assert(
            seen.some((u) => u === 'https://github.com/XDTX-01/dickson-app/releases/latest/download/latest.yml.sig'),
            'github 签名地址不对: ' + seen.join(', ')
        );
    } finally {
        api.__cleanup();
        rmrf(inst.dir);
    }
});
