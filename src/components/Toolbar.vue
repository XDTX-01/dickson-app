<template>
  <div class="toolbar">
    <!-- 左侧可滚动区：窗口不够宽时只有这一块横向滚动，右侧属性/比例永远贴边可见 -->
    <div class="tb-main">
      <div class="dickson">Dickson家装配色</div>
      <el-button @click="undo">撤销</el-button>
      <el-button @click="redo">前进</el-button>

      <el-button @click="clearCanvas">清空</el-button>
      <el-button
        :type="isTextTool ? 'primary' : ''"
        @click="toggleTextTool"
        title="点击后在画布上点一下即可输入文字"
        >文字</el-button
      >
      <el-button :disabled="!curComponent || curComponent.isLock" @click="lock"
        >锁定</el-button
      >
      <el-button :disabled="!curComponent || !curComponent.isLock" @click="unlock"
        >解锁</el-button
      >
      <!-- <el-button style="margin-left: 10px" @click="preview(false)"
        >预览</el-button
      > -->
      <!-- 保存 = 按画布当前尺寸 1:1 导出 PNG（不弹另存为，直接落盘到「图片」）
           导出期间按钮 loading + 置灰：连点不会并行跑多份导出任务 -->
      <el-button
        :loading="exportBusy"
        :disabled="exportBusy"
        @click="preview(true)"
        >{{ exportBusy ? "保存中…" : "保存" }}</el-button
      >
      <el-button @click="openImport">导入</el-button>
      <input
        ref="importInput"
        type="file"
        accept=".png"
        class="import-input"
        @change="handleImportFile"
      />

      <!-- 多页面 / 多画布切换：旧页面数据完整保留 -->
      <PageBar />
    </div>

    <!-- 右侧固定区：宽高属性 + 画布比例，整组贴在最右 -->
    <div class="right-tools">
      <div v-if="curComponent" class="attr-tools">
        <el-tabs v-model="activeName">
          <component :is="curComponent.component + 'Attr'" />
        </el-tabs>
      </div>
      <!-- 比例：填数字，或点 % 右边的 − / + 每次 10%（逻辑在 ScaleControl 里） -->
      <ScaleControl />
    </div>
  </div>
</template>

<script>
import { mapState } from "vuex";
import PageBar from "@/components/PageBar";
import ScaleControl from "@/components/ScaleControl";
import eventBus from "@/utils/eventBus";
import { MAX_PAGES } from "@/constants";
import {
  buildImportPage,
  fileSizeMB,
  fileTooLarge,
  isDuplicateImport,
  looksLikeImageFile,
  readProjectFromPngFile,
} from "@/utils/projectImport";
import { exportState, isExportBusy } from "@/utils/exportState";

