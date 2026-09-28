# B站账号切换（Edge / Chrome 扩展）

从油猴脚本《B站多账号一键切换 1.4.0》改造而来的浏览器扩展：保留原有的 UI 设计与操作逻辑，
并把「切换账号」做成**只替换登录凭证**——音量、是否连播、弹幕设置、清晰度、主题等本地偏好全部原样保留。

---

## 一、安装到 Edge

1. 打开 Edge，地址栏输入 `edge://extensions/` 回车。
2. 打开左下角（旧版在右上角）的 **开发人员模式**。
3. 点击 **加载解压缩的扩展**，选择本文件夹（含 `manifest.json` 的那一层）。
4. 地址栏右侧出现蓝色 ⇄ 图标即为安装成功；建议点「固定」把它钉在工具栏上。

> Chrome 同理：`chrome://extensions/` → 开发人员模式 → 加载已解压的扩展程序。
> 安装后请**刷新已打开的 B 站页面**，页面脚本才会注入。

## 二、怎么用

| 入口 | 操作 |
| --- | --- |
| 页面右上角头像悬浮面板 | 面板底部多出「保存账号 / 切换账号」两个按钮（B 站原生风格） |
| 扩展图标弹窗 | 账号列表 + 保存 / 切换 / 删除 / 导出 / 导入 |

- **保存账号**：读取当前登录态（`api.bilibili.com/x/web-interface/nav`）并存入本地，同一个 uid 会覆盖更新。
- **切换账号**：点账号行即可。页面脚本会先把当前账号的最新凭据回写，再替换登录 Cookie，然后自动刷新页面。
- **删除账号**：账号行右侧的 `×`，点一次变「确认」/「确认删除」，再点一次才真正删除（防止误触）。
- **导出 / 导入**：JSON 文件（**包含登录凭据，请妥善保管**），导入为合并模式。

## 三、为什么切换账号不会影响音量、连播、弹幕等设置

B 站的播放器偏好分散在两类地方，本扩展**两类都不碰**：

1. **Cookie**：只增删改下面 5 个登录凭证，其它 Cookie（`buvid3` 设备指纹、`CURRENT_QUALITY` 清晰度、
   `CURRENT_FNVAL`、`nostalgia_conf` 新版播放器开关、`b_nut`、`theme_style` 深色模式等）一律不动。

   ```
   SESSDATA   bili_jct   DedeUserID   DedeUserID__ckMd5   sid
   ```

2. **localStorage / IndexedDB**：完全不访问。音量、是否连播、弹幕开关与透明度、播放速度、
   「稍后再看」等偏好都存放在这里，因此天然不受影响。

这也是本扩展与「清空全部 Cookie 再登录」这类做法的根本区别：后者会把设备指纹和播放器偏好一起清掉。

## 四、目录结构

```
bili-account-switcher/
├─ manifest.json            # MV3 清单（仅申请 cookies + storage 权限）
├─ icons/                   # 16/32/48/128 图标（脚本生成，无第三方素材）
├─ src/
│  ├─ background.js         # 后台：Cookie 读写、账号库、消息路由
│  ├─ content/
│  │  ├─ content.js         # 页面脚本：面板按钮注入 + 切换弹窗 + 登录态读取
│  │  └─ content.css        # 移植自油猴脚本的样式（含深色模式适配）
│  └─ popup/                # 工具栏弹窗（popup.html / popup.css / popup.js）
├─ test/                    # 自动化测试（不参与扩展运行，可整目录删除）
│  ├─ mock-chrome.mjs       # chrome.* API 模拟 + background.js 沙箱加载器
│  ├─ run-tests.mjs         # 后台逻辑：37 项
│  ├─ content.test.mjs      # 页面 UI / 交互（jsdom）：27 项
│  └─ popup.test.mjs        # 扩展弹窗（jsdom）：34 项
├─ tools/make-icons.mjs     # 图标生成器（纯 Node，零依赖）
└─ package.json             # 仅供 npm test / jsdom 开发依赖
```

## 五、跑测试

```bash
npm install --no-save --cache ./.npm-cache jsdom   # 仅测试需要
npm test
```

三个套件共 **98 项断言**，全部通过。测试用模拟的 `chrome.*` API 加载**真实的** `background.js`
与 `content.js`，因此能验证：登录 Cookie 读写、非登录 Cookie 全程原值保留、导出导入、两段确认删除、
弹窗与页面脚本的指令通道等。

## 六、隐私说明

- 扩展只在本地读写 `bilibili.com` 的 Cookie 与 `chrome.storage.local`，**不向任何第三方服务器发送数据**。
- 登录凭据以明文存放于浏览器扩展存储中（与油猴脚本一致），导出文件同样含明文凭据，请勿随意外发。
- 权限仅 `cookies`（读写 B 站 Cookie）与 `storage`（存账号库）；未申请 `tabs`，
  因此**不会也不能**读取你的浏览历史（读取 B 站标签页地址依靠 `host_permissions` 授权范围）。

## 七、常见问题

- **页面没有出现按钮？** 刷新页面；或确认当前在 `www.bilibili.com` / `space.bilibili.com` / `t.bilibili.com`。
  按钮挂在头像悬浮面板内，把鼠标移到右上角头像上即可看到。
- **切换后要重新登录？** 说明该账号保存时凭据已过期，重新登录该账号后点「保存账号」覆盖一次即可。
- **扩展安装后第一次切换提示「页面脚本无响应」？** 该标签页是安装前打开的，刷新一次即可。
