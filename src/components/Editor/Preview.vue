<template>
  <div ref="container" class="bg">
    <div v-if="saving" class="saving-mask">
      <div class="saving-box">
        <div class="saving-title">{{ savingTitle }}</div>
        <div class="saving-sub">
          画布 {{ sheetTotalWidth }}×{{ sheetAreaH }} · 共
          {{ usedMaterials.length }} 种材质，请稍候
        </div>
      </div>
    </div>
    <div ref="container" class="canvas-container">
      <div class="sheet-fit" :style="fitStyle">
      <div
        ref="sheet"
        class="sheet"
        :style="{
          ...sheetTransform,
          width: sheetTotalWidth + 'px',
          height: sheetAreaH + 'px',
        }"
      >
        <div
          class="canvas"
          :style="{
            ...getCanvasStyle(canvasStyleData),
            width: sheetWidth + 'px',
            height: sheetHeight + 'px',
            left: canvasLeft + 'px',
            top: canvasTop + 'px',
          }"
        >
          <ComponentWrapper
            v-for="(item, index) in copyData"
            :key="index"
            :config="item"
          />
          <!-- 导出的图里每块材质左上角直接标名字，不再需要右侧清单 -->
          <div
            v-for="tag in materialTags"
            :key="tag.key"
            class="name-tag"
            :style="{ left: tag.left + 'px', top: tag.top + 'px' }"
            >{{ tag.label }}</div
          >
        </div>
        <!-- 保存图片时右侧附「使用材质」清单：比之前窄一档，只列用到的材质 -->
        <div
          v-if="isScreenshot"
          class="legend"
          :style="{
            height: legendFullHeight + 'px',
            left: legendLeft + 'px',
            width: legendWidth + 'px',
          }"
        >
          <div class="legend-head">
            <div class="legend-title">使用材质</div>
            <div class="legend-sub">共 {{ usedMaterials.length }} 种</div>
          </div>
          <div
            ref="legendBody"
            class="legend-body"
            :style="{
              transform: 'scale(' + legendScale + ')',
              transformOrigin: 'top left',
            }"
          >
            <div class="legend-list">
              <template v-for="group in usedGroups">
                <div :key="'c-' + group.category" class="legend-cate">
                  <span class="cate-name">{{ group.category }}</span>
                  <span class="cate-count">{{ group.items.length }}</span>
                </div>
                <div
                  v-for="(m, i) in group.items"
                  :key="group.category + '-' + m.label + i"
                  class="legend-item"
                >
                  <div class="thumb">
                    <img :src="m.url" alt="" />
                    <span v-if="m.count > 1" class="count">×{{ m.count }}</span>
                  </div>
                  <div class="name">{{ m.label }}</div>
                </div>
              </template>
            </div>
            <div v-if="!usedMaterials.length" class="legend-empty">
              画布上还没有放材质
            </div>
          </div>
        </div>
      </div>
      <!-- 取消 / 确定 跟着白页走：始终贴在白页右上角上方，窗口怎么缩都保持同一距离 -->
      <div class="actions">
        <el-button class="act" :disabled="saving" @click="close">{{
          isScreenshot ? "取消" : "关闭"
        }}</el-button>
        <el-button
          v-if="isScreenshot"
          type="primary"
          class="act"
          :loading="saving"
          @click="htmlToImage"
          >{{ saving ? "生成中…" : "确定" }}</el-button
        >
      </div>
      </div>
    </div>
  </div>
</template>

