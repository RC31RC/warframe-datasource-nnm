
## 运行前提（Windows）

Pluto 提取链强依赖 Windows 游戏环境，需配置（见 `src/core/config.ts`）：

- `WF_PLUTO_RUNTIME`：Pluto 运行时路径
- `WF_PACKAGES_BIN_DIR`：游戏包数据目录（`deps.pluto` 中的 `F:\warframe-packages-bin-data`）
- `WF_GAME_DIR`：Warframe 游戏安装目录

无游戏环境（macOS / CI）自动降级：GitHub Raw 拉取成品 → `tmp/cache` 兜底。

