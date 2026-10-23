
## 运行前提

Pluto 优先采集要求安装可执行的 Pluto runtime、Warframe 游戏目录、游戏包 JSON 数据目录和 `pluto/` 下的依赖仓库。采集器通过环境变量向 Plus 脚本注入包目录和独立临时输出目录：

- `WF_PLUTO_RUNTIME`：Pluto 运行时路径
- `WF_PACKAGES_BIN_DIR`：本地游戏包 JSON 数据目录
- `WF_GAME_DIR`：Warframe 游戏安装目录
- `WF_PLUTO_DIR`：Pluto 脚本与依赖目录

任一前提缺失、Pluto 执行失败或产物未通过完整性校验时，自动降级为 GitHub Raw → `tmp/cache`。语言表按相同顺序从本地资源提取、Raw、cache 获取。