<script>
import { getStyle, getCanvasStyle } from "@/utils/style";
import { mapState } from "vuex";
import ComponentWrapper from "./ComponentWrapper";
import { changeStyleWithScale } from "@/utils/translate";
import { embedProjectIntoPng } from "@/utils/pngProject";
import { deepCopy } from "@/utils/utils";
import { cloneData } from "@/utils/pagesStorage";
// 尺寸 / 几何 / 材质清单的纯计算，以及压缩、出图两步，都拆到 utils 里了
import {
  EXPORT,
  sheetGeometryOf,
  componentBoundsOf,
  materialTagsOf,
  usedMaterialsOf,
  materialGroupsOf,
  fitScaleOf,
  legendScaleOf,
} from "@/utils/previewLayout";
import { withTimeout, frameDelay, downscaleImages, captureSheet } from "@/utils/previewExport";
import { setExportBusy, isExportBusy } from "@/utils/exportState";
import { EXPORT_MAX_TOTAL_PIXELS } from "@/constants";

export default {
  components: { ComponentWrapper },
  props: {
    isScreenshot: {
      type: Boolean,
      default: false,
    },
  },
  data() {
    return {
      copyData: [],
      viewW: 1280,
      viewH: 800,
      capturing: false,
      saving: false,
      // 生成阶段不同（正在出图 / 等着在另存为里选位置），提示文案要跟着变，
      // 否则用户看到弹窗时遮罩还写着「正在生成图片…」，会以为还在卡着
      savingTitle: "正在生成图片…",
      legendScale: 1,
      // 右侧材质清单宽度
      legendWidth: 320,
      // 画布左侧基础留白归零，只靠 padH 的 20px 左右对称留白
      padLeftBase: 0,
      // 画布左右额外留白 20px（左边在画布左侧，右边在画布与清单之间）
      padH: 20,
      // 画布上下额外留白 23px
      padV: 23,
      // 导出清晰度倍数：2 倍渲染 = 2020×1080 输出成 4040×2160，字号/材质边缘更清楚
      exportPixelRatio: 2,
    };
  },
  watch: {
    usedGroups() {
      this.$nextTick(this.fitLegend);
    },
    isScreenshot() {
      this.$nextTick(this.fitLegend);
    },
  },
  computed: {
    ...mapState(["componentData", "canvasStyleData"]),
    // 画布 / 清单在成片里的几何位置（尺寸、留白、居中），算法在 utils/previewLayout.js
    geometry() {
      return sheetGeometryOf(this.canvasStyleData, {
        legendWidth: this.legendWidth,
        isScreenshot: this.isScreenshot,
        padH: this.padH,
        padV: this.padV,
        padLeftBase: this.padLeftBase,
      });
    },
    // 清单高度恒等于整张图高度
    legendFullHeight() {
      return this.geometry.sheetAreaH;
    },
    // 画布区尺寸 = 屏幕上看到的画布：按当前比例等比缩小（80% 时 1328×827）
    sheetWidth() {
      return this.geometry.sheetWidth;
    },
    sheetHeight() {
      return this.geometry.sheetHeight;
    },
    // 画布在成片里的位置：先在原画布位里按比例居中，再整体内缩（左右各 20px、上下各 23px 白边）
    canvasLeft() {
      return this.geometry.canvasLeft;
    },
    canvasTop() {
      return this.geometry.canvasTop;
    },
    // 清单左边缘 = 20 + 1660 + 20 = 1700（左右各留 20px），尺寸 320 恒定
    legendLeft() {
      return this.geometry.legendLeft;
    },
    // 画布 + 所有材质的整体外框：材质超出页面时自动扩边，保证不被切掉
    bounds() {
      return componentBoundsOf(this.copyData, this.sheetWidth, this.sheetHeight);
    },
    // 成片尺寸恒定 2020×1080（20 左留白 + 1660 画布位 + 20 右留白 + 320 清单，上下各 23）
    sheetAreaW() {
      return this.geometry.sheetAreaW;
    },
    sheetAreaH() {
      return this.geometry.sheetAreaH;
    },
    // 每块材质左上角的名称标签（导出图里常驻）
    materialTags() {
      return materialTagsOf(this.copyData);
    },
    // 同上：成片总宽恒为 20 + 1660 + 20 + 320 = 2020，不随比例变
    sheetTotalWidth() {
      return this.sheetAreaW;
    },
    // 按窗口自适应缩放：整张图完整展示，不需要滚动；导出时回到 1:1
    fitScale() {
      return fitScaleOf(this.viewW, this.viewH, this.sheetTotalWidth, this.sheetAreaH);
    },
    fitStyle() {
      return {
        width: Math.round(this.sheetTotalWidth * this.fitScale) + "px",
        height: Math.round(this.sheetAreaH * this.fitScale) + "px",
      };
    },
    sheetTransform() {
      // 预览始终按窗口缩放展示；导出时只用 toPng 的 style 覆盖克隆节点的
      // transform，不能改这里——否则生成的那几秒画面会突然变成 100% 溢出窗口
      return {
        transform: "scale(" + this.fitScale + ")",
        transformOrigin: "top left",
      };
    },
    // 材质清单：只统计画布上真正用到的图片材质，按名称去重、记录使用次数
    usedMaterials() {
      return usedMaterialsOf(this.copyData);
    },
    // 按左侧栏同样的分类顺序分组，只保留实际用到的分类（顺序与左侧栏共用同一份常量）
    usedGroups() {
      return materialGroupsOf(this.usedMaterials);
    },
  },
  created() {
    // 画布和保存图都按当前比例缩小，材质坐标本身就是缩放后的值，
    // 直接原样使用即可 —— 预览、导出、屏幕三者一致。
    // 坐标一律取整：屏幕上也是整数像素，这样导出图与屏幕逐像素对齐（不会差 1px）。
    const data = deepCopy(this.componentData) || [];
    data.forEach((item) => {
      if (!item || !item.style) return;
      ["left", "top", "width", "height"].forEach((key) => {
        const v = Number(item.style[key]);
        if (Number.isFinite(v)) item.style[key] = Math.round(v);
      });
    });
    this.$set(this, "copyData", data);
  },
  mounted() {
    this.syncViewSize();
    window.addEventListener("resize", this.syncViewSize);
    this.$nextTick(this.fitLegend);
  },
  beforeDestroy() {
    window.removeEventListener("resize", this.syncViewSize);
  },
  methods: {
    getStyle,
    getCanvasStyle,
    changeStyleWithScale,

    // 材质清单超出画布高度时整体缩小，保证 16 种以上也能全部列出
    fitLegend() {
      const body = this.$refs.legendBody;
      if (!body) return;
      this.legendScale = legendScaleOf(body.scrollHeight || 0, this.legendFullHeight);
    },
    // 记录预览可视区大小，用于整张图自适应缩放
    syncViewSize() {
      this.viewW = window.innerWidth;
      this.viewH = window.innerHeight;
    },

    // 从材质图片路径里取分类：已随清单统计一起移到 utils/previewLayout.js

    close() {
      // 关闭预览时兜底清锁：用户点「取消」、Esc、或导出中途手动关层都不会把按钮锁死
      setExportBusy(false);
      this.$emit("close");
    },

    // 导出用的工程快照：所有页面 + 材质组件（保留原始素材路径，导入后可继续拖动编辑）
    projectSnapshot() {
      this.$store.commit("syncCurPage");
      const st = this.$store.state;
      return {
        version: 2,
        generator: "Dickson家装配色编辑器",
        exportedAt: new Date().toISOString(),
        curPageIndex: st.curPageIndex,
        pages: (st.pages || []).map((p) => ({
          name: p.name,
          // 用 cloneData 而不是裸 JSON 克隆：遇到异常结构时不会抛错中断保存
          canvasStyleData: cloneData(p.canvasStyleData || {}),
          componentData: cloneData(p.componentData || []) || [],
        })),
      };
    },

    // 本次导出实际要渲染的总像素（宽 × 高 × 清晰度倍数），用于超预算预警
    exportPixelTotal() {
      const ratio = Number(this.exportPixelRatio) || 2;
      return Math.round(this.sheetTotalWidth * ratio) * Math.round(this.sheetAreaH * ratio);
    },

    // 入口：先做像素预算检查，超了就提示用户，再决定要不要继续
    htmlToImage() {
      if (this.saving || isExportBusy()) return;
      const total = this.exportPixelTotal();
      if (total > EXPORT_MAX_TOTAL_PIXELS) {
        const w = Math.round(this.sheetTotalWidth * (Number(this.exportPixelRatio) || 2));
        const h = Math.round(this.sheetAreaH * (Number(this.exportPixelRatio) || 2));
        this.$confirm(
          "当前要导出 " + w + "×" + h + "（约 " + (total / 1000000).toFixed(1) +
            " 百万像素），超出安全预算：浏览器可能内存不足而卡顿甚至闪退。" +
            "建议把右上角画布比例调低后再保存。是否继续导出？",
          "导出尺寸过大",
          {
            type: "warning",
            confirmButtonText: "继续导出",
            cancelButtonText: "取消",
          }
        )
          .then(() => this.runExport())
          .catch(() => null);
        return;
      }
      this.runExport();
    },

    // 真正干活的导出流程（像素预算已通过）
    runExport() {
      if (this.saving) return;
      // 截图目标是整张「画布 + 右侧材质清单」，这样导出的图连带说明一起
      const container = this.$refs.container;
      const fallbackCanvas = container ? container.querySelector(".canvas") : null;
      const target = this.$refs.sheet || fallbackCanvas;
      if (!target) {
        // 预览层还没渲染完（refs 为空）：直接放弃，避免 toPng(null) 抛错后 saving 卡死
        if (this.$message) this.$message.error("预览尚未准备好，请稍后重试");
        return;
      }
      const now = new Date();
      const pad = (n) => String(n).padStart(2, "0");
      const name =
        "Dickson家装配色-" +
        now.getFullYear() +
        pad(now.getMonth() + 1) +
        pad(now.getDate()) +
        "-" +
        pad(now.getHours()) +
        pad(now.getMinutes()) +
        pad(now.getSeconds()) +
        ".png";

      // 先把「生成中」这一帧画出来，再进入重活；否则素材多时会先卡几秒才出现提示
      this.saving = true;
      // 全局导出锁：工具栏「保存」按钮据此 loading + 置灰，重复点击会被忽略
      setExportBusy(true, "正在生成图片…");

      let restoreImgs = () => {};

      // 总闸：不管卡在哪一步（压缩材质 / 渲染 / 写盘），45 秒后一定解锁，
      // 不能再出现「保存中…」一直转、整个预览点不动只能重启软件的情况。
      // 正常情况下整条链路约 15–20 秒，45 秒足够；窗口被节流时也不会白等太久。
      const watchdog = setTimeout(() => {
        if (!this.saving) return;
        try {
          restoreImgs();
        } catch (e) {
          // 忽略
        }
        this.capturing = false;
        this.saving = false;
        // 超时兜底也要释放全局导出锁，否则工具栏「保存」会一直置灰
        setExportBusy(false);
        if (this.$message)
          this.$message.error(
            "保存超时（" + Math.round(EXPORT.WATCHDOG_TIMEOUT / 1000) +
              "s）：请确认软件窗口在前台显示，或减少材质后再试一次"
          );
        this.close();
      }, EXPORT.WATCHDOG_TIMEOUT);

      // 定时器代替 requestAnimationFrame：窗口被遮住/最小化时 rAF 会被暂停，
      // 回调永远不来，「生成中」就会永久卡住（见 utils/previewExport.js 的说明）
      frameDelay()
        .then(() => {
          this.capturing = true;
          return this.$nextTick();
        })
        .then(() => frameDelay())
        .then(() =>
          withTimeout(
            downscaleImages(this.$refs.sheet, this.exportPixelRatio),
            EXPORT.DOWNSCALE_TIMEOUT,
            "压缩材质"
          )
        )
        .then((restore) => {
          restoreImgs = restore || (() => {});
          return withTimeout(
            captureSheet(target, {
              width: this.sheetTotalWidth,
              height: this.sheetAreaH,
              pixelRatio: this.exportPixelRatio || 2,
            }),
            EXPORT.RENDER_TIMEOUT,
            "生成图片"
          );
        })
        .then(async (dataUrl) => {
          // 把整份工程（页面 + 材质组件）嵌进这张 PNG 里：
          // 图片照样能直接看，但用「导入」打开它就能还原成可拖动编辑的工程
          const packed = embedProjectIntoPng(dataUrl, this.projectSnapshot());
          // 桌面 App：弹系统「另存为」，由用户自己选保存位置和文件名。
          // 对话框没关之前不能有总超时把预览层收掉，所以先撤掉 watchdog。
          if (
            typeof window !== "undefined" &&
            typeof window.dicksonSave === "function"
          ) {
            clearTimeout(watchdog);
            // 图已经出好了，接下来是等用户在弹窗里选位置：提示要跟着换，
            // 否则弹窗都出来了，遮罩还写着「正在生成图片…」，看着像卡死
            this.savingTitle = "请在「另存为」窗口里选择保存位置…";
            const res = await window.dicksonSave({
              type: "png",
              name,
              data: packed,
              direct: false,
            });
            if (res && res.ok) {
              if (this.$message)
                this.$message({
                  type: "success",
                  duration: 8000,
                  message: "图片已保存：" + res.path,
                });
              return;
            }
            // 用户在「另存为」里点了取消，静默关闭，不算失败
            if (res && res.canceled) return;
            throw new Error((res && (res.error || "未保存")) || "未保存");
          }
          const a = document.createElement("a");
          a.setAttribute("download", name);
          a.href = packed;
          a.click();
        })
        .catch((error) => {
          console.error("oops, something went wrong!", error);
          if (this.$message)
            this.$message.error(
              "保存图片失败：" + (error && error.message ? error.message : error)
            );
        })
        .finally(() => {
          clearTimeout(watchdog);
          try {
            restoreImgs();
          } catch (e) {
            // 恢复失败不影响关闭
          }
          this.capturing = false;
          this.saving = false;
          this.savingTitle = "正在生成图片…";
          // 无论成功、失败、取消，全局导出锁一定在这里释放
          setExportBusy(false);
          this.close();
        });
    },
  },
};
</script>

