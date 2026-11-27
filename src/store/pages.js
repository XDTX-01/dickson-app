import Vue from 'vue'
import { cloneData, createPage, DEFAULT_CANVAS_STYLE } from '@/utils/pagesStorage'
import { MAX_PAGES } from '@/constants'
import { resetSnapshotSignatures } from './snapshot'

// 页面数量上限统一放在 @/constants（页数上限、保存门槛等都在那），这里只做使用

// 页签名统一：系统命名的页（「页面 N」「导入N」）一律按它在页签里的位置重新编号，
// 增页 / 删页 / 导入之后都不会出现「4 页面 5」这种序号和名字对不上的情况；
// 用户双击改过的自定义名字不受影响。
// 页签名规则：手动建的页叫「页面 N」，导入来的页叫「导入N」，两类各自连续编号。
// 增页 / 删页 / 导入之后都重排一次，避免出现「4 页面 5」这种序号和名字对不上的情况；
// 用户双击改过的自定义名字不受影响。
function renumberPages(state) {
    let pageNo = 0
    let importNo = 0
    state.pages.forEach(page => {
        if (!page || typeof page !== 'object') return
        const name = String(page.name || '').trim()
        if (!name || /^页面(\s*\d+)?$/.test(name)) {
            pageNo += 1
            page.name = `页面 ${pageNo}`
        } else if (/^导入(\s*\d+)?$/.test(name)) {
            importNo += 1
            page.name = `导入${importNo}`
        }
    })
}

// 页签排序：手建的「页面 N」永远在前，导入来的「导入N」永远在后，
// 两组内部保持各自原来的先后顺序。focus 是排完后要停留的那一页。
// 判定按「导入」前缀走，这样复制导入页得到的「导入1 副本」也不会被排到页面组里。
function sortPages(state, focus) {
    if (!Array.isArray(state.pages)) return
    const keep = focus || state.pages[state.curPageIndex]
    const isImport = (page) => /^导入/.test(String((page && page.name) || '').trim())
    const normal = []
    const imported = []
    state.pages.forEach(page => (isImport(page) ? imported : normal).push(page))
    // 导入组内部按名字自然序排（导入1 → 导入1 副本 → 导入1 副本2 → 导入2），
    // 这样连续复制同一个导入页时，副本不会跑到上一个副本前面。
    imported.sort((a, b) =>
        String((a && a.name) || '').localeCompare(String((b && b.name) || ''), 'zh-Hans-CN', { numeric: true })
    )
    state.pages = normal.concat(imported)
    const index = state.pages.indexOf(keep)
    if (index >= 0) state.curPageIndex = index
}

// 复制页的命名：「原页名 副本」，若这个名字已经被占用就依次加 2、3…，
// 避免连续复制同一页时出现两个一模一样的页签名。
function copyNameOf(state, base) {
    const taken = {}
    state.pages.forEach(page => {
        if (!page) return
        taken[String(page.name || '').trim()] = true
    })
    let name = `${base} 副本`
    let no = 2
    while (taken[name]) {
        name = `${base} 副本${no}`
        no += 1
    }
    return name
}

// 画布为空时的框选数据，与 store/compose.js 默认值保持一致
function emptyAreaData() {
    return {
        style: {
            top: 0,
            left: 0,
            width: 0,
            height: 0,
        },
        components: [],
    }
}

// 切换页面前清掉当前页的选中/框选/右击菜单等临时状态
function resetEditingState(state) {
    state.curComponent = null
    state.curComponentIndex = null
    state.multiSelectComponents = []
    state.isTextTool = false
    state.menuShow = false
    state.areaData = emptyAreaData()
}

// 把画布上的实时数据写回当前页对象（切页/增删页前调用）
function saveCurrentPage(state) {
    const page = state.pages[state.curPageIndex]
    if (!page) return

    // 存进去的是副本，不是内存里那份的引用：
    // 否则 page.componentData 和 state.componentData 会指向同一个数组，
    // 之后在当前页继续编辑（push / splice / 改属性）会连带改掉「已保存」的那份，
    // 撤销、切页对比、导出旧页都会跟着变。
    page.componentData = cloneData(state.componentData)
    page.canvasStyleData = cloneData(state.canvasStyleData)
    // 撤销 / 重做栈按页保存，切回该页时还能继续撤销
    page.snapshotData = state.snapshotData.slice()
    page.snapshotIndex = state.snapshotIndex
}

// 载入某一页的数据到画布
function loadPage(state, index) {
    const page = state.pages[index]
    if (!page) return

    state.curPageIndex = index
    Vue.set(state, 'componentData', cloneData(page.componentData || []))
    Vue.set(state, 'canvasStyleData', { ...DEFAULT_CANVAS_STYLE, ...(cloneData(page.canvasStyleData) || {}) })
    resetEditingState(state)

    // 逐页撤销栈：没有历史时从空栈开始（撤销到栈底会回到该页初始数据）
    state.snapshotData = Array.isArray(page.snapshotData) ? page.snapshotData.slice() : []
    state.snapshotIndex = Number.isInteger(page.snapshotIndex) ? page.snapshotIndex : -1
    // 指纹和撤销栈是一一对应的，换页必须一起清空，否则新页的第一笔编辑会被
    // 误判成「没变化」，复用到旧页快照里的组件对象
    resetSnapshotSignatures()
}

