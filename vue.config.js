const CompressionPlugin = require('compression-webpack-plugin')

const isProd = process.env.NODE_ENV === 'production'

module.exports = {
    publicPath: './',
    // 不生成 .map，安装包里不再带源码映射
    productionSourceMap: false,
    // Vue CLI 自带的 Terser 直接接管，无需额外安装 terser-webpack-plugin：
    // 生产构建时剔除 console / debugger，压缩 JS 并去掉注释
    terser: isProd
        ? {
            terserOptions: {
                compress: {
                    drop_console: true,
                    drop_debugger: true,
                },
                format: {
                    comments: false,
                },
            },
        }
        : undefined,
    chainWebpack: (config) => {
        // CSP 的 connect-src 只在开发环境放宽到 ws/wss：
        // dev server 的热更新通道（ws://<局域网IP>:<port>/ws）在默认端口不同源，会被 'self' 拦掉；
        // 生产构建仍然只有 'self'，不允许任何外部连接。
        config.plugin('html').tap((args) => {
            args[0].cspConnectSrc = isProd ? '\'self\'' : '\'self\' ws: wss:'
            return args
        })
    },
    configureWebpack: () => {
        if (isProd) {
            return {
                plugins: [
                    new CompressionPlugin({
                        // 只压 JS / HTML / CSS，图片一张都不碰，原图原样输出
                        test: /\.js$|\.html$|\.css$/,
                        threshold: 10240,
                        minRatio: 1,
                        deleteOriginalAssets: false,
                    }),
                ],
            }
        }
        // 开发环境默认用 eval 形式的 devtool，而 index.html 里的 CSP 不允许 'unsafe-eval'，
        // 打开本地页面会直接白屏卡在「正在努力加载页面」。
        // 这里改成非 eval 的 source-map，既保留严格 CSP，又能本地跑起来。
        return {
            devtool: 'cheap-module-source-map',
        }
    },
}
