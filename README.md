# warframe-datasource-nnm

Warframe 数据采集、清洗和静态 JSON 生成项目。采集器运行后退出，不启动 Web 服务。生成的 `data/latest/` 整包属于 NnmBot 的官方数据，通过本仓库固定 tag/commit 消费。

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

`replay` 从冻结输入重新执行清洗，校验输入哈希，不请求上游。相同输入与代码应生成相同的各成品字节；manifest 的构建时间与 `buildId` 时间部分会变化。每次发布产生的临时 raw 工作区在成功后清理，Plus 与语言表归档到 `tmp/cache/`；`WF_KEEP_TMP=1` 可保留该工作区。冻结输入目录独立保留，需按本地磁盘情况清理。


`verify` 离线检查 manifest、文件集合、路径层级、JSON、字节数及 SHA-256。本轮 PHP 解析只是本地验收，动态响应和验收工具不加入生产采集或发布链；NnmBot 后续自行定时拉取 PHP，并使用成品中的静态定义解析。

## 成品目录与字段

`data/latest/` 下最多一层业务子目录，文件清单以 `manifest.json` 为准：

| 业务目录 | 主要文件与内容 |
| --- | --- |
| `equipment` | 战甲、武器、技能、Archwing、Railjack 武器、动物/机械同伴、道具、无人机、飞船 |
| `upgrades` | Mod、赋能、专精、航电、套装；`riven-{attributes,definitions,weapons}.json` 保存裂罅相关定义和统计 |
| `items` | 资源、部件、装饰、阿耶檀识珍宝、补给、Captura 场景、歌曲、外观、礼包及内部引用定义 |
| `crafting` | `recipes.json`、`dojo-recipes.json`，配方内嵌产物、材料与制造条件 |
| `world` | `star-chart.json`、场景、敌人、商人静态目录、资料库、任务钥匙和信件 |
| `rewards` | `relics.json`：遗物/精炼/奖励/概率/获取位置；`drop-tables.json`、`reward-pools.json`、`bounties.json` |
| `progression` | 成就、挑战、内源之力、午夜电波静态定义 |
| `worldstate` | PHP 静态解析依赖：玩法、执刑官、阵营、集团、任务、裂缝、升级键等；不包含临时 PHP 响应 |
| `arbitration` | `schedule.json`：仲裁排期 |
| `market` | `trade-items.json`：交易平台条目与游戏实体的映射，不等于游戏内商人目录 |
| `reference` | `language-{en,zh}.json`、`item-localizations.json`、`images.json`、`text-icons.json` |
| `statistics` | `usage-<年份>.json`：按年保存使用率数据 |

目录由 `src/publish/product-layout.ts` 集中映射；实体归属由 `src/projections/entity-ownership.ts` 根据官方 `productCategory` 和精确类型继承确定。资源域中的飞船、装饰、珍宝、部件、Captura 场景和歌曲不再混进材料表。`items/misc-items.json` 保留不能明确归入材料/专用集合的杂项，`items/internal-definitions.json` 保留内部基类与引用定义；未命名、未解析记录不丢弃。船体外观按官方 `ShipExteriorSkinItem` 类型归入 `items/skins.json`。

当前为 12 个业务目录、71 份成品（另有根目录 manifest）；文件数增加来自实体集合拆分，不是复制旧路径。迁移不改稳定 ID、原字段、原值、中英文、图片和概率。历史 tag 路径不变，新 tag 消费时应使用新路径，不在同一次发布里重复输出旧路径兼容文件。

尽量同时保留 `nameEn`/`name` 和 `nameZh`、描述、稳定 ID 及真实图片。部分底层 `name` 是原始语言键，此时 `nameEn` 是可读英文；显示层优先使用 `nameZh`、`nameEn`。战甲 `media` 保存官网宣传图、展示视频和技能展示图，与游戏图标分开。Mod 套装内嵌成员；内融核心包用数量标签显示；邮件使用标题及正文展示。语言键、内部路径及 `GAMEPLAY_DAMAGE_TO_POWER` 等协议键保持原样。未关联/歧义记录保留原值和状态；缺图不使用无信息占位图。`iconStatus=available` 表示生成了精确资源地址，不代表每次构建都对全部图片逐个联网检查。

概率用 0～1 的 `probability` 表示，例如 `0.25` 是 25%；`dropChancePercent` 保留官网百分数，例如 `25`。来源触发概率、奖励池内概率、抽取次数、物品数量是独立概念。来源 400% 或 Plus `chance: 4` 转为同池抽 4 次，不截断为 100%，也不自动推算“至少获得一次”的概率；未知概率为 `null`，待审核的官方数值保留标记。