export default {
  components: { PageBar, ScaleControl },
  data() {
    return {
      activeName: "attr",
    };
  },
  computed: {
    ...mapState([
      "componentData",
      "canvasStyleData",
      "areaData",
      "curComponent",
      "curComponentIndex",
      "isTextTool",
    ]),
    // 导出进行中：按钮 loading + 置灰（状态在 utils/exportState 里，Preview 里切换）
    exportBusy() {
      return exportState.busy;
    },
  },
  created() {
    eventBus.$on("preview", this.preview);
    eventBus.$on("clearCanvas", this.clearCanvas);
  },
  beforeDestroy() {
    // 全局事件总线是单例：不解绑会让已销毁的工具栏实例一直被引用
    eventBus.$off("preview", this.preview);
    eventBus.$off("clearCanvas", this.clearCanvas);
  },
  methods: {
    lock() {
      this.$store.commit("lock");
    },

    toggleTextTool() {
      // 切换文字工具：激活后，画布上点一下即可输入文字
      this.$store.commit("setTextTool", !this.isTextTool);
    },

    unlock() {
      this.$store.commit("unlock");
    },

    undo() {
      this.$store.commit("undo");
    },

    redo() {
      this.$store.commit("redo");
    },

    preview(isScreenshot) {
      // 导出锁：上一次保存还没走完时，再点一次直接忽略，避免并行跑多份导出把 CPU 打满
      if (isScreenshot && isExportBusy()) {
        this.$message.warning("正在导出上一张图片，请稍候");
        return;
      }
      // 窗口最小化 / 被切到后台时 Chromium 会节流渲染，导出会一直停在「生成中」；
      // 点保存时先让桌面端把窗口还原到前台（不阻塞流程），再去开预览层。
      if (
        isScreenshot &&
        typeof window !== "undefined" &&
        typeof window.dicksonEnsureVisible === "function"
      ) {
        try {
          window.dicksonEnsureVisible();
        } catch (e) {
          // 忽略：拿不到窗口能力时按原流程走
        }
      }
      // 预览遮罩由 Home 渲染（不能挂在工具栏里，否则会被工具栏的横向滚动区域裁掉）
      this.$store.commit("setEditMode", "preview");
      this.$emit("preview", Boolean(isScreenshot));
    },

    openImport() {
      if (this.$refs.importInput) this.$refs.importInput.click();
    },

    // 只接受本软件「保存」出来的成片：那种 PNG 里内嵌了工程数据，能还原成可拖动材质；
    // 普通外部图片 / HTML / JSON 一律拒绝。解析细节都在 utils/projectImport.js
    async handleImportFile(e) {
      const file = e.target.files && e.target.files[0];
      // 清空 value，允许连续两次选同一个文件
      e.target.value = "";
      if (!file || isDuplicateImport(file)) return;

      if (!looksLikeImageFile(file)) {
        this.$message.warning(
          "只支持本软件「保存」出来的 PNG（图片里自带工程数据）；普通文件无法导入"
        );
        return;
      }
      if (fileTooLarge(file)) {
        this.$message.warning(
          `文件过大（${fileSizeMB(file)}MB），请选择本软件保存的配色图`
        );
        return;
      }
      if (this.$store.state.pages.length >= MAX_PAGES) {
        this.$message.warning(`页面已有 ${MAX_PAGES} 页，已达上限，先删一页再导入`);
        return;
      }

      try {
        const project = await readProjectFromPngFile(file);
        if (!project) {
          // 普通外部图片不含工程数据，按规则不允许导入
          this.$message.warning(
            "只支持本软件「保存」出来的 PNG（图片里自带工程数据）；普通文件无法导入"
          );
          return;
        }
        const page = buildImportPage(project);
        if (!page) {
          this.$message.warning("这张图里没有可还原的材质，无法导入");
          return;
        }
        if (MAX_PAGES - this.$store.state.pages.length <= 0) {
          this.$message.warning(`页面已有 ${MAX_PAGES} 页，已达上限，先删一页再导入`);
          return;
        }
        this.$store.commit("appendPages", [page]);
        const cur = this.$store.state.pages[this.$store.state.curPageIndex];
        this.$message.success(
          `已导入为「${cur ? cur.name : "导入"}」页（${page.componentData.length} 块材质，可继续拖动）`
        );
      } catch (err) {
        this.$message.error("文件读取失败，请重试");
      }
    },

    clearCanvas() {
      this.$store.commit("setCurComponent", { component: null, index: null });
      this.$store.commit("setComponentData", []);
      this.$store.commit("recordSnapshot");
    },
  },
};
</script>

