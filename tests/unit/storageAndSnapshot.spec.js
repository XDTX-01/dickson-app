import { stableStringify, buildSnapshot, MAX_DEPTH } from '@/utils/snapshotFingerprint'
import { utf8ByteLength, safeSetLocalStorage, safeGetLocalStorage } from '@/utils/storageHelper'
import { SNAPSHOT_MAX_DEPTH } from '@/constants'

describe('snapshotFingerprint 深度保护', () => {
    test('嵌套超过深度上限时截断成占位串，不栈溢出', () => {
        let deep = { style: { width: 1 } }
        for (let i = 0; i < MAX_DEPTH + 10; i += 1) deep = { child: deep }
        const text = stableStringify(deep, { depth: 0, cache: new WeakMap() })
        expect(text).toContain('#max-depth')
        expect(text.length).toBeLessThan(2000)
    })

    test('同一个子对象被多处引用时只算一次（Group 复用场景）', () => {
        const shared = { style: { width: 350, height: 750 } }
        const data = [
            { id: 'a', component: 'Group', propValue: [shared, shared] },
            { id: 'b', component: 'Picture', style: { width: 350 } },
        ]
        const cache = new WeakMap()
        const first = stableStringify(data[0], { depth: 0, cache })
        const second = stableStringify(data[0], { depth: 0, cache })
        expect(first).toBe(second)
    })

    test('指纹没变的组件复用上一份快照对象，变了的才深拷贝', () => {
        const prev = [{ id: 'a', style: { width: 100 } }, { id: 'b', style: { width: 200 } }]
        const prevSignatures = prev.map((item) => stableStringify(item))
        const next = [{ id: 'a', style: { width: 100 } }, { id: 'b', style: { width: 300 } }]
        const result = buildSnapshot(next, prev, prevSignatures)
        expect(result.list[0]).toBe(prev[0])
        expect(result.list[1]).not.toBe(prev[1])
        expect(result.list[1].style.width).toBe(300)
    })

    test('空数组 / 含 null 的脏数据不抛错', () => {
        expect(buildSnapshot(null, null, null).list).toEqual([])
        expect(buildSnapshot([null, { id: 'a' }], null, null).signatures[0]).toBe('')
    })

    test('深度常量收敛在 constants.js', () => {
        expect(MAX_DEPTH).toBe(SNAPSHOT_MAX_DEPTH)
    })
})

describe('storageHelper 纯函数与降级', () => {
    test('utf8ByteLength 按字节计算（中文 3 字节）', () => {
        expect(utf8ByteLength('abc')).toBe(3)
        expect(utf8ByteLength('中文')).toBe(6)
        expect(utf8ByteLength('')).toBe(0)
        expect(utf8ByteLength(null)).toBe(0)
    })

    test('没有 window 环境下写入失败时给出可读原因，不抛异常', () => {
        const result = safeSetLocalStorage('demo', 'x')
        expect(result.ok).toBe(false)
        expect(typeof result.reason).toBe('string')
        expect(safeGetLocalStorage('demo', 'fallback')).toBe('fallback')
    })
})
