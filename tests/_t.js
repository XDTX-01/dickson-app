// 用例容器：每个文件通过 test(name, fn) 注册，run.js 顺序执行
const cases = [];

function test(name, fn) {
    cases.push({ name: name, fn: fn });
}

function assert(cond, message) {
    if (!cond) throw new Error(message || '断言失败');
}

function eq(actual, expected, message) {
    const a = JSON.stringify(actual);
    const b = JSON.stringify(expected);
    if (a !== b) throw new Error((message || '不相等') + '：实际 ' + a + '，期望 ' + b);
}

async function rejects(fn, hint) {
    let threw = false;
    try {
        await fn();
    } catch (_) {
        threw = true;
    }
    if (!threw) throw new Error(hint || '预期抛错但没抛');
}

module.exports = { test, assert, eq, rejects, cases };
