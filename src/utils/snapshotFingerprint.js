// 快照指纹相关的纯函数：从 store/snapshot.js 里抽出来，方便单测，
// 也让「什么算变、什么算没变」这套规则集中在一处。
import { deepCopy } from "@/utils/utils";
import { SNAPSHOT_MAX_DEPTH } from "@/constants";

// 材质图是几十到几百 KB 的 data URL，逐字符比对真扫一遍不值当，
// 超长字符串只取「长度 + 头尾各 64 字符」当指纹，足够分清是不是换了图。
export const LONG_STRING = 200;
export const EDGE = 64;
// 超过这个深度直接截断，防止畸形嵌套数据（Group 里套 Group）把递归拖死
export const MAX_DEPTH = SNAPSHOT_MAX_DEPTH;

/**
 * 稳定序列化：同一个组件即使对象键顺序不同，也得到同一个指纹，
 * 避免每次编辑后键顺序被重排、被误判成「全部变了」而白拷贝一遍。
 *
 * @param {*} value 任意可序列化结构（组件对象 / 数组 / 原始值）
 * @param {Object} [options] 可选参数
 * @param {number} [options.depth=0] 当前递归深度（内部使用）
 * @param {WeakMap} [options.cache] 同一次遍历里复用的对象指纹缓存（内部使用）
 * @returns {string} 稳定的指纹字符串
 */
export function stableStringify(value, options) {
    const opts = options || {};
    const cache = opts.cache || null;
    const depth = Number.isFinite(opts.depth) ? opts.depth : 0;

    if (value === null || typeof value !== "object") {
        if (typeof value === "string" && value.length > LONG_STRING) {
            return `#${value.length}:${value.slice(0, EDGE)}~${value.slice(-EDGE)}`;
        }
        return JSON.stringify(value) || "";
    }

    // 嵌套过深：截断成占位串，宁可少命中复用也不要栈溢出
    if (depth >= MAX_DEPTH) return "#max-depth";

    // Group 的子组件会被反复遍历到，同一个对象直接复用已算好的指纹，
    // 这是「分组越多越慢」的主要来源
    if (cache && cache.has(value)) return cache.get(value);

    const next = { depth: depth + 1, cache };
    let result;
    if (Array.isArray(value)) {
        result = `[${value.map((item) => stableStringify(item, next)).join(",")}]`;
    } else {
        const keys = Object.keys(value).sort();
        result = `{${keys
            .map((key) => `${JSON.stringify(key)}:${stableStringify(value[key], next)}`)
            .join(",")}}`;
    }

    if (cache) cache.set(value, result);
    return result;
}

/**
 * 生成一份新快照：指纹没变的组件直接复用上一份快照里的那个对象，
 * 只有真正改过的组件才深拷贝。
 *
 * @param {Array} data 当前画布组件数组
 * @param {Array|null} prevData 上一份快照的组件数组（没有则传 null）
 * @param {Array<string>|null} prevSignatures 上一份快照的指纹数组
 * @returns {{list: Array, signatures: Array<string>}}
 */
export function buildSnapshot(data, prevData, prevSignatures) {
    const list = [];
    const signatures = [];
    const source = Array.isArray(data) ? data : [];
    // 一次快照生成共享一份指纹缓存：同一次同步遍历里对象不会变，缓存是安全的
    const cache = new WeakMap();

    for (let i = 0; i < source.length; i++) {
        const component = source[i];
        if (!component) {
            list.push(component);
            signatures.push("");
            continue;
        }
        const signature = stableStringify(component, { depth: 0, cache });
        const reuse = !!(prevData && prevSignatures && prevSignatures[i] === signature);
        list.push(reuse ? prevData[i] : deepCopy(component));
        signatures.push(signature);
    }
    return { list, signatures };
}

export default { stableStringify, buildSnapshot, LONG_STRING, EDGE, MAX_DEPTH };