export default {
    state: {
        pages: [], // 所有页面：{ id, name, componentData, canvasStyleData, snapshotData, snapshotIndex }
        curPageIndex: 0, // 当前编辑的页下标
    },
    mutations: {
        // 首次进入编辑器：用本地缓存恢复全部页面
        initPages(state, { pages = [], curPageIndex = 0 }) {
            state.pages = pages.map(page => ({ ...page, snapshotData: [], snapshotIndex: -1 }))
            state.curPageIndex = 0
            if (!state.pages.length) state.pages = [createPage('页面 1')]
            loadPage(state, Math.min(Math.max(curPageIndex, 0), state.pages.length - 1))
        },

        // 切换页面
        switchPage(state, index) {
            if (index === state.curPageIndex || index < 0 || index >= state.pages.length) return
            saveCurrentPage(state)
            loadPage(state, index)
        },

        // 新增空白页（画布尺寸/比例沿用当前页），一律追加到页签最后；最多 6 页
        addPage(state, options = {}) {
            if (state.pages.length >= MAX_PAGES) return
            saveCurrentPage(state)
            const name = options.name || `页面 ${state.pages.length + 1}`
            const page = createPage(name, [], state.canvasStyleData)
            state.pages.push(page)
            sortPages(state, page)
            renumberPages(state)
            const finalIndex = state.pages.indexOf(page)
            loadPage(state, finalIndex >= 0 ? finalIndex : state.curPageIndex)
            Vue.set(state, "lastPageId", page.id)
        },

        // 复制当前页（含全部组件），插入到当前页后面；最多 6 页
        duplicatePage(state, options = {}) {
            if (state.pages.length >= MAX_PAGES) return
            const source = state.pages[state.curPageIndex]
            if (!source) return
            saveCurrentPage(state)
            const name = options.name || copyNameOf(state, String(source.name || '').trim())
            // createPage 会给新页一份空快照栈（snapshotData = [] / snapshotIndex = -1），
            // loadPage 还会清掉模块级指纹，所以新页的撤销历史与源页完全隔离
            const page = createPage(name, state.componentData, state.canvasStyleData)
            state.pages.splice(state.curPageIndex + 1, 0, page)
            sortPages(state, page)
            renumberPages(state)
            const finalIndex = state.pages.indexOf(page)
            loadPage(state, finalIndex >= 0 ? finalIndex : state.curPageIndex)
            Vue.set(state, "lastPageId", page.id)
        },

        // 删除页面；删的是当前页时自动落到相邻页
        removePage(state, index) {
            if (state.pages.length <= 1 || index < 0 || index >= state.pages.length) return

            if (index === state.curPageIndex) {
                saveCurrentPage(state)
                state.pages.splice(index, 1)
                const focus = state.pages[Math.min(index, state.pages.length - 1)]
                sortPages(state, focus)
                renumberPages(state)
                loadPage(state, state.curPageIndex)
                return
            }

            state.pages.splice(index, 1)
            if (index < state.curPageIndex) state.curPageIndex -= 1
            const focus = state.pages[state.curPageIndex]
            sortPages(state, focus)
            renumberPages(state)
        },

        // 重命名页面
        renamePage(state, { index, name } = {}) {
            const page = state.pages[index]
            if (!page) return
            const newName = String(name || '').trim().slice(0, 20)
            if (newName) page.name = newName
        },

        // 手动把画布数据同步进当前页（保存前用）
        syncCurPage(state) {
            saveCurrentPage(state)
        },

        // 导入工程：把外部文件里的页面追加到末尾，现有页面完整保留，并跳到第一张导入页
        // 受 8 页上限约束，多出来的页面丢弃
        appendPages(state, pages) {
            if (!Array.isArray(pages) || !pages.length) return

            const room = MAX_PAGES - state.pages.length
            if (room <= 0) return

            saveCurrentPage(state)
            const added = []
            pages.slice(0, room).forEach(page => {
                if (!page || typeof page !== 'object') return
                const copy = {
                    ...page,
                    componentData: Array.isArray(page.componentData) ? page.componentData : [],
                    canvasStyleData: (page.canvasStyleData && typeof page.canvasStyleData === 'object')
                        ? page.canvasStyleData
                        : { ...DEFAULT_CANVAS_STYLE },
                    snapshotData: [],
                    snapshotIndex: -1,
                }
                added.push(copy)
                state.pages.push(copy)
            })
            if (!added.length) return
            sortPages(state, added[0])
            renumberPages(state)
            const finalIndex = state.pages.indexOf(added[0])
            loadPage(state, finalIndex >= 0 ? finalIndex : state.curPageIndex)
            if (added[0]) Vue.set(state, "lastPageId", added[0].id)
        },
    },
}
