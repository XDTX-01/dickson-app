// 编辑器里跨文件共用的几个常量。
// 以前这些数字散落在 store/pages.js、snapshot.js、Home.vue、PageBar.vue、Toolbar.vue 里，
// 想统一调整（比如页数上限、保存门槛）要逐个文件找，容易漏改。

// 页面数量上限：工具栏页签最多 6 个，避免越加越长
export const MAX_PAGES = 6

// 保存（导出 PNG）允许的最低画布比例，低于这个值画布太小、导出图会糊
export const SAVE_MIN_SCALE = 70

// 窗口尺寸变化后重新计算整体缩放的防抖时间（毫秒）
export const UI_SCALE_DEBOUNCE = 120

// 快照上限：每次记录都是整份画布的深拷贝（含图片 data URL，可能几 MB），
// 不设上限时长时间编辑会把内存吃满并让撤销/重做越来越卡
export const MAX_SNAPSHOTS = 40

// 快照指纹的递归深度上限：Group 里还能套 Group，畸形工程数据可能嵌套很深，
// 超过这个深度就截断成占位串，避免生成快照时把主线程拖死
export const SNAPSHOT_MAX_DEPTH = 12

// 标线吸附：基础吸附距离（大组件）与最小吸附距离（小组件）
// 组件越小吸附范围越窄，否则快缩到几十像素时还会被远处的东西「隔空吸住」
export const MARKLINE_BASE_SNAP_DISTANCE = 8
export const MARKLINE_MIN_SNAP_DISTANCE = 3

// 组件尺寸下限：属性面板直接输 0 / 负数会把材质压成一条线甚至渲染不出来
export const COMPONENT_MIN_SIZE = 5

// 旋转角度允许区间，超出自动钳制（继续转下去对画布没有意义）
export const ROTATE_ANGLE_MIN = -360
export const ROTATE_ANGLE_MAX = 360

// 导出总像素预算：超过这个量级浏览器很可能在 toPng 阶段吃满内存并崩标签页，
// 先提示用户再继续（4000×4000 = 16M 像素，2 倍图下约等于 2000×2000 的画布）
export const EXPORT_MAX_TOTAL_PIXELS = 4000 * 4000
