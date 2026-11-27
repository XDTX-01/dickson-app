# ::v-deep 穿透清单（升级 element-ui 前必看）

`::v-deep` 直接改的是 Element 组件内部 DOM 的类名，属于「不受自己控制的契约」。
当前全项目共 **16 处**，全部分布在两个文件里，且都已经挂在组件自己的根节点之下
（没有裸写在全局），所以不会串到别的组件。

| 文件 | 行 | 选择器 | 作用 | 升级风险 |
|---|---|---|---|---|
| `components/Toolbar.vue` | 314 | `.el-tabs__header` | 隐藏属性面板的标签头 | 中：类名稳定，但结构变化会露出来 |
| | 318 | `.el-tabs__content` | 允许内容溢出（不裁高度） | 低 |
| | 323 | `.el-form` | 表单横向排一行 | 低 |
| | 329 | `.el-form-item` | 取消 100px 固定宽度与下边距 | 中：item 结构变动会影响宽高 |
| | 337 | `.el-form-item__label` | 16px 窄标签、右对齐 | 中：label 类名 + `!important` |
| | 348 | `.el-form-item__content` | 去掉 100px 缩进 | 中 |
| | 354 | `.el-input` | 44px 小输入框 | 低 |
| | 359 | `.el-input__inner` | 24px 高、12px 字号、居中 | 中：input 内部结构变动 |
| | 371/372 | `input::-webkit-spin-button` | 去掉数字框上下箭头 | 低（浏览器行为） |
| | 384 | `.el-tabs__header` | 同上（属性面板外层） | 中 |
| | 387 | `.el-tabs__content` | 清掉内边距 | 低 |
| | 391 | `.el-tabs__item` | 取消固定高度 | 低 |
| `custom-component/*/Component.vue` | 288/297/303 | 组件自身样式 | 与 element 无关的普通嵌套 | 无 |

## 收敛建议（按风险从低到高）

1. **能给 el-* 组件加 class 的，优先加 class 再写样式**，例如
   `<el-tabs class="attr-panel">` → `.attr-panel ::v-deep ...`，
   避免「工具栏里所有 el-tabs 都被改」这种连带影响。
2. `.el-form-item__label { width: 16px !important }` 这类带 `!important` 的，
   可以改成给 `<el-form-item label-width="16px">` 传参，少一处硬覆盖。
3. 数字输入框去箭头（371/372）可以用纯 CSS `appearance: textfield` 放在组件根样式里，
   不依赖 scoped 穿透。
4. 每次升级 element-ui 后，至少回归：工具栏高度、宽高输入框是否 44×24、标签是否 16px 右对齐、
   属性面板是否只在点选组件时出现。

> 本次只做了「标注 + 清单化」，没有改动任何选择器——UI 已经按截图验收过，
> 大范围改选择器属于纯样式重构，风险高于收益，留到下次专门做一期。
