module.exports = {
    presets: [
        '@vue/cli-plugin-babel/preset',
    ],
    plugins: [
        // element-ui 按需引入：把 `import { Button } from 'element-ui'`
        // 改写成单组件引入，并自动带上 theme-chalk 里对应的 css
        [
            'component',
            {
                libraryName: 'element-ui',
                styleLibraryName: 'theme-chalk',
            },
        ],
    ],
}
