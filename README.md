# Recipe Analyzer (Minecraft Java Edition)

一个面向 Minecraft Java Edition mod 的合成表分析器，**定位为离线批量配方审计工具**（面向整合包作者、服主、配方审计/翻译补全/CI 检查）。支持上传 mod jar/zip，解析配方、资产、标签、进度，在网页中展示合成/熔炼/机器/特殊配方，并给出解析覆盖率与可疑项报告。

支持 **1.21.1 到 26.3** 的所有正式版（含 1.21.x 全系与 26.x 新命名版本），在上传页选择对应版本即可。版本列表见 `config/versions.json`。

## 功能
- 上传 `.jar/.zip` mod 文件
- 解压并索引 `assets/`、`data/` 资源
- 解析配方 JSON（优先支持 `crafting_shaped`、`crafting_shapeless`，其他类型归入 `未知`）
- 提取/解析物品图标（基于 item model 的 `layer0`/parent 链，找不到则占位）
- **Vanilla assets fallback**：按所选版本自动检测本机 client jar，也可在 UI 填写 jar 路径或设置 `VANILLA_JAR` 环境变量，用于解析 `minecraft:*` 物品/方块图标与名称
- 将输入材料渲染为 3x3 合成格，产物单独显示
- 对产物做启发式分类（方块/工具/武器/护甲/食物/材料/未知等）
- **解析质量仪表**：扫描/解析数、解析率、未知材料数、可疑配方数；可疑项在卡片上标红，可勾选「只看可疑」筛选，并可导出 CSV
- 下载完整的 `analysis.json`（含 `summary.coverage` 与每条记录的 `parseQuality`），便于 CI / 批量审计消费

## 运行

```bash
npm install
npm start
```

打开 http://127.0.0.1:3033。日志为结构化 JSON，可用 `LOG_LEVEL=debug` 提高详细度。

## Vanilla fallback
- 先按所选版本自动检测：`%APPDATA%\.minecraft\versions\<版本>\<版本>.jar`（也支持 PrismLauncher、minecraft-dev-mcp 等常见布局）
- 环境变量：`VANILLA_JAR=C:\path\to\<版本>.jar npm start`
- UI：上传时可填写对应版本的 vanilla jar 绝对路径
- 默认版本可用 `MC_VERSION=1.21.4 npm start` 修改；`GET /api/versions` 返回支持列表、最新版本与默认版本
- 每个版本的 vanilla 渲染缓存互相隔离在 `data/vanilla-renders/<版本>/`；切换版本不会复用旧图。其他版本可在首次分析时按需渲染，或调用 `POST /api/prewarm-vanilla` 传 `{ "mcVersion": "26.3" }` 预热

## 解析质量 / 审计

分析结果 `analysis.json` 的 `summary.coverage` 字段：

| 字段 | 含义 |
|---|---|
| `recipeFilesScanned` | `data/**/recipe(s)/` 下 JSON 文件总数 |
| `recipesParsed` / `parseRate` | 成功解析数 / 解析率 |
| `invalidJsonFiles` | JSON 解析失败数 |
| `advancementFilesSkipped` | 位于配方路径但实为进度的文件数 |
| `unknownTypeRecipes` / `inferredRecipes` | 未知类型数 / 启发式推断数 |
| `totalIngredients` / `unknownIngredients` | 材料总数 / 无法识别的材料数 |
| `suspiciousRecipes` / `suspiciousReasons` | 可疑配方数与各原因分布 |

每条配方（含变体合并后的记录）带 `parseQuality`，`suspicious=true` 的四种原因：

- `zero-input`：没有任何可解析输入材料（最危险的静默错误，会显示成「零材料合成」）
- `unknown-ingredient`：含无法识别结构的材料
- `result-unresolved`：没有产物 ID
- `unknown-recipe-type`：配方 type 未识别且未能推断

可疑 ≠ 一定错误，仅提示人工核对。CLI / CI 可直接读 `summary.coverage` 做阈值检查。

## 1.21.4 物品模型映射：验收基线

样本为本机 **1.21.11 原版 client jar**。静态统计 `assets/minecraft/items/*.json` 共 **1505** 个映射：

| `model.type` | 数量 | 占比 |
|---|---|---|
| `minecraft:model`（直取） | 1358 | 90.2% |
| `minecraft:select` | 71 | 4.7% |
| `minecraft:special` | 67 | 4.5% |
| `minecraft:condition` | 7 | 0.5% |
| `minecraft:range_dispatch` | 2 | 0.1% |
| **复杂结构合计（按设计退 2D）** | **147** | **9.77%** |

对同一 jar 跑完整分析（1470 条配方），`summary.iconRenderStats` 实测：

- `itemModelMappingHit`: **1048**
- `itemModelMappingFallback2D`: **136**（占已覆盖映射的 11.5%）
- `itemModelMappingMissing`: **26**

这里的 ~9.8%（数据层）/ 11.5%（实际解析层）就是本步明确接受的降级面。
这些计数属于**渲染侧**，和 `summary.coverage`（配方解析质量）分开统计、不合并。
后续若要缩小降级面，只能实现 `condition` / `select` / `range_dispatch` 的语义，
**不能**用「取第一个分支」糊过去——那会渲染出错误模型，属于静默错，宁可退 2D。

## 说明与限制
- 支持 1.21.1+ Java Edition 常见数据结构；核心解析按结构特征兼容而非按版本号分支。新版若出现全新配方 schema，遇到后再在 `lib/recipes.js` 的 normalize 层补充即可。
- **仅静态解析 jar 内的配方 JSON**：不含 KubeJS / CraftTweaker 等运行时脚本动态注册的配方，也不具备 JEI/EMI 运行时插件能力。审计时请把覆盖率当作「静态可提取部分」的指标。
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
- `config/versions.json` - 支持的正式版列表与默认版本
- `lib/versions.js` - 版本参数校验与默认值
- `public/` - 前端页面
- `data/` - 上传与分析结果（运行时生成）

## License

GPL-3.0-only. See [LICENSE](./LICENSE).

自研代码使用 GPL-3.0-only。**原版材质与各模组素材不在此授权范围内**，渲染产物（图标/3D 图）版权归 Mojang 及对应模组作者所有，转载需署名并注明来源。

完整的中文版权/许可边界与合规说明见独立文件 [版权声明.md](./版权声明.md)（英文版见 [NOTICE](./NOTICE)），使用前请阅读。
