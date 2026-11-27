<template>
    <div class="mark-line">
        <div
            v-for="line in lines"
            v-show="lineStatus[line] || false"
            :key="line"
            :ref="line"
            class="line"
            :class="line.includes('x')? 'xline' : 'yline'"
        ></div>
    </div>
</template>

<script>
import eventBus from '@/utils/eventBus'
import { mapState } from 'vuex'
import { getComponentRotatedStyle } from '@/utils/style'
import {
    MARKLINE_BASE_SNAP_DISTANCE,
    MARKLINE_MIN_SNAP_DISTANCE,
} from '@/constants'

export default {
    data() {
        return {
            lines: ['xt', 'xc', 'xb', 'yl', 'yc', 'yr'], // 分别对应三条横线和三条竖线
            // 吸附阈值不再写死：大组件用基础值，组件越小收得越窄，
            // 真正的取值在 showLine 里按当前组件尺寸算（见 snapDistanceOf）
            diff: MARKLINE_BASE_SNAP_DISTANCE,
            snapDiff: MARKLINE_BASE_SNAP_DISTANCE,
            lineStatus: {
                xt: false,
                xc: false,
                xb: false,
                yl: false,
                yc: false,
                yr: false,
            },
        }
    },
    computed: mapState([
        'curComponent',
        'componentData',
    ]),
    mounted() {
        // 监听元素移动和不移动的事件，用具名 handler 以便卸载时精确解绑
        this.moveHandler = (isDownward, isRightward) => {
            this.showLine(isDownward, isRightward)
        }
        this.unmoveHandler = () => {
            this.hideLine()
        }
        eventBus.$on('move', this.moveHandler)
        eventBus.$on('unmove', this.unmoveHandler)
    },
    beforeDestroy() {
        if (this.moveHandler) eventBus.$off('move', this.moveHandler)
        if (this.unmoveHandler) eventBus.$off('unmove', this.unmoveHandler)
        this.moveHandler = null
        this.unmoveHandler = null
    },
    methods: {
        hideLine() {
            Object.keys(this.lineStatus).forEach(line => {
                this.lineStatus[line] = false
            })
        },

        // 取 ref 数组的第一个节点，取不到返回 null
        lineNode(name) {
            const arr = this.$refs[name]
            return (Array.isArray(arr) ? arr[0] : arr) || null
        },

        showLine(isDownward, isRightward) {
            const cur = this.curComponent
            if (!cur || !cur.style) return
            if (!Array.isArray(this.componentData)) return

            const components = this.componentData
            const curComponentStyle = getComponentRotatedStyle(cur.style)
            if (!Number.isFinite(curComponentStyle.width) || !Number.isFinite(curComponentStyle.height)) return

            const nodes = {
                xt: this.lineNode('xt'),
                xc: this.lineNode('xc'),
                xb: this.lineNode('xb'),
                yl: this.lineNode('yl'),
                yc: this.lineNode('yc'),
                yr: this.lineNode('yr'),
            }
            if (Object.values(nodes).some(node => !node)) return

            const curComponentHalfwidth = curComponentStyle.width / 2
            const curComponentHalfHeight = curComponentStyle.height / 2
            // 当前这一帧的吸附阈值：按被拖组件的尺寸自适应，小材质不会被远处误吸
            this.snapDiff = this.snapDistanceOf(curComponentStyle)

            this.hideLine()
            components.forEach(component => {
                if (!component || component === cur || !component.style) return
                const componentStyle = getComponentRotatedStyle(component.style)
                if (!Number.isFinite(componentStyle.width) || !Number.isFinite(componentStyle.height)) return
                const { top, left, bottom, right } = componentStyle
                const componentHalfwidth = componentStyle.width / 2
                const componentHalfHeight = componentStyle.height / 2
                const conditions = {
                    top: [
                        {
                            isNearly: this.isNearly(curComponentStyle.top, top),
                            lineNode: nodes.xt, // xt
                            line: 'xt',
                            dragShift: top,
                            lineShift: top,
                        },
                        {
                            isNearly: this.isNearly(curComponentStyle.bottom, top),
                            lineNode: nodes.xt, // xt
                            line: 'xt',
                            dragShift: top - curComponentStyle.height,
                            lineShift: top,
                        },
                        {
                            // 组件与拖拽节点的中间是否对齐
                            isNearly: this.isNearly(curComponentStyle.top + curComponentHalfHeight, top + componentHalfHeight),
                            lineNode: nodes.xc, // xc
                            line: 'xc',
                            dragShift: top + componentHalfHeight - curComponentHalfHeight,
                            lineShift: top + componentHalfHeight,
                        },
                        {
                            isNearly: this.isNearly(curComponentStyle.top, bottom),
                            lineNode: nodes.xb, // xb
                            line: 'xb',
                            dragShift: bottom,
                            lineShift: bottom,
                        },
                        {
                            isNearly: this.isNearly(curComponentStyle.bottom, bottom),
                            lineNode: nodes.xb, // xb
                            line: 'xb',
                            dragShift: bottom - curComponentStyle.height,
                            lineShift: bottom,
                        },
                    ],
                    left: [
                        {
                            isNearly: this.isNearly(curComponentStyle.left, left),
                            lineNode: nodes.yl, // yl
                            line: 'yl',
                            dragShift: left,
                            lineShift: left,
                        },
                        {
                            isNearly: this.isNearly(curComponentStyle.right, left),
                            lineNode: nodes.yl, // yl
                            line: 'yl',
                            dragShift: left - curComponentStyle.width,
                            lineShift: left,
                        },
                        {
                            // 组件与拖拽节点的中间是否对齐
                            isNearly: this.isNearly(curComponentStyle.left + curComponentHalfwidth, left + componentHalfwidth),
                            lineNode: nodes.yc, // yc
                            line: 'yc',
                            dragShift: left + componentHalfwidth - curComponentHalfwidth,
                            lineShift: left + componentHalfwidth,
                        },
                        {
                            isNearly: this.isNearly(curComponentStyle.left, right),
                            lineNode: nodes.yr, // yr
                            line: 'yr',
                            dragShift: right,
                            lineShift: right,
                        },
                        {
                            isNearly: this.isNearly(curComponentStyle.right, right),
                            lineNode: nodes.yr, // yr
                            line: 'yr',
                            dragShift: right - curComponentStyle.width,
                            lineShift: right,
                        },
                    ],
                }

                const needToShow = []
                const rotate = cur.style.rotate
                Object.keys(conditions).forEach(key => {
                    // 遍历符合的条件并处理
                    conditions[key].forEach((condition) => {
                        if (!condition.isNearly || !condition.lineNode) return
                        // 修改当前组件位移
                        this.$store.commit('setShapeSingleStyle', {
                            key,
                            value: rotate ? this.translatecurComponentShift(key, condition, curComponentStyle) : condition.dragShift,
                        })

                        condition.lineNode.style[key] = `${condition.lineShift}px`
                        needToShow.push(condition.line)
                    })
                })

                // 同一方向上同时显示三条线可能不太美观，因此才有了这个解决方案
                // 同一方向上的线只显示一条，例如多条横条只显示一条横线
                if (needToShow.length) {
                    this.chooseTheTureLine(needToShow, isDownward, isRightward)
                }
            })
        },

        translatecurComponentShift(key, condition, curComponentStyle) {
            const style = (this.curComponent && this.curComponent.style) || {}
            const width = Number(style.width) || 0
            const height = Number(style.height) || 0
            if (key == 'top') {
                return Math.round(condition.dragShift - (height - curComponentStyle.height) / 2)
            }

            return Math.round(condition.dragShift - (width - curComponentStyle.width) / 2)
        },

        chooseTheTureLine(needToShow, isDownward, isRightward) {
            // 如果鼠标向右移动 则按从右到左的顺序显示竖线 否则按相反顺序显示
            // 如果鼠标向下移动 则按从下到上的顺序显示横线 否则按相反顺序显示
            if (isRightward) {
                if (needToShow.includes('yr')) {
                    this.lineStatus.yr = true
                } else if (needToShow.includes('yc')) {
                    this.lineStatus.yc = true
                } else if (needToShow.includes('yl')) {
                    this.lineStatus.yl = true
                }
            } else {
                // eslint-disable-next-line no-lonely-if
                if (needToShow.includes('yl')) {
                    this.lineStatus.yl = true
                } else if (needToShow.includes('yc')) {
                    this.lineStatus.yc = true
                } else if (needToShow.includes('yr')) {
                    this.lineStatus.yr = true
                }
            }

            if (isDownward) {
                if (needToShow.includes('xb')) {
                    this.lineStatus.xb = true
                } else if (needToShow.includes('xc')) {
                    this.lineStatus.xc = true
                } else if (needToShow.includes('xt')) {
                    this.lineStatus.xt = true
                }
            } else {
                // eslint-disable-next-line no-lonely-if
                if (needToShow.includes('xt')) {
                    this.lineStatus.xt = true
                } else if (needToShow.includes('xc')) {
                    this.lineStatus.xc = true
                } else if (needToShow.includes('xb')) {
                    this.lineStatus.xb = true
                }
            }
        },

        /**
         * 吸附阈值按被拖组件尺寸自适应：
         * 取较窄边的一半，夹在 [MIN, BASE] 之间。
         * 350×750 的木饰面仍是 8px；缩到 40×40 时阈值变成 8px→min(8,20)=8…仍偏大，
         * 所以再用 min(边/2) 逐步收窄到 3px，避免小材质被远处吸走。
         *
         * @param {{width:number,height:number}} style 组件旋转后外框
         * @returns {number} 有效吸附距离（像素）
         */
        snapDistanceOf(style) {
            const width = Math.abs(Number(style && style.width) || 0)
            const height = Math.abs(Number(style && style.height) || 0)
            const minSide = Math.min(width || 0, height || 0)
            if (!minSide) return MARKLINE_MIN_SNAP_DISTANCE
            const half = minSide / 2
            return Math.max(
                MARKLINE_MIN_SNAP_DISTANCE,
                Math.min(MARKLINE_BASE_SNAP_DISTANCE, half)
            )
        },

        isNearly(dragValue, targetValue) {
            const diff = Number.isFinite(this.snapDiff) ? this.snapDiff : this.diff
            return Math.abs(dragValue - targetValue) <= diff
        },
    },
}
</script>

<style lang="scss" scoped>
.mark-line {
    height: 100%;
}

.line {
    background: #59c7f9;
    position: absolute;
    z-index: 1000;
}

.xline {
    width: 100%;
    height: 1px;
}

.yline {
    width: 1px;
    height: 100%;
}
</style>
