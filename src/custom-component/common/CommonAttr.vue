<template>
  <div class="v-common-attr">
    <el-collapse v-model="activeName" accordion @change="onChange">
      <!-- <el-collapse-item title="通用样式" name="style"> -->
      <el-form>
        <el-form-item
          v-for="({ key, label }, index) in styleKeys"
          :key="index"
          :label="label"
        >
          <el-color-picker
            v-if="isIncludesColor(key)"
            :value="curComponent.style[key]"
            show-alpha
            @change="commitStyle(key, $event)"
          ></el-color-picker>
          <el-select
            v-else-if="selectKey.includes(key)"
            :value="curComponent.style[key]"
            @change="commitStyle(key, $event)"
          >
            <el-option
              v-for="item in optionMap[key]"
              :key="item.value"
              :label="item.label"
              :value="item.value"
            ></el-option>
          </el-select>
          <!-- 数字输入不再直连 store：先过校验（宽高下限、角度区间），
               合法才通过 mutation 写回，非法值当场回退并提示 -->
          <el-input
            v-else
            :value="curComponent.style[key]"
            type="number"
            @change="commitNumberStyle(key, $event)"
          />
        </el-form-item>
      </el-form>
      <!-- </el-collapse-item> -->
    </el-collapse>
  </div>
</template>

<script>
import {
  styleData,
  textAlignOptions,
  borderStyleOptions,
  verticalAlignOptions,
  selectKey,
  optionMap,
} from "@/utils/attr";
import { validateSizeInput, validateRotateInput } from "@/utils/validate";

export default {
  data() {
    return {
      optionMap,
      styleData,
      textAlignOptions,
      borderStyleOptions,
      verticalAlignOptions,
      selectKey,
      activeName: "",
    };
  },
  computed: {
    styleKeys() {
      if (this.curComponent && this.curComponent.style) {
        const curComponentStyleKeys = Object.keys(this.curComponent.style);
        return this.styleData.filter((item) =>
          curComponentStyleKeys.includes(item.key)
        );
      }

      return [];
    },
    curComponent() {
      return this.$store.state.curComponent;
    },
  },
  created() {
    this.activeName = this.curComponent ? this.curComponent.collapseName : "";
  },
  methods: {
    onChange() {
      // 折叠面板的展开状态也通过 mutation 写回，避免组件里直接改 state 对象
      const cur = this.curComponent;
      if (!cur) return;
      this.$store.commit("setComponentFieldById", {
        id: cur.id,
        key: "collapseName",
        value: this.activeName,
      });
    },

    isIncludesColor(str) {
      return String(str).toLowerCase().includes("color");
    },

    /**
     * 把样式值通过 mutation 写回（不直接改 curComponent.style，避免外部改 state）。
     * 值没变化时什么都不做，避免多余的响应式更新。
     *
     * @param {string} key 样式字段
     * @param {*} value 新值
     * @returns {void}
     */
    applyStyle(key, value) {
      const cur = this.curComponent;
      if (!cur || !cur.style || key === undefined) return;
      if (cur.style[key] === value) return;
      this.$store.commit("setShapeSingleStyleById", { id: cur.id, key, value });
    },

    /**
     * 颜色 / 下拉选择：值本身已经是合法取值，直接写回。
     *
     * @param {string} key 样式字段
     * @param {*} value 新值
     * @returns {void}
     */
    commitStyle(key, value) {
      this.applyStyle(key, value);
    },

    /**
     * 数字输入：按字段类型做校验，非法值回退到上一次合法值并提示。
     * 宽/高有下限（不能 0、不能负数），角度会被钳制在允许区间内。
     *
     * @param {string} key 样式字段
     * @param {Event|*} event el-input 的 change 事件（取 event.target.value）
     * @returns {void}
     */
    commitNumberStyle(key, event) {
      const cur = this.curComponent;
      if (!cur || !cur.style) return;
      const raw = event && event.target ? event.target.value : event;
      const prevRaw = Number(cur.style[key]);
      const prev = Number.isFinite(prevRaw) ? prevRaw : 0;

      let result;
      if (key === "width" || key === "height") {
        result = validateSizeInput(raw, prev);
      } else if (key === "rotate") {
        result = validateRotateInput(raw, prev);
      } else {
        const num = Number(String(raw).trim());
        result = Number.isFinite(num)
          ? { ok: true, value: Math.round(num), message: "" }
          : { ok: false, value: prev, message: "请输入数字" };
      }

      this.applyStyle(key, result.value);
      if (!result.ok || result.message) {
        // 回退后输入框里的文字也要跟着回到合法值，否则界面显示的还是那个非法数字
        this.resetInputValue(event, result.value);
        if (this.$message) this.$message.warning(result.message);
      }
    },

    /**
     * 把输入框的显示值改回指定数字（受控的 :value 在值恰好没变时不会重渲染）。
     *
     * @param {Event|*} event change 事件
     * @param {number} value 要显示的数值
     * @returns {void}
     */
    resetInputValue(event, value) {
      const input = event && event.target;
      if (input && input.value !== String(value)) input.value = String(value);
    },
  },
};
</script>

<style lang="scss">
.v-common-attr {
  .el-input-group__prepend {
    // padding: 0 10px;
  }
  .el-form {
    display: flex;
  }
  .el-input {
    width: 60px;
  }
  .el-form-item {
    width: 100px;
  }
  .el-form-item--small {
    width: 100px;
  }
  .el-tabs__content {
    height: 100%;
  }
}
</style>
