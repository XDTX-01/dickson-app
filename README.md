# 变更文件（2026-11-27）

目录结构与项目根一致，直接按相对路径覆盖回
`C:\Users\Administrator\Desktop\dickson\Furniture-colormatching-net-dickson` 即可。

共 **28 个文件**：本轮（第二轮 13 项 + 快捷键守卫）改了 21 个，
另有 **7 个是更早轮次的配置/入口文件**（本次没动，但为了让这份目录能独立跑通 lint/test/build，一并附上，见下节「配置类文件」）。

## 覆盖步骤

1. 先备份原工程（例如复制一份整个目录）；
2. 把本目录下的 `src\`、`tests\`、`public\`、`.github\` 覆盖到工程根对应目录；
3. 把根目录的 `package.json`、`package-lock.json`、`babel.config.js`、`vue.config.js`、`.eslintrc.js`、`TODO-E2E-TEST.md`、`STYLE-DEEP-AUDIT.md` 复制到工程根；
4. 在工程根执行 `npm install`（lock 已配套，`npm ci` 也行），然后：
   ```
   npx vue-cli-service lint --no-fix
   npm test -- --ci
   npm run build
   ```
   预期：lint 0 错误 / 6 suites 55 tests 全绿 / Build complete。


## 文件清单与作用

| 文件 | 状态 | 作用 |
|---|---|---|
| `src/constants.js` | 改 | 新增 7 个常量：快照深度、吸附基础/最小距离、组件最小尺寸、旋转区间、导出像素预算 |
| `src/utils/snapshotFingerprint.js` | 改 | 指纹递归深度截断 + `WeakMap` 缓存复用（Group 嵌套不再重复遍历） |
| `src/store/snapshot.js` | 改 | 新增 `resetSnapshotSignatures()`，供换页/复制页清空指纹 |
| `src/store/pages.js` | 改 | `loadPage` 切页时清空指纹，撤销栈跨页隔离 |
| `src/store/index.js` | 改 | 新增 `setComponentFieldById` mutation（属性面板不再直接改 state 对象） |
| `src/utils/style.js` | 改 | 空值防御 + JSDoc，不再产出 `undefinedpx` / `rotate(undefineddeg)` |
| `src/utils/utils.js` | 改 | JSDoc 补齐（`swap` / `$` / `isPreventDrop`） |
| `src/utils/shortcutKey.js` | 改 | `isEditableTarget` 焦点守卫 + 失焦复位 Ctrl 状态 |
| `src/utils/validate.js` | **新增** | 宽高/角度的数字校验与回退 |
| `src/utils/storageHelper.js` | **新增** | localStorage 配额预估、安全读写、IndexedDB 草稿、配额查询 |
| `src/utils/exportState.js` | **新增** | `Vue.observable` 全局导出锁（Toolbar 按钮 loading/置灰） |
| `src/components/PageBar.vue` | 改 | 双击只绑页签名（点圆点/关闭×不再误改名） |
| `src/components/Toolbar.vue` | 改 | 保存按钮 loading+置灰、重复点击拦截、deep 穿透标注 |
| `src/components/Editor/MarkLine.vue` | 改 | 吸附阈值按组件尺寸自适应（3~8px） |
| `src/components/Editor/Preview.vue` | 改 | 导出像素预算确认 + 导出锁的置位/释放（含超时、关闭兜底） |
| `src/custom-component/common/CommonAttr.vue` | 改 | 数字输入校验回退，颜色/下拉/折叠全部走 mutation |
| `tests/unit/validate.spec.js` | **新增** | 4 组校验用例 |
| `tests/unit/storageAndSnapshot.spec.js` | **新增** | 深度截断、缓存复用、脏数据、字节计算、存储降级 |
| `tests/unit/shortcutKey.spec.js` | **新增** | 焦点守卫 4 组用例 |
| `TODO-E2E-TEST.md` | **新增** | 待补的集成/E2E 用例清单（25 条） |
| `STYLE-DEEP-AUDIT.md` | **新增** | 全项目 16 处 `::v-deep` 清单与收敛建议 |

## 配置类文件（更早轮次改的，本次未动）

下面 7 个不是这一轮的改动，但**工程里确实是改过的版本**（不是 vue-cli 模板原样），
只发 `src/` 会导致你那边跑不起来测试和按需引入，所以一并附上：

| 文件 | 里面有什么（可自行核对） | 来自哪一轮 |
|---|---|---|
| `package.json` | `"test": "jest"` + `jest` 配置块（testEnvironment / testMatch / babel-jest）；devDeps 含 `jest@^29.7.0`、`babel-jest`、`babel-plugin-component`；已删 `axios` | 单测与 CI / 按需引入 / 依赖清理 |
| `package-lock.json` | 与上面 package.json 配套的锁文件（592 KB），保证 `npm ci` 装的版本一致 | 同上 |
| `babel.config.js` | `plugins: [['component', { libraryName: 'element-ui', styleLibraryName: 'theme-chalk' }]]` —— Element UI 按需引入的关键 | Element 按需引入 |
| `.eslintrc.js` | `overrides: [{ files: ['tests/**/*.js'], env: { jest: true } }]` —— 否则 `describe/expect` 会报 no-undef | 单测与 CI |
| `.github/workflows/manual-build-sync.yml` | 步骤链：`npm ci` → `lint --no-fix` → `npm test -- --ci` → `npm run build` | 单测与 CI |
| `vue.config.js` | CSP `connect-src` 开发环境放行 `ws: wss:`、生产仅 `'self'`；`terser` 去掉 console；生产开 gzip | 本地白屏问题与打包优化 |
| `public/index.html` | `<meta>` CSP（`default-src 'self'` 等），与上面 vue.config.js 的 CSP 通道配套 | 同上 |

要不要这几个配置取决于你的用法：
- **只想对比/参考代码改动** → 忽略这 7 个即可，看 `src/`、`tests/`、两份 `.md`；
- **想拿一份能直接跑起来的新工程** → 全部覆盖，然后 `npm install`。

## 注意

- `Editor/Preview.vue`、`Toolbar.vue` 与更早那批「按需引入 / 页签改名 / 比例控件」改动是同一个文件，
  覆盖时请以本目录版本为准（已包含那些改动）。
- `public/img`（215 张材质图 41 MB）不在本目录内，覆盖时保留你原有的素材即可。
