import store from './index'
import { deepCopy } from '@/utils/utils'
import { MAX_SNAPSHOTS } from '@/constants'
import { buildSnapshot } from '@/utils/snapshotFingerprint'

// 设置画布默认数据
let defaultcomponentData = []
function getDefaultcomponentData() {
    return defaultcomponentData
}

export function setDefaultcomponentData(data = []) {
    defaultcomponentData = data
}

function normalizeComponentData(data) {
    return Array.isArray(data) ? data : getDefaultcomponentData()
}

// 与快照一一对应的「内容指纹」：判断某次记录里哪些组件其实没变，
// 没变的组件直接复用上一份快照里的那个对象，不再整份深拷贝。
// 只放在模块作用域里，不塞进 state，避免 Vue 去响应式追踪一大串字符串。
// 指纹算法与 buildSnapshot 都在 utils/snapshotFingerprint.js，那边有单测。
let snapshotSignatures = []

// 切换页面 / 复制页面时必须清空指纹：
// 指纹数组是和「当前页的撤销栈」一一对应的，跨页沿用旧指纹会让新页第一笔编辑
// 被误判成「没有任何变化」，从而复用到别的页面快照里的组件对象。
export function resetSnapshotSignatures() {
    snapshotSignatures = []
}


export default {
    state: {
        snapshotData: [], // 编辑器快照数据
        snapshotIndex: -1, // 快照索引
    },
    mutations: {
        undo(state) {
            if (state.snapshotIndex >= 0) {
                state.snapshotIndex--
                const componentData = normalizeComponentData(deepCopy(state.snapshotData[state.snapshotIndex]))
                if (state.curComponent) {
                    // 如果当前组件不在 componentData 中，则置空
                    const needClean = !componentData.find(component => state.curComponent.id === component.id)

                    if (needClean) {
                        store.commit('setCurComponent', {
                            component: null,
                            index: null,
                        })
                    }
                }

                store.commit('setComponentData', componentData)
            }
        },

        redo(state) {
            if (state.snapshotIndex < state.snapshotData.length - 1) {
                state.snapshotIndex++
                store.commit(
                    'setComponentData',
                    normalizeComponentData(deepCopy(state.snapshotData[state.snapshotIndex]))
                )
            }
        },

        recordSnapshot(state) {
            const writeIndex = state.snapshotIndex + 1

            // 在 undo 过程中，添加新的快照时，要将它后面的快照清理掉
            if (writeIndex < state.snapshotData.length) {
                state.snapshotData = state.snapshotData.slice(0, writeIndex)
                snapshotSignatures = snapshotSignatures.slice(0, writeIndex)
            }

            const prevData = writeIndex > 0 ? state.snapshotData[writeIndex - 1] : null
            const prevSignatures = writeIndex > 0 ? snapshotSignatures[writeIndex - 1] : null
            const next = buildSnapshot(normalizeComponentData(state.componentData), prevData, prevSignatures)

            state.snapshotData[writeIndex] = next.list
            snapshotSignatures[writeIndex] = next.signatures
            state.snapshotIndex = writeIndex

            // 超出上限时丢弃最旧的快照，并同步修正索引
            if (state.snapshotData.length > MAX_SNAPSHOTS) {
                const overflow = state.snapshotData.length - MAX_SNAPSHOTS
                state.snapshotData = state.snapshotData.slice(overflow)
                snapshotSignatures = snapshotSignatures.slice(overflow)
                state.snapshotIndex = Math.max(0, state.snapshotIndex - overflow)
            }
        },
    },
}
