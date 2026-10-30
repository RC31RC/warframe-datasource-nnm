# warframe-datasource-nnm

Warframe 数据采集、清洗和静态 gzip JSON 生成项目。采集器运行后退出，不启动 Web 服务。生成的 `data/latest/` 整包属于 NnmBot 的官方数据，通过本仓库固定 tag/commit 消费。

## 运行与复现

要求 Node.js 22 或更新版本。

```bash
npm ci
npm run collect
npm run verify
```

`collect [snapshot-dir]` 获取全部输入并冻结到 `tmp/inputs-<时间>/`，再执行纯数据投影，完整校验后覆盖发布 `data/latest/`。失败的采集可用同一目录重试，已冻结且校验通过的任务会复用；需要刷新上游时使用新目录。冻结目录保留原始文件、必要的初次解析输入和 SHA-256 索引，供后续重建使用，不纳入 Git。

```bash
npm run collect -- tmp/inputs-example
npm run replay -- tmp/inputs-example
npm run verify
npm run typecheck
npm test
```

`replay` 从冻结输入重新执行清洗，校验输入哈希，不请求上游。相同输入与代码应生成相同的各成品字节；manifest 的构建时间与 `buildId` 时间部分会变化。每次 `collect` 成功发布后，自动生成的 `tmp/inputs-*` 冻结输入目录和临时 raw 工作区都会清理，Plus 与语言表归档到 `tmp/cache/`。需要保留输入目录用于后续 `replay` 时，显式设置 `WF_KEEP_TMP=1` 或 `WF_KEEP_INPUTS=1`；采集失败时输入目录会保留，方便重试。


`verify` 离线检查 gzip manifest、文件集合、路径层级、解压后的 JSON、压缩文件字节数及 SHA-256。本轮 PHP 解析只是本地验收，动态响应和验收工具不加入生产采集或发布链；NnmBot 后续自行定时拉取 PHP，并使用成品中的静态定义解析。

## 成品目录与字段

`data/latest/` 下最多一层业务子目录，所有正式文件使用 `.json.gz`，文件清单以 `manifest.json.gz` 为准：

| 业务目录 | 主要文件与内容 |
| --- | --- |
| `equipment` | 战甲、武器、技能、Archwing、Railjack 武器、动物/机械同伴、道具、无人机、飞船 |
| `upgrades` | Mod、赋能、专精、航电、套装；`riven-{attributes,definitions,weapons}.json.gz` 保存裂罅定义、倾向和武器目录 |
| `items` | 资源、部件、装饰、阿耶檀识珍宝、补给、Captura 场景、歌曲、外观、礼包及内部引用定义 |
| `crafting` | `recipes.json.gz`、`dojo-recipes.json.gz`，配方内嵌产物、材料与制造条件 |
| `world` | `star-chart.json.gz`、场景、敌人、商人静态目录、资料库、任务钥匙和信件 |
| `rewards` | `relics.json.gz`：遗物/精炼/奖励/概率/获取位置；`drop-tables.json.gz`、`reward-pools.json.gz`、`bounties.json.gz` |
| `progression` | 成就、挑战、内源之力、午夜电波静态定义 |
| `worldstate` | PHP 静态解析依赖：玩法、执刑官、阵营、集团、任务、裂缝、升级键等；不包含临时 PHP 响应 |
| `market` | `trade-items.json.gz`：交易平台条目与游戏实体的映射，不等于游戏内商人目录 |
| `reference` | `language-{en,zh}.json.gz`、`item-localizations.json.gz`、`images.json.gz`、`text-icons.json.gz` |
| `statistics` | `usage-<年份>.json.gz`：按年保存使用率数据 |

目录由 `src/publish/product-layout.ts` 集中映射；实体归属由 `src/projections/entity-ownership.ts` 根据官方 `productCategory` 和精确类型继承确定。资源域中的飞船、装饰、珍宝、部件、Captura 场景和歌曲不再混进材料表。`items/misc-items.json.gz` 保留不能明确归入材料/专用集合的杂项，`items/internal-definitions.json.gz` 保留内部基类与引用定义；未命名、未解析记录不丢弃。船体外观按官方 `ShipExteriorSkinItem` 类型归入 `items/skins.json.gz`。

