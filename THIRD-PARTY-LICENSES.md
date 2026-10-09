# THIRD-PARTY SOFTWARE NOTICES / 第三方软件许可声明

> **适用范围**：本文件记录 **dickson-color-studio** 应用在打包分发时引入的全部第三方开源软件及其版权与许可，覆盖所有**随安装包分发**的依赖。本项目自身代码的许可见根目录 `LICENSE` 文件，不在本文件范围内。
>
> **目的**：履行各开源许可"保留版权声明与许可文本"的义务，并对分发行为作合规说明，尽最大可能避免任何版权或许可违规。

---

## 第 0 部分 · 项目自身

| 项目 | 内容 |
|---|---|
| 项目名称 | dickson-color-studio |
| 版权人 | Little Deng Student |
| 本项目代码许可 | MIT License（详见根目录 `LICENSE` 文件） |

> 本文件不覆盖本项目自身代码及项目自有素材。项目内素材（图片、图标、字体等）均为项目所有者**自有或已获授权**，版权归项目所有者，不涉及第三方许可。

---

## 第 1 部分 · 前端打包产物引入的第三方库（随安装包分发）

以下库被打包进 `src/js` 前端产物，随安装包一同分发：

| # | 库 | 用途 | 版权 | 许可 |
|---|---|---|---|---|
| 1 | **Vue.js** | 前端框架 | Copyright (c) 2014-2022 Evan You | MIT |
| 2 | Vue 生态组件（Vue Router / Vuex 等） | 路由与状态管理 | Copyright (c) 2021 Evan You | MIT |
| 3 | **Element UI** | 组件库 | Copyright (c) 2016-2018 ElemeFE | MIT |
| 4 | **vue-lazyload** | 图片懒加载 | Copyright (c) 2021 Awe \<hilongjw@gmail.com\> | MIT |
| 5 | **lodash** | 工具库 | Copyright JS Foundation and other contributors | MIT |
| 6 | **underscore** | 工具库 | Copyright Jeremy Ashkenas, DocumentCloud and Investigative Reporters & Editors | MIT |
| 7 | **bignumber.js** | 任意精度数值计算 | Copyright (c) 2020, 2021 Robert Eisele | MIT |
| 8 | **kind-of** | 类型判断 | Copyright (c) 2014-2015, Jon Schlinkert | MIT |

> **补录说明**：Element UI 的版权 banner 在 webpack 构建时被剥离，此处补录其版权与许可，作为保留版权声明的书面记录。
>
> 以上各库均以 **MIT License** 授权，完整许可文本见文末【附 A】。

---

## 第 2 部分 · 主进程运行时依赖（随安装包分发）

以下依赖随应用主进程打包进 `asar` 一同分发（因 `main.js` 引用了 `electron-updater`）：

| # | 库 | 版本 | 许可 |
|---|---|---|---|
| 9 | **electron-updater**（自动更新库） | 6.8.9 | MIT |
| 10 | fs-extra（文件系统扩展） | 8.1.0 | MIT |
| 11 | js-yaml（YAML 解析） | 4.1.0 | MIT |
| 12 | lazy-val（延迟求值） | 1.0.5 | MIT |
| 13 | lodash.escaperegexp | 4.1.2 | MIT |
| 14 | lodash.isequal | 4.5.0 | MIT |
| 15 | **semver（版本比较）** | 6.3.1 | **ISC** |
| 16 | tiny-typed-emitter（类型化事件） | 2.1.0 | MIT |
| 17 | builder-util-runtime | 9.1.1 | MIT |

> **注意**：第 15 项 `semver` 使用 **ISC License**（非 MIT），其完整许可文本见文末【附 B】。其余均以 MIT License 授权（【附 A】）。

---

## 第 3 部分 · Electron 运行时及其自带组件

| 组件 | 许可 | 说明 |
|---|---|---|
| Electron 本体 | MIT License | 应用运行时框架 |
| Chromium / Node.js / V8 及第三方组件 | 各自许可（BSD、Apache 等） | 完整许可清单由官方 **`LICENSES.chromium.html`** 提供 |

> **务必**：官方 `LICENSES.chromium.html` 已随安装包进入应用目录（`dist/win-unpacked/LICENSES.chromium.html`），**请勿删除**。该文件覆盖 Chromium 及内置第三方组件的完整许可，本文件不重复其内容。

---

## 第 4 部分 · 打包 / 开发依赖（不随安装包分发）

以下工具仅用于构建安装包，**不进入最终分发的安装包**。其各自 `LICENSE` 保留在 `node_modules` 各包目录内，随源码/工程保留即可，无需随安装包分发：

- electron-builder 及其传递依赖（electron-publish、app-builder-lib、builder-util 等）
- 各类构建、压缩、校验工具

---

## 第 5 部分 · 字体与商标说明

- 字体：Element UI 自带图标字体（`element-icons.*`）随 Element UI 的 MIT 许可使用，无额外版权负担；项目其他字体为自有或已获授权。
- 商标："dickson-color-studio" 为本项目自行命名；若与第三方商标重名，请注意相关商标风险。

---

## 第 6 部分 · 合规与分发检查清单

对外发布安装包 / 上传 GitHub 前，建议逐项核对：

1. ✅ 根目录存在 `LICENSE`（本项目 MIT，版权人正确）
2. ✅ 根目录存在本文件（第三方许可声明）
3. ✅ 未删除 Electron 官方 `LICENSES.chromium.html`
4. ✅ 每次发版递增 `version`（避免版本回退）
5. ✅ 发布前用干净环境重新打包，确认产物包含上述文件
6. ✅ README 中如实说明外部素材来源与授权情况（如有）

---

## 第 7 部分 · 版权边界与声明

- 本文件仅汇总第三方开源软件的许可信息。
- 项目自身代码及项目内素材（图片、图标、字体等）归项目所有者所有或已获授权，版权归项目所有者。
- 若第三方权利人对本文件所列内容提出异议，请通过项目仓库 Issues 反馈，将及时更正。

---

## 附 A · MIT License（适用于所有 MIT 授权依赖）

```text
MIT License

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

---

## 附 B · ISC License（适用于 semver）

```text
ISC License

Copyright (c) 2004-present Isaac Z. Schlueter and Contributors

Permission to use, copy, modify, and/or distribute this software for any
purpose with or without fee is hereby granted, provided that the above
copyright notice and this permission notice appear in all copies.

THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES
WITH REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF
MERCHANTABILITY AND FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR
ANY SPECIAL, DIRECT, INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES
WHATSOEVER RESULTING FROM LOSS OF USE, DATA OR PROFITS, WHETHER IN AN
ACTION OF CONTRACT, NEGLIGENCE OR OTHER TORTIOUS ACTION, ARISING OUT OF OR
IN CONNECTION WITH THE USE OR PERFORMANCE OF THIS SOFTWARE.
```