同 ID 的互补字段合并，官方 Public Export 本地化值优先。完全相同的重复记录可去重，同 ID 冲突记录会报错。普通掉落名指普通版本；只给奖励类别时用 `identityResolution=category` 保存候选，奖励概率只属于类别，不分配给候选。其他真实歧义显式保留。只有制造行为完全相同的配方才合并，旧身份保存为 `identityAliases`。

## 采集链与数据通道

Plus 与语言表均接入 `Pluto 提取 → GitHub Raw → tmp/cache` 降级链。Pluto 运行需要本机游戏资源、包数据、运行时及脚本依赖；配置缺失、提取失败或校验不通过时自动降级。Raw 只是无本机资源时的兜底，本项目统一生成和发布成品。实际 Pluto 提取需在具备依赖的机器上验证。官网战甲列表和详情页作为额外一手输入冻结采集，通过精确游戏资源路径关联宣传素材。

NnmBot 只在本项目不能提供、且完全由社区人工维护的独立领域保留社区通道，例如仲裁精华、黑化、术语。两通道均保留拉取、差异预览、审核、事务入库和自维护字段保护。NnmBot 后续应消费本项目生成的仲裁排期和 Export 目录；动态 PHP 接口继续由其动态业务处理，静态引用使用本项目代码簿。

## 固定版本消费

同一批 manifest 和成品必须固定到相同 tag/commit，通过 manifest 校验 hash。路径模板：

```text
https://raw.githubusercontent.com/<owner>/warframe-datasource-nnm/<ref>/data/latest/manifest.json
https://raw.githubusercontent.com/<owner>/warframe-datasource-nnm/<ref>/data/latest/equipment/warframes.json
https://raw.githubusercontent.com/<owner>/warframe-datasource-nnm/<ref>/data/latest/rewards/relics.json
https://raw.githubusercontent.com/<owner>/warframe-datasource-nnm/<ref>/data/latest/upgrades/riven-attributes.json
```

当前 manifest `schemaVersion: 2` 描述发布清单格式，业务路径和嵌套字段仍需由消费端迁移适配。旧 `catalog/**`、`plus/**`、`linked/**`、多个遗物文件、等级表及反向掉落表已被对应业务成品替代。GitHub Actions 每日或手动采集，有变化时提交并打日期 tag；本地执行采集本身不提交、推送或打 tag。

## 发布安全与配置

生成器先写临时目录并完整校验，再整树替换 `data/latest/`，失败尝试恢复旧目录。同一输出根目录有写锁。`data/latest/` 是生成目录，自维护内容应放在消费端，避免下次生成被覆盖。清洗 manifest 保留本项目版本、文件 hash、长度与记录数，不传播上游来源元数据。

`data/latest/` 与 `tmp/cache/` 可提交；`tmp/inputs-*/`、临时原始工作区、`docs/` 不纳入版本管理。配置集中在 `src/core/config.ts`：

- `DATASOURCE_DATA_DIR`、`DATASOURCE_TMP_DIR`：输出目录。
- `DATASOURCE_REQUEST_TIMEOUT_MS`、`DATASOURCE_MAX_RESPONSE_BYTES`、`DATASOURCE_REQUEST_RETRIES`：下载控制。
- `WF_GAME_DIR`、`WF_PACKAGES_BIN_DIR`、`WF_PLUTO_DIR`、`WF_PLUTO_RUNTIME`、`WF_PLUTO_TIMEOUT_MS`：Pluto 提取前提与运行控制。
- `WF_PUBLIC_EXPORT_INDEX_URL`、`WF_PUBLIC_EXPORT_MANIFEST_URL`、`WF_PLUS_RAW_BASE_URL`、`WF_LANGUAGES_RAW_BASE_URL`、`WF_MARKET_RIVEN_ATTRIBUTES_URL`、`WF_MARKET_RIVEN_WEAPONS_URL`、`WF_MARKET_ITEMS_URL`、`WF_WEEKLY_RIVENS_URL`、`WF_ARBITRATION_SCHEDULE_URL`、`WF_MARKET_USER_AGENT`：上游配置。

TLS 校验保持开启。若进程被强制终止，确认无任务运行后再处理残留 `.gen-staging-*`、`.gen-backup-*` 或写锁。