当前为 11 个业务目录、71 份成品（另有根目录 manifest）；文件数增加来自实体集合拆分，不是复制旧路径。目录归属迁移不改稳定 ID、字段值、中英文、图片和概率；下述一对一压缩会调整字段路径和名称。旧 commit 的路径不变；旧日期 tag 删除后，新 tag 消费时应使用新路径，不在同一次发布里重复输出旧路径兼容文件。

仲裁小时排期和裂罅周统计属于短周期运行时数据，不进入静态发布包，也不再合并进武器目录；下游消费者应自行获取和刷新。`upgrades/riven-weapons.json.gz` 仅保留官方倾向和 Warframe Market 武器目录元数据。

尽量同时保留 `nameEn`/`name` 和 `nameZh`、描述、稳定 ID 及真实图片。部分底层 `name` 是原始语言键，此时 `nameEn` 是可读英文；显示层优先使用 `nameZh`、`nameEn`。战甲 `media__*` 字段保存官网宣传图、展示视频和技能展示图，与游戏图标分开。Mod 套装内嵌成员；内融核心包用数量标签显示；邮件使用标题及正文展示。语言键、内部路径及 `GAMEPLAY_DAMAGE_TO_POWER` 等协议键保持原样。未关联/歧义记录保留原值和状态；缺图不使用无信息占位图。`iconStatus=available` 表示生成了精确资源地址，不代表每次构建都对全部图片逐个联网检查。

概率用 0～1 的 `probability` 表示，例如 `0.25` 是 25%；`dropChancePercent` 保留官网百分数，例如 `25`。来源触发概率、奖励池内概率、抽取次数、物品数量是独立概念。来源 400% 或 Plus `chance: 4` 转为同池抽 4 次，不截断为 100%，也不自动推算“至少获得一次”的概率；未知概率为 `null`，待审核的官方数值保留标记。

同 ID 的互补字段合并，官方 Public Export 本地化值优先。完全相同的重复记录可去重，同 ID 冲突记录会报错。普通掉落名指普通版本；只给奖励类别时用 `identityResolution=category` 保存候选，奖励概率只属于类别，不分配给候选。其他真实歧义显式保留。只有制造行为完全相同的配方才合并，旧身份保存为 `identityAliases`。

## 一对一对象递归压缩（compact@1）

`src/projections/compact.ts` 是 `projectInputs` 的最后一段正式生成逻辑。关联、翻译、图片、概率及实体归属先完成，再输出浅层成品；不是让下游恢复旧树或按 ID 重新关联。

- 只合并生成契约确认的单个对象。对象链递归合并，例如 `projectile.attack.DT_IMPACT` → `projectile__attack__DT_IMPACT`。
- 单对象中的数组/键值集合随字段提升，例如 `sacrifice.items[]` → `sacrifice__items[]`；数组中的每条记录继续递归处理。
- 用双下划线 `__` 保留来源命名空间；字段冲突立即报错，禁止覆盖。稳定 ID 和所有原值保持不变。
- 一对多集合不合并，包括仅有一条的数组，以及 `states` 等真实键值集合。最终中英文归并阶段会另行处理已声明的 `i18n` / `translations` 容器。`dropTableEntries[]` 允许多条，始终保留。
- 不确定契约的新对象保留结构；`null`、空对象、空数组、未匹配/歧义状态原样保留。没有引入共享引用、跨数组连接或笛卡尔积。

常用字段迁移：

| 旧路径 | 新路径 |
| --- | --- |
| `recipe.resultItem.nameZh` | `recipe.resultItem__nameZh` |
| `ingredient.item.uniqueName` | `ingredient.item__uniqueName` |
| `reward.item.nameZh` | `reward.item__nameZh` |
| `context.source.name` | `context.source__name` |
| `frame.media.showcaseImageUrl` | `frame.media__showcaseImageUrl` |
| `title.sacrifice.items[]` | `title.sacrifice__items[]` |
| `activities.conquests.conditions` | `activities.conquests__conditions` |
| `boss.shardCategory.variants[]` | `boss.shardCategory__variants[]` |

