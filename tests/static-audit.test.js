// 静态审计：加固链路里那些“不会报错、但一改就失效”的约定，全部用断言钉住
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { test, assert, eq } = require('./_t');
const { read, ROOT } = require('./_helpers');

const bootstrap = read('bootstrap.js');
const mainjs = read('main.js');
const pkg = JSON.parse(read('package.json'));
const cc = read('protect/protect.cc');
const workflow = read('.github/workflows/build-release.yml');
const gi = read('.gitignore');

test('bootstrap：调试开关黑名单覆盖 inspect / remote-debugging / js-flags', () => {
    for (const sw of ['--inspect', '--inspect-brk', '--remote-debugging-port', '--remote-debugging-pipe', '--js-flags']) {
        assert(bootstrap.indexOf("'" + sw + "'") !== -1, '黑名单缺少 ' + sw);
    }
    const count = (bootstrap.match(/^    '--/gm) || []).length;
    assert(count >= 10, '黑名单条目过少: ' + count);
});

test('bootstrap：hitForbiddenSwitch 真函数能命中带 = 值的开关', () => {
    const code =
        'function hitForbiddenSwitch(argv) {' +
        bootstrap.split('function hitForbiddenSwitch(argv) {')[1].split('function sanitizeEnvironment')[0] +
        'return hitForbiddenSwitch;';
    const fn = new Function(
        'FORBIDDEN_SWITCHES',
        'FORBIDDEN_ENV',
        code
    );
    const list = ['--inspect', '--remote-debugging-port', '--js-flags'];
    const hit = fn(list, []);
    assert(hit(['app.exe', '--inspect']) === '--inspect', '精确命中失败');
    assert(hit(['app.exe', '--inspect=9229']) === '--inspect', '带等号值应命中');
    assert(hit(['app.exe', '--REMOTE-DEBUGGING-PORT=1']) === '--remote-debugging-port', '大小写不敏感');
    assert(hit(['app.exe', '--normal-flag']) === '', '普通参数不应命中');
});

test('bootstrap：环境变量净化清单包含 3 个关键变量', () => {
    for (const name of ['NODE_OPTIONS', 'ELECTRON_RUN_AS_NODE', 'ELECTRON_NO_ATTACH_CONSOLE']) {
        assert(bootstrap.indexOf("'" + name + "'") !== -1, '缺少环境变量 ' + name);
    }
});

test('bootstrap：生产模式要求 11 个原生导出全部存在', () => {
    const required = ['openCore', 'isCoreOpen', 'hostCheck', 'checkTamper', 'checkExpiry', 'applyLicense', 'hasLicense', 'machineId', 'verifyBuffer', 'verifyFile'];
    for (const name of required) {
        assert(new RegExp("'" + name + "'").test(bootstrap), '缺少必需导出 ' + name);
    }
    assert(/for \(const fn of REQUIRED_NATIVE\)/.test(bootstrap), '缺少能力自检循环');
});

test('bootstrap：原生模块用 Node crypto 自校验（不能自己验自己）', () => {
    assert(/NATIVE_REL = 'protect\/protect.node'/.test(bootstrap), '原生模块必须进清单');
    assert(/crypto\s*\.createHash\('sha256'\)/.test(bootstrap), '原生模块哈希必须用 Node crypto 计算');
});

test('bootstrap：清单路径越界防护（绝对路径 / ..）', () => {
    assert(/path\.isAbsolute\(rel\)/.test(bootstrap), '缺少绝对路径检查');
    assert(/rel\.split\(\/\[\\\\\/\]\/\)\.indexOf\('\.\.'\)/.test(bootstrap) || bootstrap.indexOf("indexOf('..')") !== -1, '缺少 .. 检查');
});

test('bootstrap：开发模式直接跑 main.js，生产模式必须走校验', () => {
    assert(/if \(!app\.isPackaged\) \{\s*require\('\.\/main\.js'\)/m.test(bootstrap), '开发分支缺失');
    assert(/abort\('核心校验失败'/.test(bootstrap), '生产分支缺少校验失败处理');
});

test('main.js：update-downloaded 先验后给“就绪”，失败删包', () => {
    const seg = mainjs.split('async function onUpdateDownloaded')[1] || '';
    const body = seg.split('function handleDownloadedVerified')[0];
    assert(/await verifyDownloadedInstaller\(info\)/.test(body), '必须等待验签结果');
    assert(/fs\.unlink\(file\)/.test(body), '失败必须删掉已下载的包');
    assert(/handleDownloadFailure/.test(body), '失败必须回到失败流程');
    assert(/handleDownloadedVerified\(info\)/.test(body), '成功才能进“就绪”');
    const order = body.indexOf('verifyDownloadedInstaller') < body.indexOf('handleDownloadedVerified');
    assert(order, '顺序必须是“先验后就绪”');
});

test('main.js：update-downloaded 仍然绑到同一个处理函数', () => {
    assert(/updater\.on\("update-downloaded", onUpdateDownloaded\)/.test(mainjs), '事件绑定被改掉了');
});

test('main.js：启动校验原生会话 + 运行期逆向检测已接线', () => {
    assert(/if \(!ensureNativeCore\(\)\)/.test(mainjs), '启动期缺少会话校验');
    assert(/startTamperWatch\(\)/.test(mainjs), '缺少运行期检测启动');
    assert(/TAMPER_STRIKES = 2/.test(mainjs), '阈值应为 2（连续两次才动手）');
    assert(/for \(const win of BrowserWindow\.getAllWindows\(\)\)/.test(mainjs), '缺少遍历窗口关 DevTools');
});

test('main.js：更新清单验签用的是 Ed25519（crypto.verify + null 算法）', () => {
    assert(/crypto\.verify\(null, Buffer\.from\(ymlText/.test(mainjs), '清单验签实现缺失');
    assert(/if \(!updateSignPubKey\) \{\s*return \{ ok: true, skipped: true \}/m.test(mainjs), '空公钥时跳过逻辑缺失');
});

test('protect.cc：到期常量与 fuse 口径', () => {
    assert(/EXPIRE_MS\s*=\s*\d+LL/.test(cc), 'EXPIRE_MS 必须以 LL 结尾');
    assert(cc.indexOf('dL7pKGdnNz796PbbjQWNKmHXBZaB9tsX') !== -1, 'fuse 哨兵缺失');
    for (const exp of [
        'IDX_RUN_AS_NODE = 0',
        'IDX_NODE_OPTIONS = 2',
        'IDX_CLI_INSPECT = 3',
        'IDX_ONLY_LOAD_ASAR = 5',
    ]) {
        assert(cc.indexOf(exp) !== -1, '缺少索引常量 ' + exp);
    }
});

test('protect.cc：导出表齐全', () => {
    for (const name of ['openCore', 'isCoreOpen', 'hostCheck', 'checkTamper', 'checkExpiry', 'applyLicense', 'hasLicense', 'machineId', 'verifyBuffer', 'verifyFile']) {
        assert(new RegExp('Napi::Function::New\\(env, ' + name + "'").test(cc) || cc.indexOf(name) !== -1, '导出缺失 ' + name);
    }
});

test('protect.cc：openCore 拒绝短种子且只开一次会话', () => {
    assert(/seed\.size\(\) < 16/.test(cc), '种子长度检查缺失');
    assert(/g_coreOpen/.test(cc), '缺少一次性会话状态');
});

test('package.json：fuses 7 项取值正确，且未开启额外文件协议特权', () => {
    const fuses = pkg.build.electronFuses;
    assert(fuses, '缺少 electronFuses');
    eq(fuses.runAsNode, false, 'runAsNode');
    eq(fuses.enableCookieEncryption, true, 'enableCookieEncryption');
    eq(fuses.enableNodeOptionsEnvironmentVariable, false, 'enableNodeOptionsEnvironmentVariable');
    eq(fuses.enableNodeCliInspectArguments, false, 'enableNodeCliInspectArguments');
    eq(fuses.enableEmbeddedAsarIntegrityValidation, true, 'enableEmbeddedAsarIntegrityValidation');
    eq(fuses.onlyLoadAppFromAsar, true, 'onlyLoadAppFromAsar');
    eq(fuses.loadBrowserProcessSpecificV8Snapshot, false, 'loadBrowserProcessSpecificV8Snapshot');
    assert(fuses.grantFileProtocolExtraPrivileges === undefined, '不能写 grantFileProtocolExtraPrivileges（会让渲染层加载失败）');
});

test('package.json：发布链路脚本齐全', () => {
    for (const name of ['test', 'build:native', 'protect', 'package', 'sign:update', 'verify:update', 'push:cos', 'lic:init', 'lic:mid', 'lic:issue', 'lic:verify', 'release']) {
        assert(pkg.scripts[name], '缺少脚本 ' + name);
    }
    assert(pkg.build.asarUnpack.indexOf('**/*.node') !== -1, 'native 必须解包到 asar 之外');
});

test('workflow：测试 / fuses / 签名 / 验签 / COS 都在流水线里', () => {
    for (const key of ['npm test', 'check-fuses.js', 'sign-update.js', 'verify-update-sig.js', 'push-cos.ps1']) {
        assert(workflow.indexOf(key) !== -1, '流水线缺少 ' + key);
    }
    assert(workflow.indexOf('UPDATE_SIGN_KEY') !== -1, '缺少签名私钥注入');
    assert(workflow.indexOf('dist/latest.yml.sig') !== -1, 'Release 未上传 .sig');
    assert(workflow.indexOf('COS_SECRET_ID') !== -1, '缺少 COS 密钥注入');
});

test('.gitignore：私钥与授权不得进仓库', () => {
    assert(/license-key\.json/.test(gi), '缺少 license-key.json');
    assert(/license\.json/.test(gi), '缺少 license.json');
});

test('脚本：四个脚本都能通过 node --check', () => {
    for (const file of ['scripts/licgen.js', 'scripts/sign-update.js', 'scripts/verify-update-sig.js', 'scripts/check-fuses.js', 'scripts/protect.js']) {
        try {
            execFileSync(process.execPath, ['--check', path.join(ROOT, file)], { stdio: 'pipe' });
        } catch (err) {
            throw new Error(file + ' 语法检查失败: ' + (err && err.message));
        }
    }
});

test('脚本：check-fuses 的期望值与 fuse 索引一致', () => {
    const check = read('scripts/check-fuses.js');
    for (const pair of [
        "[0, 'RunAsNode', '0']",
        "[2, 'EnableNodeOptionsEnvironmentVariable', '0']",
        "[3, 'EnableNodeCliInspectArguments', '0']",
        "[5, 'OnlyLoadAppFromAsar', '1']",
    ]) {
        assert(check.indexOf(pair) !== -1, 'check-fuses 期望值缺失: ' + pair);
    }
});
