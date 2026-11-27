<template>
    <div class="page-bar">
        <span class="page-bar-title">页面</span>
        <div class="page-tabs">
            <div
                v-for="(page, index) in pages"
                :key="page.id"
                class="page-tab"
                :class="{ active: index === curPageIndex, editing: editingIndex === index }"
                :title="editingIndex === index ? '回车保存，Esc 取消' : page.name + '（双击页签名重命名）'"
                @click="handleSwitch(index)"
            >
                <!-- 状态小圈：有材质=红，空白页=绿（放在页面名前面，不再显示序号） -->
                <span
                    class="page-tab-dot"
                    :class="pageFilled[index] ? 'is-filled' : 'is-empty'"
                    :title="pageFilled[index] ? '该页已有材质' : '空白页（暂无材质）'"
                ></span>
                <!-- 双击就地变输入框（浏览器标签改名的手感），不再弹 Element 的 $prompt 弹窗 -->
                <input
                    v-if="editingIndex === index"
                    v-model="editValue"
                    class="page-tab-input"
                    type="text"
                    maxlength="20"
                    @click.stop
                    @dblclick.stop
                    @keyup.enter="commitRename"
                    @keyup.esc="cancelRename"
                    @blur="commitRename"
                />
                <!-- 双击只绑在页签名上：双击状态圆点 / 关闭 × 不再误触发改名 -->
                <span
                    v-else
                    class="page-tab-name"
                    @dblclick.stop="startRename(index)"
                >{{ displayName(page.name) }}</span>
                <span
                    v-if="pages.length > 1 && editingIndex !== index"
                    class="page-tab-close"
                    title="删除此页"
                    @click.stop="handleRemove(index)"
                >×</span>
            </div>
        </div>
        <!-- 新增 / 复制：纯图标（参照浏览器的新标签加号、右键「复制」），不占文字位置 -->
        <button
            class="page-tool"
            type="button"
            :title="isFull ? '最多 ' + maxPages + ' 个页面' : '新增页面'"
            :disabled="isFull"
            @click="handleAdd"
        >
            <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
                <path
                    d="M8 2.6v10.8M2.6 8h10.8"
                    stroke="currentColor"
                    stroke-width="1.6"
                    stroke-linecap="round"
                />
            </svg>
        </button>
        <button
            class="page-tool"
            type="button"
            :title="isFull ? '最多 ' + maxPages + ' 个页面' : '复制本页'"
            :disabled="isFull"
            @click="handleDuplicate"
        >
            <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
                <rect
                    x="2.5"
                    y="2.5"
                    width="8"
                    height="8"
                    rx="1.6"
                    fill="none"
                    stroke="currentColor"
                    stroke-width="1.4"
                />
                <rect
                    x="5.8"
                    y="5.8"
                    width="7.7"
                    height="7.7"
                    rx="1.6"
                    fill="none"
                    stroke="currentColor"
                    stroke-width="1.4"
                />
            </svg>
        </button>
        <!-- 刷新页面：重新加载整个应用（清掉内存里未保存的编辑内容） -->
        <button
            class="page-tool"
            type="button"
            title="刷新页面"
            @click="handleRefresh"
        >
            <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
                <path
                    d="M13.2 8a5.2 5.2 0 1 1-1.9-4.05"
                    fill="none"
                    stroke="currentColor"
                    stroke-width="1.5"
                    stroke-linecap="round"
                />
                <path
                    d="M13.4 2.2v3.2h-3.2"
                    fill="none"
                    stroke="currentColor"
                    stroke-width="1.5"
                    stroke-linecap="round"
                />
            </svg>
        </button>
    </div>
</template>

<script>
import { mapState } from 'vuex'
import { cloneData } from '@/utils/pagesStorage'
import { setDefaultcomponentData } from '@/store/snapshot'
import { MAX_PAGES } from '@/constants'

// 页签名最多显示 6 个字，多出来的显示成「..」（真实名字最多 20 字，悬停可见全名）
const NAME_MAX_DISPLAY = 6
// 名字本身的上限，和 store 里 renamePage 的截断保持一致
const NAME_MAX_LENGTH = 20