这是业务记录结构变更；manifest 的 `schemaVersion: 3` 仍只表示发布清单格式。NnmBot 应直接读取新字段，不应将旧字段访问方式用于新 tag。

2026-10-25 对 70 份现有成品做了无损结构迁移：29 份结构改变；70 份均通过还原后的全值比对和二次压缩幂等检查。此前 **450 → 359 只是结构关系路径计数，不是实际 SQL 表数，也不是上下界**；将它表述为减少 91 张数据库表不严谨。NnmBot 原本就将单对象内联成列，其旧契约有 **414 张**成品实体表；适配新字段访问后，以原规划规则只读重算当时成品仍是 **414 张**。根记录重组、字典识别和同构子表是否共表会改变物理表数，例如 tilesets 的结构估算是 11，原规划器却生成 78；语言数据分别是 4 和 31。

```bash
npm run analyze:structure                              # 统计当前成品，写 docs/json-structure-report.{json,md}
npm run analyze:structure -- data/latest /path/to/before # 与改动前成品比较；须使用同一份输入数据
```

逐文件层级、结构路径计数见本地 `docs/json-structure-report.json` / `.md`。未传 before 目录时，两列都表示当前结构，不代表新的压缩前基准。

实际建表规划对照使用只读脚本（不会写入 NnmBot 的 Java/SQL/契约）：

```bash
npm run compare:downstream -- ../NnmBot data/latest
npm run audit:images
```

对照见 `docs/downstream-schema-comparison.{json,md}`。当前已在生成端移除重复 missions、合并中英文并拆分本地化 DTO；数据源本地成品已更新。NnmBot 真实规划器在内存中适配字段读取与三个新领域注册后，成品实体表从 **414 → 307**：单去重复 missions 为 342；其余减少来自语言容器、双语说明行和双语词典归并，并已计入两个新增本地化根集合。本脚本拦截全部写入，未改 NnmBot Java、SQL 或资源，307 是消费端适配后的规划结果，当前消费端契约仍是 414。其全库原有 459 张（414 成品实体 + 45 其他表）；若其余 45 张保持现状，适配后对应 352 张。结构路径计数不是这个口径。

## 中英文与 Java DTO 契约

Public Export 仅采集 en、zh；最终成品将声明的语言容器合并到记录本身：英文使用原字段，中文使用 `zh` 前缀，如 `name` / `zhName`、`description` / `zhDescription`。同一游戏实体的译文在生成端完成对齐。其他已存在的非语言容器字段（如装备的 `nameZh`）保留原命名。

| 成品 | 每条记录的固定字段 | 按完整集合导入的实体表 |
| --- | --- | ---: |
| `reference/item-localizations.json.gz` | `uniqueName, name, zhName, iconUrl, description, zhDescription` | 1 |
| `reference/ability-owner-localizations.json.gz` | `uniqueName, name, zhName, iconUrl, description, zhDescription, abilities[]` | 2 |
| `reference/upgrade-localizations.json.gz` | `uniqueName, name, zhName, iconUrl, descriptions[]` | 2 |
| `reference/language-strings.json.gz` | `key, text, zhText` | 1 |

普通本地化 22,001 条、技能拥有者 127 条、多行说明 142 条，合计仍为 22,270 条。`abilities[]` 每项为 `abilityUniqueName, abilityName, zhAbilityName, description, zhDescription`；中英文严格按 `abilityUniqueName` 对齐，不按数组位置猜测。说明行每项为 `lineIndex, text, zhText`；保留源文本顺序及缺失侧 null，不将数组拼成字符串。三个集合内部所有记录同字段、同类型；缺失标量用 null，真正的一对多数组保留。雷克斯 Prime 等普通物品无语言子表；技能拥有者集合需要一张技能子表。这里的 2 是整个集合的表数，不会因某个物品没有技能而动态建表。

