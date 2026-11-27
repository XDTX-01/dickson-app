import Vue from 'vue'

// 深拷贝：只处理画布组件这种“纯 JSON 结构 + 少量不可序列化值”的数据
// 边界：null/undefined、Date、循环引用、数组、非普通对象
export function deepCopy(target, cache) {
    // 原始类型与 null 直接返回（以前 typeof null === 'object'，会被拷贝成 {}）
    if (target === null || typeof target !== 'object') return target

    if (target instanceof Date) return new Date(target.getTime())
    if (target instanceof RegExp) return new RegExp(target.source, target.flags)
    // File / Blob / Image 这类对象按引用透传，深拷贝它们没有意义且会丢内部状态
    if (typeof File !== 'undefined' && target instanceof File) return target
    if (typeof Blob !== 'undefined' && target instanceof Blob) return target

    // 循环引用保护：同一个对象再次出现时复用已拷贝的结果，否则会无限递归爆栈
    const seen = cache || new WeakMap()
    if (seen.has(target)) return seen.get(target)

    const result = Array.isArray(target) ? [] : {}
    seen.set(target, result)

    for (const key in target) {
        if (!Object.prototype.hasOwnProperty.call(target, key)) continue
        result[key] = deepCopy(target[key], seen)
    }

    return result
}

/**
 * 交换数组里的两个元素（走 Vue.set，保证响应式生效）。
 *
 * @param {Array} arr 目标数组
 * @param {number} i 下标
 * @param {number} j 下标
 * @returns {void}
 */
export function swap(arr, i, j) {
    if (!Array.isArray(arr) || i === j) return
    const temp = arr[i]
    Vue.set(arr, i, arr[j])
    Vue.set(arr, j, temp)
}

/**
 * 选择器查询的简写（只在浏览器环境调用，node 单测里不要用）。
 *
 * @param {string} selector CSS 选择器
 * @returns {Element|null}
 */
export function $(selector) {
    return document.querySelector(selector)
}

const components = ['VText', 'RectShape', 'CircleShape']

/**
 * 判断某个组件类型是否「不允许在拖动开始时做框选/取消选中」。
 *
 * @param {string|null} component 组件类型名，可能为空
 * @returns {boolean} 为 true 表示要阻止拖拽默认行为
 */
export function isPreventDrop(component) {
    // component 可能为空（旧工程数据里缺字段），这里不能直接 startsWith
    if (typeof component !== 'string' || !component) return true
    return !components.includes(component) && !component.startsWith('SVG')
}
