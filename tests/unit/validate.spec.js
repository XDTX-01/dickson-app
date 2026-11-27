import {
    parseFiniteNumber,
    clampInt,
    validateSizeInput,
    validateRotateInput,
} from '@/utils/validate'
import {
    COMPONENT_MIN_SIZE,
    ROTATE_ANGLE_MIN,
    ROTATE_ANGLE_MAX,
} from '@/constants'

describe('utils/validate', () => {
    test('parseFiniteNumber 只接受有限数字', () => {
        expect(parseFiniteNumber('350')).toBe(350)
        expect(parseFiniteNumber(' -12 ')).toBe(-12)
        expect(parseFiniteNumber('')).toBeNull()
        expect(parseFiniteNumber('abc')).toBeNull()
        expect(parseFiniteNumber(null)).toBeNull()
        expect(parseFiniteNumber(undefined)).toBeNull()
        expect(parseFiniteNumber(Infinity)).toBeNull()
        expect(parseFiniteNumber(NaN)).toBeNull()
    })

    test('clampInt 取整并夹在区间内', () => {
        expect(clampInt(12.7, 0, 100)).toBe(13)
        expect(clampInt(-5, 0, 100)).toBe(0)
        expect(clampInt(999, 0, 100)).toBe(100)
        expect(clampInt('abc', 7, 9)).toBe(7)
    })

    test('宽高输入：0 / 负数 / 非法都回退，小于下限收到下限', () => {
        expect(validateSizeInput('350', 100)).toEqual({ ok: true, value: 350, message: '' })
        expect(validateSizeInput('0', 350).ok).toBe(false)
        expect(validateSizeInput('0', 350).value).toBe(350)
        expect(validateSizeInput('-10', 350)).toMatchObject({ ok: false, value: 350 })
        expect(validateSizeInput('abc', 350)).toMatchObject({ ok: false, value: 350 })
        const tiny = validateSizeInput(String(COMPONENT_MIN_SIZE - 1), 350)
        expect(tiny.ok).toBe(false)
        expect(tiny.value).toBe(COMPONENT_MIN_SIZE)
        expect(tiny.message).toContain('最小')
    })

    test('角度输入：超出区间被钳制而不是报错', () => {
        expect(validateRotateInput('45', 0)).toEqual({ ok: true, value: 45, message: '' })
        const over = validateRotateInput(String(ROTATE_ANGLE_MAX + 40), 0)
        expect(over.ok).toBe(true)
        expect(over.value).toBe(ROTATE_ANGLE_MAX)
        expect(over.message).toContain('限制')
        const under = validateRotateInput(String(ROTATE_ANGLE_MIN - 40), 0)
        expect(under.value).toBe(ROTATE_ANGLE_MIN)
        expect(validateRotateInput('x', 30)).toMatchObject({ ok: false, value: 30 })
    })
})