星图的 `translations`、市场和紫卡的 `i18n` 容器已移除，中英文直接存在父记录。MOD/赋能/航电/专精的 `ranks[].stats__stats` 与 `statsZh__stats` 已合为 `ranks[].stats[]`，行内为 `lineIndex, text, zhText`。MOD 原本混用字符串/数组的说明，已分为可空字符串 `description` / `descriptionZh` 和 `descriptionLines[]`。敌人 `avatarTypes` 已改为类型一致的变体数组，单个解析引用以 `reference__*` 并入该变体，不再混入字典值或增加引用子表。场景只保留完整增强的 `missionDefinitions[]`，删除前校验所有原 missions 字段完全覆盖，不完整则终止发布。

底层词典 `reference/language-en.json.gz` 和 `reference/language-zh.json.gz` 已合为 `reference/language-strings.json.gz`，按同一字符串键提供 `text` / `zhText`。原始 en/zh 输入与 cache 仍分别保留，所有归并均发生在最终发布阶段。

```bash
npm run normalize:products  # 对已核验的本地成品执行同一迁移，无网络，不改 cache
npm run audit:shapes        # 区分字段缺失与同字段类型混用
```

2026-10-25 全量审计：同字段非 null 类型混用由 3 份文件、18 个路径降至 0；另有 53 份文件存在可选字段组合差异，详见 `docs/product-record-shapes.{json,md}`。缺少某个图标或可选业务字段可由 Java 的可空字段承载；不能按每种缺失字段组合拆成不同文件或表。分支属于明确业务类型时，使用独立 DTO 或已命名的集合，不要求用一个 Java 类型承载整个文档的所有段。

图像审计见 `docs/image-asset-diagnostic.json`。`/Lotus/...png` 是游戏内部资源键，不等于公开图片 URL；`reference/images.json.gz` / Plus `ExportImages` 只覆盖公开 ExportManifest 映射，并未导出所有 NPC 纹理。缺少精确公开映射时保留 `iconAsset` / `iconStatus=internal_asset_only`，不能猜 hash、拼伪 URL 或借用同名标签/玩偶图片。

动态解析示范保留在 `tmp/worldstate-validation/`（世界状态）和 `tmp/dynamic-data-migration/`（仲裁、仅 PC 紫卡周统计），均直接使用当前成品；详细运行方式见各目录 README。这些代码、输入快照和动态输出不进入静态发布链，`tmp/cache/` 不做结构迁移。

## 采集链与数据通道

Plus 与语言表均接入 `Pluto 提取 → GitHub 数据源 → CDN 镜像 → tmp/cache` 降级链：Plus 优先 GitHub Raw（根目录及兼容 `data/`），随后 GitHub Git API blob，再试 jsDelivr；语言表优先整对 Raw，失败时整对从 CDN 下载，均失败才使用经过校验的 cache。语言仓库的默认分支为 `senpai`，不要改回不存在的 `master`。Pluto 运行需要本机游戏资源、包数据、运行时及脚本依赖；配置缺失、提取失败或校验不通过时自动降级。CDN 优先从 GitHub API 获取 commit SHA 并固定版本；若 API 不可用才尝试分支地址，并在日志中标明新鲜度未经确认。`testingcf.jsdelivr.net` 是备用镜像，网络超时或过期缓存不能保证取得最新数据；Plus 按文件降级，语言表按中英一对降级。采集日志的 `[plus] sources`、`[languages] sources` 显示本次各通道来源。实际 Pluto 提取需在具备依赖的机器上验证。官网战甲列表和详情页作为额外一手输入冻结采集，通过精确游戏资源路径关联宣传素材。

NnmBot 只在本项目不能提供、且完全由社区人工维护的独立领域保留社区通道，例如仲裁精华、黑化、术语。两通道均保留拉取、差异预览、审核、事务入库和自维护字段保护。NnmBot 消费本项目生成的静态 Export 目录；仲裁排期、裂罅周统计及动态 PHP 响应由下游运行时数据通道处理，静态引用使用本项目代码簿。

## 固定版本消费

同一批 manifest 和成品必须固定到相同 tag/commit，通过 manifest 校验压缩文件的字节数及 SHA-256。tag 格式为 UTC `YYYYMMDDHHmmss`，无 `data-` 前缀。所有 `data/latest/` 文件（含 `manifest.json.gz`）均为 gzip；消费者必须先解压再解析 JSON。路径模板：