<style lang="scss" scoped>
// 层级说明（改这里之前先看）：
// 编辑器里被选中的组件带 .text-top -> z-index 1000，文字悬浮编辑面板 z-index 9999，
// 文字工具蒙层 z-index 2000，都在同一个根层叠上下文里。
// 预览遮罩必须压过以上全部，否则“选中文字后点保存”会出现文字浮在预览层上、还能拖动。
$z-preview: 10000;

.bg {
  width: 100%;
  height: 100%;
  top: 0;
  left: 0;
  position: fixed;
  background: rgb(0, 0, 0, 0.5);
  z-index: $z-preview;
  display: flex;
  align-items: center;
  justify-content: center;
  overflow: hidden;
  padding: 20px;

  .actions {
    position: absolute;
    // 以白页右上角为基准：顶边上方 10px、右端缩进 10px，任何窗口尺寸都不变
    right: 10px;
    bottom: calc(100% + 10px);
    z-index: $z-preview + 3;
    display: flex;
    align-items: center;
    gap: 10px;
  }

  // 生成图片期间盖一层提示，避免用户以为卡死又点一次
  .saving-mask {
    position: absolute;
    inset: 0;
    z-index: $z-preview + 2;
    background: rgba(0, 0, 0, 0.28);
    display: flex;
    align-items: center;
    justify-content: center;
  }

  .saving-box {
    min-width: 300px;
    padding: 20px 26px;
    border-radius: 10px;
    background: #fff;
    text-align: center;

    .saving-title {
      font-size: 15px;
      font-weight: 600;
      color: #222;
    }

    .saving-sub {
      margin-top: 8px;
      font-size: 12px;
      color: #888;
      line-height: 1.6;
    }
  }

  .canvas-container {
    width: calc(100% - 40px);
    height: calc(100% - 120px);
    // 整张图按窗口自适应缩放后完整展示，不滚动、不裁切
    position: relative;
    // 取消/确定 挂在白页上方，不能被这里裁掉
    overflow: visible;

    .sheet-fit {
      position: absolute;
      left: 50%;
      top: 50%;
      transform: translate(-50%, -50%);
    }

    .sheet {
      position: relative;
      background: #fff;
      // 超出画布范围的材质在这里被裁住：预览看到的 = 保存出来的
      overflow: hidden;
    }

    .canvas {
      background: #fff;
      position: absolute;
      // 材质超出页面时按内容扩边，不能裁掉
      overflow: visible;
      // 预览里的是组件的副本：不许点、不许拖、不许右键弹编辑框，
      // 否则看起来像“文字浮在预览层上还能移动”。出图不受影响（toPng 只渲染，不依赖事件）。
      pointer-events: none;
    }

    // 每块材质左上角的名字（导出图里常驻）
    .name-tag {
      position: absolute;
      z-index: 2;
      padding: 1px 5px;
      font: 12px/1.4 "幼圆";
      color: #141414;
      background: rgba(255, 255, 255, 0.72);
      border-radius: 3px;
      max-width: 220px;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
      pointer-events: none;
      box-sizing: border-box;
    }

    // 保存图片时右侧的材质清单
    .legend {
      position: absolute;
      top: 0;
      box-sizing: border-box;
      padding: 16px 10px;
      background: #fff;
      border-left: 1px solid #ececec;
      text-align: left;
      overflow: hidden;

      .legend-head {
        flex: 0 0 auto;
      }

      .legend-title {
        font-size: 15px;
        font-weight: 700;
        color: #222;
        letter-spacing: 1px;
      }

      .legend-sub {
        margin-top: 3px;
        font-size: 10px;
        color: #999;
      }

      .legend-body {
        margin-top: 10px;
        width: 100%;
      }

      .legend-list {
        display: flex;
        flex-wrap: wrap;
        gap: 8px 4px;
      }

      .legend-cate {
        width: 100%;
        display: flex;
        align-items: center;
        gap: 6px;
        margin-top: 2px;
        padding-bottom: 4px;
        border-bottom: 1px solid #eee;
        font-size: 11px;
        color: #333;
      }

      .legend-cate:first-child {
        margin-top: 0;
      }

      .legend-cate .cate-count {
        font-size: 9px;
        color: #999;
      }

      .legend-item {
        width: 46px;
        text-align: left;
      }

      .thumb {
        position: relative;
        width: 46px;
        height: 34px;
        border: 1px solid #eee;
        box-sizing: border-box;
        overflow: hidden;
        background: #fafafa;

        img {
          width: 100%;
          height: 100%;
          object-fit: cover;
          display: block;
        }

        .count {
          position: absolute;
          right: 2px;
          bottom: 2px;
          padding: 0 3px;
          font-size: 9px;
          line-height: 13px;
          color: #fff;
          background: rgba(0, 0, 0, 0.55);
          border-radius: 2px;
        }
      }

      .name {
        margin-top: 2px;
        font-size: 9px;
        line-height: 11px;
        color: #333;
        word-break: break-all;
        display: -webkit-box;
        -webkit-line-clamp: 2;
        -webkit-box-orient: vertical;
        overflow: hidden;
      }

      .legend-empty {
        margin-top: 18px;
        font-size: 11px;
        color: #bbb;
      }
    }
  }

  .close {
    position: absolute;
    right: 20px;
    top: 20px;
  }
}
</style>
