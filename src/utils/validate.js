// 属性面板数字输入的校验工具：把「合法 / 非法」的判断逻辑集中在一处，
// 组件里只负责提示与回退，方便单测，也避免每个面板各写一套 if。
import {
    COMPONENT_MIN_SIZE,
    ROTATE_ANGLE_MIN,
    ROTATE_ANGLE_MAX,
} from '@/constants'

/**
 * 把输入框的原始值转成有限数字。
 *
 * @param {*} raw 输入框事件值 / v-model 值（可能是 ""、"abc"、null）
 * @returns {number|null} 合法数字，非法返回 null（调用方据此回退）
 */
export function parseFiniteNumber(raw) {
    if (raw === null || raw === undefined) return null
    const text = String(raw).trim()
    if (!text) return null
    const num = Number(text)
    if (!Number.isFinite(num)) return null
    return num
}

/**
 * 四舍五入成整数并夹在 [min, max] 之间。
 *
 * @param {number} value 数值
 * @param {number} min 下限
 * @param {number} max 上限
 * @returns {number}
 */
export function clampInt(value, min, max) {
    const num = Math.round(Number(value))
    if (!Number.isFinite(num)) return min
    if (num < min) return min
    if (num > max) return max
    return num
}

/**
 * 尺寸校验：宽高必须有下限，0 / 负数是非法输入。
 *
 * @param {*} raw 输入框原始值
 * @param {number} fallback 非法时回退到的旧值
 * @returns {{ok: boolean, value: number, message: string}}
 */
export function validateSizeInput(raw, fallback = COMPONENT_MIN_SIZE) {
    const num = parseFiniteNumber(raw)
    const safeFallback = Number.isFinite(Number(fallback)) ? Number(fallback) : COMPONENT_MIN_SIZE
    if (num === null) {
        return { ok: false, value: safeFallback, message: '请输入数字' }
    }
    if (num === 0) {
        return { ok: false, value: safeFallback, message: `宽高不能为 0（最小 ${COMPONENT_MIN_SIZE}px）` }
    }
    if (num < 0) {
        return { ok: false, value: safeFallback, message: `宽高不能为负数（最小 ${COMPONENT_MIN_SIZE}px）` }
    }
    if (num < COMPONENT_MIN_SIZE) {
        return { ok: false, value: COMPONENT_MIN_SIZE, message: `最小 ${COMPONENT_MIN_SIZE}px` }
    }
    return { ok: true, value: Math.round(num), message: '' }
}

/**
 * 旋转角度校验：超出 [-360, 360] 自动钳制（不视为失败，只是收敛到边界）。
 *
 * @param {*} raw 输入框原始值
 * @param {number} fallback 非法时回退到的旧值
 * @returns {{ok: boolean, value: number, message: string}}
 */
export function validateRotateInput(raw, fallback = 0) {
    const num = parseFiniteNumber(raw)
    const safeFallback = Number.isFinite(Number(fallback)) ? Number(fallback) : 0
    if (num === null) {
        return { ok: false, value: safeFallback, message: '请输入数字' }
    }
    const clamped = clampInt(num, ROTATE_ANGLE_MIN, ROTATE_ANGLE_MAX)
    if (clamped !== Math.round(num)) {
        return {
            ok: true,
            value: clamped,
            message: `角度已限制在 ${ROTATE_ANGLE_MIN}° ~ ${ROTATE_ANGLE_MAX}°`,
        }
    }
    return { ok: true, value: clamped, message: '' }
}

export default { parseFiniteNumber, clampInt, validateSizeInput, validateRotateInput }