```text
https://raw.githubusercontent.com/<owner>/warframe-datasource-nnm/<ref>/data/latest/manifest.json.gz
https://raw.githubusercontent.com/<owner>/warframe-datasource-nnm/<ref>/data/latest/equipment/warframes.json.gz
https://raw.githubusercontent.com/<owner>/warframe-datasource-nnm/<ref>/data/latest/rewards/relics.json.gz
https://raw.githubusercontent.com/<owner>/warframe-datasource-nnm/<ref>/data/latest/upgrades/riven-attributes.json.gz
```

当前 manifest `schemaVersion: 3` 描述发布清单格式，业务路径和嵌套字段仍需由消费端迁移适配。旧 `catalog/**`、`plus/**`、`linked/**`、多个遗物文件、等级表及反向掉落表已被对应业务成品替代。GitHub Actions 每天 22:17 UTC（北京时间次日 06:17）、手动或 main 分支源码/配置推送时采集；仅修改 data/cache 不触发新一轮采集。有变化时提交并打 UTC 秒级 tag；本地执行采集本身不提交、推送或打 tag。2026-10-30 的 Actions `collect` 错误为 Public Export 索引的 `LZMA_DATA_ERROR`，不是 Plus/语言表失败的证据。官方 `content.warframe.com` 和 `origin.warframe.com` 都可提供 Public Export 索引；访问结果会随请求方式及边缘节点变化，单次 HTTP 403 不能用来断定域名永久不可用。某些 LZMA 解码器不接受这份带有已知长度和结束标记的官方索引；采集器在原始字节不变的前提下兼容解码、校验原声明长度及所需索引项，只在完整通过后接受相应官方地址。两个地址都失败时保留可重试输入并使任务失败。工作流保留日志 artifact 与运行摘要。

## 发布安全与配置

生成器先写临时目录并完整校验，再整树替换 `data/latest/`，失败尝试恢复旧目录。同一输出根目录有写锁。`data/latest/` 是生成目录，自维护内容应放在消费端，避免下次生成被覆盖。清洗 manifest 保留本项目版本、文件 hash、长度与记录数，不传播上游来源元数据。

`data/latest/` 与 `tmp/cache/` 可提交；`tmp/inputs-*/`、临时原始工作区、`docs/` 不纳入版本管理。配置集中在 `src/core/config.ts`：

- `DATASOURCE_DATA_DIR`、`DATASOURCE_TMP_DIR`：输出目录。
- `DATASOURCE_REQUEST_TIMEOUT_MS`、`DATASOURCE_MAX_RESPONSE_BYTES`、`DATASOURCE_REQUEST_RETRIES`：下载控制。
- `WF_GAME_DIR`、`WF_PACKAGES_BIN_DIR`、`WF_PLUTO_DIR`、`WF_PLUTO_RUNTIME`、`WF_PLUTO_TIMEOUT_MS`：Pluto 提取前提与运行控制。
- `WF_PUBLIC_EXPORT_INDEX_URL`、`WF_PUBLIC_EXPORT_INDEX_FALLBACK_URL`、`WF_PUBLIC_EXPORT_MANIFEST_URL`、`WF_PLUS_RAW_BASE_URL`、`WF_LANGUAGES_RAW_BASE_URL`、`WF_MARKET_RIVEN_ATTRIBUTES_URL`、`WF_MARKET_RIVEN_WEAPONS_URL`、`WF_MARKET_ITEMS_URL`、`WF_MARKET_USER_AGENT`：上游配置。
- `WF_GITHUB_CDN_BASE_URLS`：逗号分隔的镜像地址，默认先试 `cdn.jsdelivr.net/gh`，再试 `testingcf.jsdelivr.net/gh`；设为空字符串可禁用 CDN。Actions 的 Collect 步骤将自带 `GH_TOKEN` 仅用于 GitHub API 请求，不传给 CDN。

TLS 校验保持开启。若进程被强制终止，确认无任务运行后再处理残留 `.gen-staging-*`、`.gen-backup-*` 或写锁。
