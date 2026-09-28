# B站多账号一键切换 (Bilibili Multi-Account Switcher)

一个基于 Chrome/Edge Manifest V3 的浏览器扩展，用于在 B站快速保存和切换多个账号，精准操作登录 Cookie，且不影响本地设置。

## ✨ 功能特性

*   **多账号保存与切换**：一键保存当前 B站账号（头像、昵称、登录凭证），支持多个账号一键切换。
*   **免备注交互**：切换账号时，直接弹出带半透明遮罩的卡片小窗，列表展示已保存账号的头像和昵称，点击头像即可切换。
*   **当前账号高亮**：弹窗内当前使用的账号头像会有蓝色边框标识，且不可重复点击。
*   **UI 融入原生**：按钮悬浮在“退出登录”下方，鼠标悬停放大并带有边缘荧光，整体风格与 B站原生 UI 保持一致。
*   **精准 Cookie 操作**：只精准清除和替换 SESSDATA、bili_jct、DedeUserID 等登录相关 Cookie。
*   **保留本地设置**：绝不清理浏览器本地的 localStorage 或 IndexedDB，切换账号后用户的音量、画质偏好、弹幕设置等完全保持不变。

## 🚀 安装指南

### 本地加载（开发者模式）
1. 下载本仓库的代码（点击右上角 `Code` -> `Download ZIP`），并解压到本地文件夹（建议命名为 `bili-account-switcher`）。
2. 打开浏览器扩展管理页面：
   *   Edge: `edge://extensions/`
   *   Chrome: `chrome://extensions/`
3. 开启右上角的 **开发者模式 (Developer mode)**。
4. 点击 **加载解压缩的扩展 (Load unpacked)**，选择刚才解压出来的 `bili-account-switcher` 文件夹。
5. 打开 B站 (bilibili.com) 并刷新页面，扩展即可生效。

## 📖 使用方法

1. **保存账号**：登录 B站账号，将鼠标移到右上角头像，在弹出的悬浮窗下方点击“保存账号”。
2. **切换账号**：鼠标移到头像，点击“切换账号”，在弹出的小窗中点击对应账号的头像即可完成切换。
3. **添加新账号**：先“保存当前账号”，然后退出登录，登录新账号，再次点击“保存账号”。

## 📁 目录结构

```text
bili-account-switcher/
├── manifest.json
├── icons/              # 扩展图标
└── src/
    ├── background.js   # 核心逻辑（Cookie 读写、账号管理）
    └── content/        # 页面注入脚本及样式（UI 交互）