export default {
    name: 'PageBar',
    data() {
        return {
            // 正在就地改名的那一页下标（-1 = 没有在改名）
            editingIndex: -1,
            // 改名输入框里的临时值，只有回车 / 失焦才写回 store
            editValue: '',
        }
    },
    computed: {
        ...mapState([
            'pages',
            'curPageIndex',
            'componentData',
        ]),
        // 到上限就不再允许新增 / 复制
        isFull() {
            return (Array.isArray(this.pages) ? this.pages.length : 0) >= MAX_PAGES
        },
        // 上限数字给模板里的按钮提示用，改 constants 里的 MAX_PAGES 就够了
        maxPages() {
            return MAX_PAGES
        },
        // 每页是否有材质（true=已有材质，显示红圈；false=空白页，显示绿圈）
        // 一次算出全部页签的状态：模板里只取下标，不再每渲染一次就调两遍方法。
        // 当前页读内存里的 componentData（加/删材质立即变红/变绿）；
        // 其他页读该页自己保存的 componentData（切页后按本页内容显示）。
        pageFilled() {
            const pages = Array.isArray(this.pages) ? this.pages : []
            return pages.map((page, index) => {
                const list = index === this.curPageIndex
                    ? this.componentData
                    : (page && page.componentData)
                return Array.isArray(list) && list.length > 0
            })
        },
    },
    methods: {
        // 页签名显示：超过 6 个字只显示前 6 个 +「..」，页签宽度不再被长名字撑开；
        // 真实名字不截断，悬停 title 里能看到全名
        displayName(name) {
            const text = String(name || '').trim()
            return text.length > NAME_MAX_DISPLAY
                ? text.slice(0, NAME_MAX_DISPLAY) + '..'
                : text
        },

        // 双击页签 → 就地变输入框（不再弹 $prompt 弹窗）
        startRename(index) {
            const page = Array.isArray(this.pages) ? this.pages[index] : null
            if (!page) return
            this.editingIndex = index
            this.editValue = String(page.name || '')
            this.$nextTick(() => {
                const input = this.$el.querySelector('.page-tab-input')
                if (!input) return
                input.focus()
                input.select()
            })
        },

        // 回车 / 失焦：写回名字（空值不生效，名字不变）
        commitRename() {
            if (this.editingIndex < 0) return
            const index = this.editingIndex
            const value = String(this.editValue || '').trim().slice(0, NAME_MAX_LENGTH)
            this.editingIndex = -1
            this.editValue = ''
            if (!value) return
            this.$store.commit('renamePage', { index, name: value })
            this.persist()
        },

        // Esc：放弃这次修改
        cancelRename() {
            this.editingIndex = -1
            this.editValue = ''
        },

        // 把该页初始数据设为撤销的栈底（内容只存在内存里，不写浏览器缓存）
        persist() {
            setDefaultcomponentData(cloneData(this.componentData))
        },

        handleSwitch(index) {
            if (!Number.isInteger(index) || index === this.curPageIndex) return
            if (!Array.isArray(this.pages) || !this.pages[index]) return
            this.$store.commit('switchPage', index)
            this.persist()
        },

        // 新增 / 复制之后，确保页签高亮落在刚建的那一页（按页面 id 校验，不依赖下标）
        ensureNewPageActive() {
            const id = this.$store.state.lastPageId
            this.$nextTick(() => {
                const st = this.$store.state
                const pages = Array.isArray(st.pages) ? st.pages : []
                if (!pages.length) return
                const cur = pages[st.curPageIndex]
                if (id && (!cur || cur.id !== id)) {
                    const idx = pages.findIndex(page => page && page.id === id)
                    if (idx >= 0) this.$store.commit('switchPage', idx)
                }
                this.persist()
            })
        },

        handleAdd() {
            if (this.isFull) {
                this.$message.warning(`最多 ${MAX_PAGES} 个页面`)
                return
            }
            this.$store.commit('addPage')
            this.ensureNewPageActive()
            this.$message.success('已新增一页空白画布')
        },

        handleDuplicate() {
            if (this.isFull) {
                this.$message.warning(`最多 ${MAX_PAGES} 个页面`)
                return
            }
            this.$store.commit('duplicatePage')
            this.ensureNewPageActive()
            this.$message.success('已复制当前页')
        },

        // 刷新页面：整页重新加载，等于把编辑器恢复到刚打开的状态
        handleRefresh() {
            this.$confirm(
                '刷新页面会重新加载编辑器，当前未保存的编辑内容会清空。确定刷新？',
                '刷新页面',
                {
                    confirmButtonText: '确定刷新',
                    cancelButtonText: '取消',
                    type: 'warning',
                }
            )
                .then(() => {
                    window.location.reload()
                })
                .catch(() => null)
        },

        handleRemove(index) {
            const page = Array.isArray(this.pages) ? this.pages[index] : null
            if (!page) return

            this.$confirm(`确定删除「${page.name}」？该页内容删除后不可恢复。`, '删除页面', {
                confirmButtonText: '确定删除',
                cancelButtonText: '取消',
                type: 'warning',
            })
                .then(() => {
                    this.$store.commit('removePage', index)
                    this.persist()
                    this.$message.success('已删除该页')
                })
                .catch(() => null)
        },

    },
}
</script>

