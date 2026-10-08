# Dickson-Color-Studio

Electron 可视化设计器应用（Vue2 + Element UI 前端 + 10 大类材质库）。

## 一、初始化与安装（首次）

```
npm init -y
npm install electron electron-builder --save-dev
```

## 二、运行应用（开发调试）

```
npm start
```

## 三、打包生成安装包

> 若打包时报 `unable to verify the first certificate`（证书校验失败，通常是安全软件/代理拦截），先执行第一条设置环境变量。

```
$env:NODE_TLS_REJECT_UNAUTHORIZED=0
npm run package
```

打包完成后，`dist` 文件夹会生成两个关键文件：

- `dickson-color-studio Setup <版本号>.exe`（安装包）
- `latest.yml`（版本信息，程序检测更新用，**必须随包一起上传**）

## 四、发布新版到 GitHub（让"检查更新"生效）

1. 修改 `package.json` 里的 `version`（如 `1.0.0` → `1.0.1`，**只能递增，不能减小**）
2. 执行上面的打包命令，生成新的安装包和 `latest.yml`
3. 打开仓库：https://github.com/XDTX-01/dickson-app
4. 点 **Releases** → **Create a new release**
   - **Tag version** 填：`v<版本号>`（如 `v1.0.1`）
   - **Release title** 填：`<版本号>`（如 `1.0.1`）
5. 把 `dist` 里的 **Setup.exe** 和 **latest.yml** **两个文件都**拖进 "Attach binaries"
6. 点 **Publish release**

> ⚠️ 关键：
> - `latest.yml` 必须上传，否则客户端点"检查更新"检测不到新版。
> - 每次发版用**新生成的** `latest.yml`，版本号只增不减。

## 五、自动发布（可选，免手动上传）

把 GitHub 令牌（`ghp_` 或 `github_pat_` 开头）保存到项目根目录的 `token.txt`，然后：

```
node release.js
```

`release.js` 会自动：读取 `token.txt` → 版本号 +1 → 打包 → 上传到 GitHub Releases。
