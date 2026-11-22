# Recipe Analyzer (1.21.1 NeoForge)

一个面向 Minecraft 1.21.1 NeoForge mod 的合成表分析器。支持上传 mod jar/zip，解析配方、资产、标签、进度，并在网页中展示合成/熔炼/机器/特殊配方。

## 功能
- 上传 `.jar/.zip` mod 文件
- 解压并索引 `assets/`、`data/` 资源
- 解析配方 JSON（优先支持 `crafting_shaped`、`crafting_shapeless`，其他类型归入 `未知`）
- 提取/解析物品图标（基于 item model 的 `layer0`/parent 链，找不到则占位）
- **Vanilla 1.21.1 assets fallback**：自动检测本机 `.minecraft/versions/1.21.1/1.21.1.jar`，也可在 UI 填写 jar 路径或设置 `VANILLA_JAR` 环境变量，用于解析 `minecraft:*` 物品/方块图标与名称
- 将输入材料渲染为 3x3 合成格，产物单独显示
- 对产物做启发式分类（方块/工具/武器/护甲/食物/材料/未知等）

## 运行

```bash
npm install
npm start
```

打开 http://127.0.0.1:3033。日志为结构化 JSON，可用 `LOG_LEVEL=debug` 提高详细度。

## Vanilla fallback
- 自动检测：`%APPDATA%\.minecraft\versions\1.21.1\1.21.1.jar`
- 环境变量：`VANILLA_JAR=C:\path\to\1.21.1.jar npm start`
- UI：上传时可填写 vanilla jar 绝对路径

## 说明与限制
- 当前主要针对 **1.21.1 NeoForge** 常见数据结构；其他版本/加载器后续扩展。
- 未识别 recipe type 会尽量启发式解析；无法静态解析的特殊配方会显示说明，不强行画 3x3。
- Tag 会按 mod 数据展开。默认**不**注入原版等价物；勾选上传表单里的“显示等价原版”后，才会把 `#c:eggs`、`#c:storage_blocks/iron`、`#c:dyes/*` 等常见通用标签补上原版物品。映射表见 `config/tag-fallbacks.json`。
- 方块使用服务端预渲染 3D 图标（含原版预热库）；复杂 `builtin/entity` 模型可能回退占位。
- 科技模组机器配方兼容是“尽量支持”：静态 jar 无法等同 JEI/EMI 运行时插件能力。

## 开发与协作

```bash
npm install
npm start
```

- `main` 保持可运行；功能/修复用分支 + PR。
- 改动后至少执行：`node --check`（相关文件）并手动验证上传分析流程。
- `data/` 为运行时产物，默认不提交；分析字段变更后需重新分析。

## 目录
- `server.js` - Express 服务与上传接口
- `lib/vanilla.js` - vanilla jar 自动检测与资产加载
- `lib/zip.js` - zip 读取/纹理提取（含 vanilla fallback）
- `lib/assets.js` - lang/model/blockstate/tag 索引与解析
- `lib/recipes.js` - 配方解析与归一化
- `lib/classify.js` - 产物分类
- `lib/analyzer.js` - 主流程，输出 `data/<upload>/analysis.json` + icons/renders
- `lib/render3d.js` - 服务端方块 3D 预渲染
- `lib/advancements.js` - 进度解析与物品关联
- `config/tag-fallbacks.json` - 可选的原版等价标签映射表
- `public/` - 前端页面
- `data/` - 上传与分析结果（运行时生成）

## License

GPL-3.0-only. See [LICENSE](./LICENSE).

自研代码使用 GPL-3.0-only。**原版材质与各模组素材不在此授权范围内**，渲染产物（图标/3D 图）版权归 Mojang 及对应模组作者所有，转载需署名并注明来源。详见 [NOTICE](./NOTICE)。
