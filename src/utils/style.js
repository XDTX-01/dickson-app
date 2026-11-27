import { sin, cos, toPercent } from '@/utils/translate'

/**
 * 判断一个样式值是不是可用的数字（字符串数字也算），
 * 用来挡住导入残缺工程里的 undefined / null / ""，避免拼出 "undefinedpx" 这种非法 CSS。
 *
 * @param {*} value 原始值
 * @returns {boolean}
 */
function isUsableNumber(value) {
    if (value === null || value === undefined || value === '') return false
    return Number.isFinite(Number(value))
}

/**
 * 通用矩形组件的内联样式（定位 + 尺寸 + 旋转）。
 *
 * @param {Object|null} style 组件 style 对象，可以为空
 * @returns {Object} 可直接绑定到 Vue :style 的对象
 */
export function getShapeStyle(style) {
    // 老工程 / 异常数据里 style 可能是 null：不能让渲染直接抛错
    if (!style || typeof style !== 'object') return {}
    const result = {};
    ['width', 'height', 'top', 'left', 'rotate'].forEach(attr => {
        if (!isUsableNumber(style[attr])) return
        if (attr != 'rotate') {
            result[attr] = style[attr] + 'px'
        } else {
            result.transform = 'rotate(' + style[attr] + 'deg)'
        }
    })

    return result
}

const needUnit = [
    'fontSize',
    'width',
    'height',
    'top',
    'left',
    'borderWidth',
    'letterSpacing',
    'borderRadius',
]

/**
 * SVG 组件的内联样式（带过滤表）。
 *
 * @param {Object|null} style 组件 style 对象
 * @param {Array<string>} [filter=[]] 需要跳过的字段名
 * @returns {Object}
 */
export function getSVGStyle(style, filter = []) {
    if (!style || typeof style !== 'object') return {}
    const result = {};

    [
        'opacity',
        'width',
        'height',
        'top',
        'left',
        'rotate',
        'fontSize',
        'fontWeight',
        'lineHeight',
        'letterSpacing',
        'textAlign',
        'color',
    ].forEach(key => {
        if (!filter.includes(key)) {
            if (key != 'rotate') {
                // 空串 / undefined / null 都不要写进样式表（以前只挡了空串）
                if (style[key] !== '' && style[key] !== undefined && style[key] !== null) {
                    result[key] = style[key]

                    if (needUnit.includes(key)) {
                        result[key] += 'px'
                    }
                }
            } else if (isUsableNumber(style[key])) {
                result.transform = key + '(' + style[key] + 'deg)'
            }
        }
    })

    return result
}

/**
 * 普通组件的内联样式：原样透传 style 的字段，长度类字段补 px。
 *
 * @param {Object|null} style 组件 style 对象
 * @param {Array<string>} [filter=[]] 需要跳过的字段名
 * @returns {Object}
 */
export function getStyle(style, filter = []) {
    if (!style || typeof style !== 'object') return {}
    const result = {}
    Object.keys(style).forEach(key => {
        if (!filter.includes(key)) {
            if (key != 'rotate') {
                if (style[key] !== '' && style[key] !== undefined && style[key] !== null) {
                    result[key] = style[key]

                    if (needUnit.includes(key)) {
                        result[key] += 'px'
                    }
                }
            } else if (isUsableNumber(style[key])) {
                result.transform = key + '(' + style[key] + 'deg)'
            }
        }
    })

    return result
}

// 获取一个组件旋转 rotate 后的样式
export function getComponentRotatedStyle(style) {
    if (!style || typeof style !== 'object') return {}
    style = { ...style }
    const width = Number(style.width) || 0
    const height = Number(style.height) || 0
    const rotate = Number(style.rotate) || 0
    const left = Number(style.left) || 0
    const top = Number(style.top) || 0
    style.left = left
    style.top = top
    style.width = width
    style.height = height
    style.rotate = rotate

    if (rotate != 0) {
        const newWidth = width * cos(rotate) + height * sin(rotate)
        const diffX = (width - newWidth) / 2 // 旋转后范围变小是正值，变大是负值
        style.left = left + diffX
        style.right = style.left + newWidth

        const newHeight = height * cos(rotate) + width * sin(rotate)
        const diffY = (newHeight - height) / 2 // 始终是正
        style.top = top - diffY
        style.bottom = style.top + newHeight

        style.width = newWidth
        style.height = newHeight
    } else {
        style.bottom = style.top + style.height
        style.right = style.left + style.width
    }

    return style
}

const filterKeys = ['width', 'height', 'scale']
export function getCanvasStyle(canvasStyleData) {
    if (!canvasStyleData || typeof canvasStyleData !== 'object') return {}
    const result = {}
    Object.keys(canvasStyleData).filter(key => !filterKeys.includes(key)).forEach(key => {
        result[key] = canvasStyleData[key]
        if (key === 'fontSize') {
            result[key] += 'px'
        }
    })

    return result
}

export function createGroupStyle(groupComponent) {
    if (!groupComponent || !groupComponent.style) return
    const parentStyle = groupComponent.style
    if (!Array.isArray(groupComponent.propValue)) return
    // 父容器尺寸为 0 时，百分比换算会得到 Infinity/NaN，这里直接放弃组内定位计算
    if (!Number(parentStyle.width) || !Number(parentStyle.height)) return

    groupComponent.propValue.forEach(component => {
        if (!component || typeof component !== 'object') return
        if (!component.style || typeof component.style !== 'object') component.style = {}
        if (!component.groupStyle || typeof component.groupStyle !== 'object') component.groupStyle = {}

        // component.groupStyle 的 top left 是相对于 group 组件的位置
        // 如果已存在 component.groupStyle，说明已经计算过一次了。不需要再次计算
        if (!Object.keys(component.groupStyle).length) {
            const style = { ...component.style }
            if (typeof component.component === 'string' && component.component.startsWith('SVG')) {
                component.groupStyle = getSVGStyle(style)
            } else {
                component.groupStyle = getStyle(style)
            }

            const left = Number(style.left) || 0
            const top = Number(style.top) || 0
            const width = Number(style.width) || 0
            const height = Number(style.height) || 0

            component.groupStyle.left = toPercent((left - (Number(parentStyle.left) || 0)) / Number(parentStyle.width))
            component.groupStyle.top = toPercent((top - (Number(parentStyle.top) || 0)) / Number(parentStyle.height))
            component.groupStyle.width = toPercent(width / Number(parentStyle.width))
            component.groupStyle.height = toPercent(height / Number(parentStyle.height))
        }
    })
}
