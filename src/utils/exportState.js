// 导出状态（全局单例）：保存按钮的 loading / 置灰靠它驱动。
//
// 为什么单独放一个模块：导出真正发生在 Preview 组件里，而按钮在 Toolbar 里，
// 两个组件不同级、也不方便为了一个布尔值再往 store 里加字段。
// Vue.observable 能让这个普通对象变成响应式的，两边 import 同一个实例即可。
import Vue from 'vue'

export const exportState = Vue.observable({
    busy: false, // 导出进行中（按钮置灰 + loading）
    title: '', // 当前阶段文案，便于按钮 tooltip 提示
})

/**
 * 切换导出状态。
 *
 * @param {boolean} busy 是否正在导出
 * @param {string} [title] 阶段文案
 * @returns {void}
 */
export function setExportBusy(busy, title = '') {
    exportState.busy = Boolean(busy)
    exportState.title = exportState.busy ? title : ''
}

/**
 * 当前是否正在导出。
 *
 * @returns {boolean}
 */
export function isExportBusy() {
    return Boolean(exportState.busy)
}

export default { exportState, setExportBusy, isExportBusy }
