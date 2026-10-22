# warframe-datasource-nnm

本地运行的 Warframe 数据采集与静态 JSON 生成项目。**不启动 Web 服务，不监听端口，不直接对外提供 API。**

工作方式：拉取本仓库 → 执行采集 → 校验生成文件 → 提交并推送 GitHub（本地手动，或由 GitHub Actions 定时/手动触发自动提交打 tag）→ NnmBot 或其他消费者在运行时通过 GitHub Raw 拉取。采集器不作为 NnmBot 的内部模块；本项目不会修改 NnmBot。

## 运行

要求 Node.js 22 或更新版本。

```bash
npm ci
npm run collect
npm run verify
```

`collect` 获取原始数据、生成 projection，产出两棵目录树：`tmp/<时间戳>/`（原始数据，本地保留最近两份、不提交）与 `data/latest/`（清洗数据，覆盖式发布、提交）。命令完成后退出，无需额外服务进程。`verify` 离线校验 `data/latest/` 的 manifest、文件集合、JSON、SHA-256、长度及来源引用。

开发验证（不依赖外网，不运行生产打包）：

```bash
npm run typecheck
npm test
```

## 当前输出

`data/latest/` 中的文件覆盖式发布（每次构建整树替换，只保留一份，历史靠 Git 提交追溯）；`tmp/<时间戳>/` 是中间产物，本地保留最近两份供 plus 降级、不提交：

```text
tmp/<时间戳>/public-export/...   # DE 官方原始文件（index/en/zh/shared）
tmp/<时间戳>/warframe-market/...  # Market 紫卡原始响应
tmp/<时间戳>/weekly-rivens/...    # 官方周成交原始 JS 字面量（.txt）
tmp/<时间戳>/plus/...             # Pluto 提取的 Export*.json 快照

data/latest/catalog/...          # 官方领域投影（22）
data/latest/market/...           # Market 物品目录+紫卡属性+武器（3）
data/latest/riven/...            # 紫卡定义/倾向/周成交（6）
data/latest/plus/...             # Pluto 提取独有域（23）
data/latest/drop/...             # 官方掉落表解析（20）
data/latest/linked/...           # 跨源关联表（2）
data/latest/worldstate/...       # WorldState 代码簿（7）
data/latest/usage/...            # 官方年度使用率（6）
data/latest/arbitration/...      # 仲裁小时排期（1）
```

完整文件清单以生成后的 `data/latest/manifest.json` 为准，每个文件的字段、主键、来源与更新频率见 [数据契约](docs/数据契约.md)。原始输入与清洗投影分开保留，不建立跨来源的统一物品总表。

当前包含官方 Export 15 语言 + 领域投影（装备/升级/战利品/配方）+ Market 物品目录与紫卡 + 官方紫卡定义/倾向/周成交 + 官方掉落表解析 + Pluto 独有域 + WorldState 代码簿 + 官方年度使用率 + 仲裁排期。黑话/攻略/地图等社区人工策展内容不纳入一手产物（见 [数据覆盖与参考结论](docs/数据覆盖与参考结论.md)）。

## GitHub Raw 消费

本项目的产物就是仓库文件，没有 `/api/v1`、健康检查或自建下载接口。Raw 地址模板如下，`<owner>` 和 `<ref>` 必须替换为实际仓库所有者与分支（或 tag/commit）：

```text
https://raw.githubusercontent.com/<owner>/warframe-datasource-nnm/<ref>/data/latest/manifest.json
https://raw.githubusercontent.com/<owner>/warframe-datasource-nnm/<ref>/data/latest/catalog/equipment/warframes.json
https://raw.githubusercontent.com/<owner>/warframe-datasource-nnm/<ref>/data/latest/market/riven-attributes.json
```

建议消费者将同一批 manifest 和数据文件固定到**同一个 commit SHA 或日期 tag（`data-YYYYMMDD`）**，按需拉取并校验文件 hash。直接读取移动分支虽然路径固定，但多次请求期间可能跨越提交或缓存版本，不能保证整批一致。Git 保存历史快照，不再为每次采集生成重复的公开 `releases/<id>` 目录和 `current.json` 指针。

数据有变化时 GitHub Actions 会自动提交并打日期 tag；本地采集完成后，查看 `git status --short`、检查 `data/latest/` 的差异，再自行提交/推送。

## 生成安全与配置

- 所有下载/清洗成功后才进入文件发布；发布先写临时目录并完整校验，再整树替换 `data/latest/`，不会逐文件覆盖旧快照。替换失败会尝试恢复旧目录，旧文件不会混入新快照。
- 同一输出根目录有写入锁；并行发布不会互相替换文件。`data/latest/` 是自动生成目录，手工策展数据不得直接放入其中，否则下次完整生成会移除。
- `DATASOURCE_DATA_DIR` / `DATASOURCE_TMP_DIR` 可分别覆盖清洗/原始数据的输出根目录，默认 `data` / `tmp`；`data/latest/` 可提交，`tmp/`（本地保留最近两份供 plus 降级）与 `.cache/`、`vendor/`、`docs/` 不提交。
- `DATASOURCE_REQUEST_TIMEOUT_MS`、`DATASOURCE_MAX_RESPONSE_BYTES`、`DATASOURCE_REQUEST_RETRIES` 控制上游请求；`WF_PUBLIC_EXPORT_INDEX_URL`、`WF_PUBLIC_EXPORT_MANIFEST_URL`、`WF_MARKET_RIVEN_ATTRIBUTES_URL`、`WF_MARKET_RIVEN_WEAPONS_URL`、`WF_MARKET_ITEMS_URL`、`WF_WEEKLY_RIVENS_URL`、`WF_PLUS_RAW_BASE_URL`、`WF_LANGUAGES_RAW_BASE_URL`、`WF_ARBITRATION_SCHEDULE_URL`、`WF_GAME_DIR` 与 `WF_MARKET_USER_AGENT` 见 `src/core/config.ts`。TLS 校验保持开启。
- 若生成进程被强制终止，确认无任务运行后再人工处理残留 `.gen-staging-*` / `.gen-backup-*`。恢复步骤见 [发布协议](docs/发布协议.md)。
