# mwi-calculator
银河奶牛计算器插件，自动计算需求缺口，一键跳转到制作、购买。

## 安装

需先安装 Tampermonkey 等用户脚本管理器。

- **[从 GitHub 安装 / 切换到 GitHub 更新源](https://raw.githubusercontent.com/RERoger/mwi-calculator/main/dist/mwi-calculator.user.js)**
- [GreasyFork 原发布页](https://greasyfork.org/zh-CN/scripts/593184)

当前镜像版本：**0.0.9**。除安装/更新及项目链接外，业务代码与本次获取的 GreasyFork 版本一致。

### 已有用户

保留原脚本，不要先卸载。先备份包含脚本存储的数据，再打开上面的安装链接，并确认更新的是名称为 `[银河奶牛]生产制作计算器` 的原条目。旧名称为 `MWI_Calculator` 的安装可能被识别为另一个脚本，需要先处理数据迁移。不要同时启用两份计算器。

GitHub 与 GreasyFork 当前版本号相同时，也需要手动安装一次以切换更新源；仅等待旧脚本自动检查更新不会改用 GitHub。

## 更新方式

此仓库版本的 `@updateURL` 和 `@downloadURL` 均指向 GitHub Raw，后续由脚本管理器按其设置检查更新。

- `dist/mwi-calculator.user.js`：完整安装脚本。
- `dist/mwi-calculator.meta.js`：与安装脚本完全一致的元信息块，用于检查更新。

维护者发布新版本时应同时更新这两个文件，保持版本号一致。此仓库未配置自动从 GreasyFork 同步，GreasyFork 上的新版本需要维护者另行同步至本仓库。

GitHub Raw 和脚本的 jsDelivr 依赖仍需能被访问；本仓库不需要 GitHub Pages。

## 来源

原作者：RERoger。原脚本声明许可证为 MIT，作者及许可证字段保留。