<style lang="scss" scoped>
.toolbar {
  display: flex;
  // 永远单行：绝不折行、也绝不压缩控件
  flex-wrap: nowrap;
  align-items: center;
  // 总高写死：不管窗口多宽多窄，工具栏高度永远一致（32px 控件 + 上下留白 + 滚动条）
  height: 46px;
  min-height: 46px;
  box-sizing: border-box;
  padding: 0 7px;
  white-space: nowrap;
  // 滚动交给 .tb-main：右侧属性/比例永远贴边可见，不会被一起滚出屏幕
  overflow: hidden;
  // 工具栏在 .home 里是 flex 行项目：不允许被压缩，否则内容会被裁掉
  flex: 0 0 auto;
  background: #fff;
  border-bottom: 2px solid #ccc;

  .tb-main {
    display: flex;
    align-items: center;
    flex: 1 1 auto;
    min-width: 0;
    height: 100%;
    overflow-x: auto;
    overflow-y: hidden;
    // 全局把所有滚动条隐藏了，这里要单独放出来，否则用户不知道能横向滚
    scrollbar-width: auto;
  }

  // 细一点、浅一点的横向滚动条：看得见但不抢眼
  &::-webkit-scrollbar {
    display: block;
    height: 5px;
  }
  &::-webkit-scrollbar-track {
    background: transparent;
  }
  &::-webkit-scrollbar-thumb {
    background: #d8d8d8;
    border-radius: 3px;

    &:hover {
      background: #c0c0c0;
    }
  }

  // 顶部按钮：彼此之间留一点呼吸，左右也留一点边距（内容不够宽时由外层横向滚动）
  .el-button {
    // 按钮尺寸写死：窗口变窄时既不压缩也不降字号，始终保持同一个高度
    height: 32px;
    margin-left: 8px;
    // 横向内边距 10px：按钮文字左右各多一点留白，只影响宽度、不影响高度
    padding: 0 10px;
    font-size: 14px;
    line-height: 30px;
    flex: 0 0 auto;
  }

  .el-button + .el-button {
    margin-left: 8px;
  }

  // 隐藏的导入文件选择框
  .import-input {
    display: none;
  }

  .dickson {
    display: flex;
    padding: 2px;
    font: 22px/100% "幼圆";
    margin-right: 12px;
    white-space: nowrap;
    flex: 0 0 auto;
  }

  // 右侧区：margin-left:auto 把剩余空间都推到左边，宽高 + 比例贴在本行最右
  .right-tools {
    display: flex;
    align-items: center;
    margin-left: 8px;
    padding-left: 8px;
    border-left: 1px solid #eee;
    background: #fff;
    flex: 0 0 auto;
  }

  // 选中组件的宽高属性：贴在 100 % 左边，做成很紧凑的一小组
  // 【升级 element-ui 时重点回归】这一块里的 ::v-deep 依赖 element 的内部类名
  // （.el-tabs__header / .el-form-item__label / .el-input__inner 等），
  // 版式一旦改名，工具栏会变高或者标签错位。完整清单见根目录 STYLE-DEEP-AUDIT.md
  .attr-tools {
    display: flex;
    flex: 0 0 auto;
    align-items: center;
    margin-left: 12px;
    margin-right: 6px;

    &::v-deep .el-tabs__header {
      display: none;
    }

    &::v-deep .el-tabs__content {
      overflow: visible;
    }

    // 横向排成一行：宽 [350] 高 [750]
    &::v-deep .el-form {
      display: flex;
      align-items: center;
    }

    // 每项取消默认的 100px 宽度和底部间距，只留标签 + 输入框
    &::v-deep .el-form-item {
      display: flex;
      align-items: center;
      width: auto;
      margin: 0 5px 0 0;
      line-height: 1;
    }

    &::v-deep .el-form-item__label {
      float: none;
      width: 16px !important;
      padding: 0 2px 0 0;
      font-size: 12px;
      line-height: 24px;
      color: #606266;
      text-align: right;
    }

    // 内容区不再给标签预留 100px 的缩进
    &::v-deep .el-form-item__content {
      width: auto;
      margin-left: 0 !important;
      line-height: 24px;
    }

    &::v-deep .el-input {
      width: 44px !important;
    }

    // 小号输入框：24px 高、文字居中，比工具栏按钮再小一档
    &::v-deep .el-input__inner {
      width: 100%;
      height: 24px;
      padding: 0 2px;
      font-size: 12px;
      line-height: 24px;
      color: #606266;
      text-align: center;
      border-radius: 4px;
    }

    // 去掉数字输入框的上下小箭头，免得显得笨重
    &::v-deep input::-webkit-outer-spin-button,
    &::v-deep input::-webkit-inner-spin-button {
      margin: 0;
      -webkit-appearance: none;
    }
  }

  // 说明：以前这里有 1280 / 1100 / 940 三档响应式收缩（改 padding、降字号、隐藏标题）。
  // 结果窗口一变窄按钮就被压扁、页签被挤成「1 页…」，两种宽度下完全不是一个样子。
  // 现在统一取消：所有控件尺寸恒定，空间不够时由外层横向滚动解决。

  // 属性面板不撑高标题栏：隐藏标签头、压缩内容，点击文字/选中组件后标题栏高度保持不变
  .el-tabs {
    ::v-deep .el-tabs__header {
      display: none;
    }
    ::v-deep .el-tabs__content {
      padding: 0;
      line-height: 1.4;
    }
    ::v-deep .el-tabs__item {
      height: auto;
      padding: 0;
    }
  }

  .insert {
    display: inline-block;
    line-height: 1;
    white-space: nowrap;
    cursor: pointer;
    background: #fff;
    border: 1px solid #dcdfe6;
    color: #606266;
    appearance: none;
    text-align: center;
    box-sizing: border-box;
    outline: 0;
    margin: 0;
    transition: 0.1s;
    font-weight: 500;
    padding: 10px 15px;
    font-size: 12px;
    border-radius: 3px;
    margin-left: 10px;

    &:active {
      color: #3a8ee6;
      border-color: #3a8ee6;
      outline: 0;
    }

    &:hover {
      background-color: #ecf5ff;
      color: #3a8ee6;
    }
  }
}
</style>
