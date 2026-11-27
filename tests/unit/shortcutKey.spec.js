// 快捷键焦点守卫：判断「这次按键该不该交给画布处理」。
// shortcutKey.js 顶上有 store 依赖，但这里只测纯函数 isEditableTarget，
// 所以在 jest 里 import 该模块时把 store / eventBus 用 mock 顶掉即可。
// （jest.mock 会被 babel-jest 提升到文件顶部，写在 import 后面不影响生效）
import { isEditableTarget } from '@/utils/shortcutKey'

jest.mock('@/store', () => ({ state: {}, commit: () => {} }), { virtual: true })
jest.mock('@/utils/eventBus', () => ({ $emit: () => {}, $on: () => {} }), { virtual: true })

function fakeNode(tag, extra = {}) {
    return { tagName: tag, isContentEditable: false, parentElement: null, ...extra }
}

describe('shortcutKey.isEditableTarget', () => {
    test('输入类控件要跳过画布快捷键', () => {
        expect(isEditableTarget(fakeNode('INPUT'))).toBe(true)
        expect(isEditableTarget(fakeNode('TEXTAREA'))).toBe(true)
        expect(isEditableTarget(fakeNode('SELECT'))).toBe(true)
        expect(isEditableTarget(fakeNode('DIV', { isContentEditable: true }))).toBe(true)
    })

    test('Element 嵌套结构：点在 input 里面的 span 上也算', () => {
        const wrapper = fakeNode('SPAN', { parentElement: fakeNode('INPUT') })
        expect(isEditableTarget(wrapper)).toBe(true)
    })

    test('画布 / 普通容器不拦截', () => {
        expect(isEditableTarget(fakeNode('DIV'))).toBe(false)
        expect(isEditableTarget(fakeNode('CANVAS'))).toBe(false)
        expect(isEditableTarget(null)).toBe(false)
        expect(isEditableTarget(undefined)).toBe(false)
        expect(isEditableTarget({})).toBe(false)
    })

    test('只向上找三层，避免把整页容器误判成输入框', () => {
        let deep = fakeNode('INPUT')
        let node = fakeNode('DIV', { parentElement: deep })
        for (let i = 0; i < 5; i += 1) node = fakeNode('DIV', { parentElement: node })
        expect(isEditableTarget(node)).toBe(false)
    })
})