<style lang="scss" scoped>
// 内嵌在顶部工具栏里：画布大小 / 画布比例 输入框后面
.page-bar {
    display: flex;
    // 尺寸恒定：整组不再跟着窗口宽度伸缩，页签永远是完整大小
    // （空间不够时由顶部工具栏横向滚动，绝不把页签压窄）
    flex: 0 0 auto;
    align-items: center;
    box-sizing: border-box;
    // 保底宽度 = 「页面」标题 + 新增/复制/刷新三个图标按钮
    min-width: 180px;
    // 高度固定，和左侧按钮同一条水平线
    height: 32px;
    margin-left: 26px;
    padding: 0 6px;
    background: #f7f8fa;
    border: 1px solid #e8ebf0;
    border-radius: 6px;
    overflow: hidden;

    // 新增 / 复制图标按钮：和浏览器标签栏一样的小方块，固定尺寸不参与压缩
    > .page-tool {
        display: flex;
        flex: 0 0 auto;
        align-items: center;
        justify-content: center;
        width: 24px;
        height: 24px;
        margin-left: 6px;
        padding: 0;
        color: #606266;
        cursor: pointer;
        background: #fff;
        border: 1px solid #dcdfe6;
        border-radius: 4px;
        outline: none;
        transition: color 0.15s, border-color 0.15s;

        &:hover {
            color: #409eff;
            border-color: #409eff;
        }

        &:active {
            color: #fff;
            background: #409eff;
            border-color: #409eff;
        }

        // 到 8 页后按钮置灰，不再可点
        &:disabled {
            color: #c0c4cc;
            cursor: not-allowed;
            border-color: #ebeef5;
            background: #fafafa;
        }
    }

    .page-bar-title {
        flex: 0 0 auto;
        margin-right: 8px;
        font-size: 13px;
        color: #606266;
        white-space: nowrap;
    }

    .page-tabs {
        display: flex;
        // 页签按内容自然宽度排列：不压缩、不换行，页签多了让外层横向滚动
        flex: 0 0 auto;
        align-items: center;
        min-width: 0;
        // 比页签高 2px，给选中态的轻投影留一点显示空间
        height: 28px;
        overflow: hidden;
    }

    .page-tab {
        display: flex;
        // 关键：页签宽度由内容决定，窗口再窄也不许被压窄（压窄就会出现「1 页…」）
        flex: 0 0 auto;
        align-items: center;
        min-width: 36px;
        height: 26px;
        margin-right: 6px;
        padding: 0 5px;
        overflow: hidden;
        font-size: 12px;
        color: #606266;
        white-space: nowrap;
        cursor: pointer;
        user-select: none;
        background: #fff;
        border: 1px solid #dcdfe6;
        border-radius: 4px;
        transition: color 0.15s, border-color 0.15s, background-color 0.15s, box-shadow 0.15s;

        &:hover {
            color: #409eff;
            border-color: #c6e2ff;
            background: #f5faff;
        }

        // 当前页：跟 Element 的浅蓝选中态一致（浅蓝底 + 主题蓝字 + 细边框 + 轻投影），
        // 一眼能看出在哪一页，又不会像深色色块那样压住工具栏
        &.active {
            color: #409eff;
            font-weight: 600;
            background: #d9ecff;
            border-color: #409eff;
            box-shadow: 0 1px 4px rgba(64, 158, 255, 0.2);
        }

        .page-tab-name {
            // 名字最多显示 6 个字（多出来的在 displayName 里补「..」），页签宽度不被长名字撑开
            flex: 0 0 auto;
            min-width: 0;
            max-width: 8em;
            overflow: hidden;
            text-overflow: ellipsis;
            white-space: nowrap;
        }

        // 就地改名输入框：和页签名同一字号、同一高度，选中时浅蓝描边
        .page-tab-input {
            flex: 0 1 auto;
            width: 96px;
            height: 20px;
            min-width: 0;
            padding: 0 4px;
            font: inherit;
            color: #303133;
            background: #fff;
            border: 1px solid #409eff;
            border-radius: 3px;
            outline: none;
            // 页签整体禁用了选中，输入框里要能正常选中/拖蓝
            user-select: text;
            box-shadow: 0 0 0 2px rgba(64, 158, 255, 0.15);
        }

        // 页签状态小圈：页面名前面的小圆点，页签其他外观完全不动
        .page-tab-dot {
            flex: 0 0 auto;
            width: 6px;
            height: 6px;
            margin-right: 6px;
            border-radius: 50%;
            // 细描边让浅色背景上的圆点边界更清楚
            box-shadow: inset 0 0 0 1px rgba(0, 0, 0, 0.06);

            // 已有材质
            &.is-filled {
                background: #f56c6c;
            }

            // 空白页
            &.is-empty {
                background: #67c23a;
            }
        }

        .page-tab-close {
            flex: 0 0 auto;
            width: 13px;
            height: 13px;
            margin-left: 6px;
            font-size: 11px;
            line-height: 12px;
            text-align: center;
            border-radius: 50%;
            opacity: 0.7;

            &:hover {
                background: rgba(0, 0, 0, 0.15);
                opacity: 1;
            }
        }

        &.active .page-tab-close:hover {
            background: rgba(64, 158, 255, 0.18);
        }
    }
}
</style>
