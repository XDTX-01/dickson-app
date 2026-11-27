import Vue from 'vue'
import Vuex from 'vuex'
import animation from './animation'
import compose from './compose'
import contextmenu from './contextmenu'
import copy from './copy'
import event from './event'
import layer from './layer'
import snapshot from './snapshot'
import lock from './lock'
import pages from './pages'

Vue.use(Vuex)

const data = {
    state: {
        ...pages.state,
        ...animation.state,
        ...compose.state,
        ...contextmenu.state,
        ...copy.state,
        ...event.state,
        ...layer.state,
        ...snapshot.state,
        ...lock.state,

        editMode: 'edit', // 编辑器模式 edit preview
        canvasStyleData: { // 页面全局数据
            width: 1660,
            height: 1034,
            scale: 100,
            color: '#000',
            opacity: 1,
            background: '#fff',
            fontSize: 14,
        },
        isInEdiotr: false, // 是否在编辑器中，用于判断复制、粘贴组件时是否生效，如果在编辑器外，则无视这些操作
        componentData: [], // 画布组件数据
        curComponent: null,
        curComponentIndex: null,
        multiSelectComponents: [], // 框选出的多选集合，用于多选后一起拖动
        isTextTool: false, // 文字工具是否激活：激活后在画布上点一下即可直接输入文字
        // 点击画布时是否点中组件，主要用于取消选中组件用。
        // 如果没点中组件，并且在画布空白处弹起鼠标，则取消当前组件的选中状态
        isClickComponent: false,
    },
    mutations: {
        ...pages.mutations,
        ...animation.mutations,
        ...compose.mutations,
        ...contextmenu.mutations,
        ...copy.mutations,
        ...event.mutations,
        ...layer.mutations,
        ...snapshot.mutations,
        ...lock.mutations,

        setClickComponentStatus(state, status) {
            state.isClickComponent = status
        },

        setEditMode(state, mode) {
            state.editMode = mode
        },

        setInEditorStatus(state, status) {
            state.isInEdiotr = status
        },

        setCanvasStyle(state, style) {
            state.canvasStyleData = style
        },

        setCurComponent(state, { component, index }) {
            state.curComponent = component
            state.curComponentIndex = index
        },

        // 写回文本组件的文字内容（curComponent.propValue 为字符串）
        setPropValue(state, value) {
            if (state.curComponent) {
                state.curComponent.propValue = value
            }
        },

        // 按组件 id 写入，不依赖 curComponent（点空白确认时 curComponent 可能为 null）
        setPropValueById(state, { id, value }) {
            const c = state.componentData.find((c) => c.id === id)
            if (c) c.propValue = value
        },

        setShapeSingleStyleById(state, { id, key, value }) {
            const c = state.componentData.find((c) => c.id === id)
            if (c) c.style[key] = value
        },

        // 写回组件「自身」的字段（不是 style 里的），比如属性面板折叠状态。
        // 组件里不要直接改 curComponent.xxx，统一走 mutation，便于以后追溯改动来源
        setComponentFieldById(state, { id, key, value }) {
            if (!id || !key) return
            const c = state.componentData.find((c) => c.id === id)
            if (c) c[key] = value
        },

        setShapeStyle({ curComponent }, { top, left, width, height, rotate }) {
            // 原来写 if (top) 会把 0 当成“没传”：拖到画布最左边 / 最上面时位置写不进去
            if (!curComponent || !curComponent.style) return
            const assign = (key, value) => {
                if (value === undefined || value === null) return
                const n = Number(value)
                if (!Number.isFinite(n)) return
                curComponent.style[key] = Math.round(n)
            }
            assign('top', top)
            assign('left', left)
            assign('width', width)
            assign('height', height)
            assign('rotate', rotate)
        },

        setShapeSingleStyle({ curComponent }, { key, value }) {
            if (!curComponent || !curComponent.style || key === undefined) return
            curComponent.style[key] = value
        },

        setMultiSelectComponents(state, components) {
            state.multiSelectComponents = components || []
        },

        setTextTool(state, status) {
            state.isTextTool = status
        },

        setComponentStyleById(state, { id, top, left }) {
            const component = state.componentData.find(c => c.id === id)
            if (!component) return
            if (top !== undefined) component.style.top = Math.round(top)
            if (left !== undefined) component.style.left = Math.round(left)
        },

        setComponentData(state, componentData = []) {
            Vue.set(state, 'componentData', componentData)
        },

        addComponent(state, { component, index }) {
            if (index !== undefined) {
                state.componentData.splice(index, 0, component)
            } else {
                state.componentData.push(component)
            }
        },

        deleteComponent(state, index) {
            if (index === undefined || index === null) {
                index = state.curComponentIndex
            }

            // 索引必须是有效整数：以前用 /\d/.test(index) 判断，
            // 传 -1 会命中并 splice(-1,1) 删掉最后一个组件（还可能是别的组件）
            const i = Number(index)
            if (!Number.isInteger(i) || i < 0 || i >= state.componentData.length) {
                return
            }

            if (i === state.curComponentIndex) {
                state.curComponentIndex = null
                state.curComponent = null
            }

            state.componentData.splice(i, 1)
            // 删掉靠前的组件后，选中索引要跟着前移，否则后续操作会指到错误的组件
            if (state.curComponentIndex !== null && state.curComponentIndex > i) {
                state.curComponentIndex -= 1
            }
        },
    },
}

export default new Vuex.Store(data)
