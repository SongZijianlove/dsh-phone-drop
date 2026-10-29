# 更新日志

本项目所有值得记录的改动都会写在这里。格式参照 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

## [0.4.2] - 2026-10-29

### 变更

- 发布时带上 `CHANGELOG.md` 更新日志（此前 0.4.1 的 tarball 不含该文件）。代码无任何改动，仅为让版本附带可读的更新说明。

## [0.4.1] - 2026-10-29

### 修复

- **中文桌面路径下建快捷方式失败**：Windows 上「真实桌面」被重定向到含中文的路径（例如 `F:\新建文件夹`）时，PowerShell 5.1 把 stdout 按 OEM 代码页（GBK）编码、而 Node 按 UTF-8 读取，导致桌面路径被吞成 `F:\??????`，随后 `createShortcut` 拿到乱码路径抛 `FileNotFoundException`，快捷方式静默建不出来。现在改为让 PowerShell 用 base64 输出桌面路径，脚本统一用 `-EncodedCommand`（base64 of UTF-16LE）传入，并加 `decodeShellOutput` 对 GBK 字节回退解码，中文路径全链路不再失真。

### 改进

- 补两个针对中文路径的单元测试（`toEncodedCommand` 无损还原、`decodeShellOutput` 回退 GBK）。
- `plugin.test.js` 现在把设置文件指向沙盒，不再误读真实的 `~/.dsh-phone-drop.json`，避免测试断言被本机残留设置污染。

## [0.4.0] - 2026-10-29

### 新增

- **首次安装设置弹窗**：`npm install -g dsh-phone-drop` 装完（Windows）会先弹一个窗口，让用户一次定三件事——照片保存位置、是否在桌面建「手机直传」快捷方式、装完是否立刻打开一次二维码页面。点「跳过」或直接关窗则全部用默认值，以后随时 `dsh-phone-drop --setup` 重开。
- `--setup` / `--no-setup` 命令行选项：强制重开设置窗口，或跳过首次设置窗口。
- `postinstall` 钩子：只在**全局安装**时弹窗，作为依赖被装时不打扰；任何路径都以 `process.exit(0)` 收尾，绝不因弹窗问题卡死安装。
- `setup` 子路径导出（`dsh-phone-drop/setup`），供编程调用首次设置逻辑。

### 变更

- 设置文件（`~/.dsh-phone-drop.json`）新增 `setupAt` / `shortcut` / `autoOpen` 字段；`writeOverride` 改为合并保留旧键，换目录不再冲掉「已设置过」的标记。

## [0.3.1] - 2026-10-11

### 新增

- 首个发布版本：局域网手机直传 DSH 插件。电脑屏幕显示二维码，手机扫码打开，拍照或选图（可选「文档模式」自适应二值化扫描）直接落进电脑文件夹，全程局域网直连。
- `phone_drop` 工具（`url` / `qr` / `recent` / `setdir`），让助手直接把地址和二维码念给用户。
- `npx dsh-phone-drop --port ... --dir ... --open` 脱离 DSH 独立运行。

[0.4.2]: https://github.com/SongZijianlove/dsh-phone-drop/compare/v0.4.1...v0.4.2
[0.4.1]: https://github.com/SongZijianlove/dsh-phone-drop/compare/v0.4.0...v0.4.1
[0.4.0]: https://github.com/SongZijianlove/dsh-phone-drop/compare/v0.3.1...v0.4.0
[0.3.1]: https://github.com/SongZijianlove/dsh-phone-drop/releases/tag/v0.3.1
