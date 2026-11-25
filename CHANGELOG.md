# Changelog

## 1.1.26（2026-11-25）

### 发布前清理：移除排错期临时诊断代码

- 清掉 1.1.0~1.1.20 排错时埋的临时诊断：client.js 改 window.title（SCH|/REG= 前缀）、
  写 localStorage（__DSH_SCH_* 标记）、index.js 的 /diag 回写本机日志路由。
- 这些只用于本机排错，随正式版发布会污染用户窗口标题与本机存储，发布前移除。
- 功能逻辑不变：左下角 footer.action 入口 + 右侧栏 openTab 小面板 + inject 5 服务声明
  + 绝对定位竖排（1.1.25 已验证）全部保留。
- 生效方式：**彻底退出客户端再启动**。

## 1.1.25（2026-11-25）

### 修正 1.1.24：撤销容器 flex-direction:column（它把按钮内部文字竖排了）

- 用户实测截图：「日程助手」四字竖着排成一条，web free 正常 —— 1.1.24 的
  `[class*="footerActions"]{flex-direction:column}` 命中了宿主 footer 容器，
  连带把 occupant「按钮内部」的图标+文字也竖排，完全错。
- 修正：撤销该规则；改为 footer 容器保持宿主原样，只把本插件 `.dsc-launch-layer`
  绝对定位到 footerActions 上方（`position:absolute; bottom:calc(100% - 8px)`），
  与 web free 形成上下两列，两者内部都横向图标+文字、左对齐。
  只作用于本插件元素，不碰宿主/第三方按钮。
- 量化验收：日程助手 y=16、web free y=58（上下两行）；label h=19（横排未竖）。
- 生效方式：**彻底退出客户端再启动**。

## 1.1.24（2026-11-25）

### 修正 1.1.23 竖排没生效：选择器命中错层

- 用户重启后仍是左右布置、且只见「日程助手」（web free 被 width:100% 挤出可视区）。
- 根因：1.1.23 用 `div:has(> .dsc-launch-layer)`，但 slots 给每个 occupant 包了一层，
  `>` 直接子选择器命中的是包裹层不是 footerActions 容器，竖排规则等于没作用。
- 修正：从宿主编译产物确认真实类名 `wtg9ga_footerActions`（样式 display:flex 默认 row），
  改用属性选择器 `[class*="footerActions"]{flex-direction:column;flex-wrap:nowrap}`
  直接命中容器本身，与 slots 包几层无关。
- 生效方式：**彻底退出客户端再启动**。

## 1.1.23（2026-11-25）

### 左下角两个入口改成上下成一列（不再左右并排）

- 用户要求：左下角「日程助手」与「DeepSeek 网页面板」上下排成一列、图标+文字左对齐，
  与左上角导航项同款；不是左右并排。
- 根因（宿主 asar 源码实证）：SidebarRoot.module.css 里 `.footArea{flex-direction:column}`
  但 `.footerActions{display:flex}` 未写 flex-direction → 默认 row，两个 footer occupant
  必然横排。这是宿主实现，插件改不了它的 CSS module 类名。
- 修正：注入 `div:has(> .dsc-launch-layer){flex-direction:column}` —— 只在含本入口时
  命中 footer 容器改竖排；不影响 collapsed rail / 其它 footer。
- 量化验收：改前两者 y=58/x=0 与 y=58/x=238（同一行左右）；改后 y=58 与 y=108
  （上下两行、都左对齐）。对照图见本次交付。
- 生效方式：**彻底退出客户端再启动**（CSS + 入口装配，硬刷新验证不了冷启动）。

## 1.1.22（2026-11-25）

### 左下角入口与 web free 对齐（同一水平线、同款盒模型）

- 用户反馈：入口能一键弹出右侧栏了，但「日程助手」和「DeepSeek 网页面板」两个按钮
  没对齐（前者偏上、字号小一号）。
- 根因：web free 用 CSS class（height:42px / margin:8px 0 0 / padding:0 10px 0 8px /
  font-size:14px / --dsw-alias-* 令牌）；我之前用内联样式
  （height:30px / padding:0 10px / font-size:13px / radius:6px）。盒模型不同 → 错位。
- 修正：CSS 追加 .dsc-launch-*（数值与令牌照抄 web free 的 dsw-webpanel-toggle-*），
  LaunchButton 改成同构的 layer + button + icon + label 结构。
- 量化验收（并排量 top/h）：改前 y=42/h=30 vs web free y=40/h=42（差 2px、12px）；
  改后两者 y=130/h=42 完全相同。对照图见本次交付。
- 生效方式：**彻底退出客户端再启动**（入口座位 + CSS 变更，硬刷新验证不了冷启动）。

## 1.1.21（2026-11-25）

### 入口对齐 web free：左下角小按钮一键在右侧栏弹出 tab（不再是大界面）

- 用户明确要的效果 = dsh-deepseek-web-free 同款：左侧栏底部一个图标/文字小按钮，
  点一下在右侧栏弹出小面板 tab，主对话区不动。
- 1.1.12~1.1.20 误用 sidebar.panellist + main 主面板，点击把整个对话区切成铺满的
  大界面，与要求完全不同。
- 修正：删掉 main / sidebar.panellist 注册，只保留 sidebar.footer.action 一个入口；
  注册参数照抄 web free（name+id+order+inject(openPanelTab)）；
  LaunchButton.onClick → openPanelTab → ctx.sidebarRight.openTab(NAME)；
  面板内容仍由 registerOfficialTab 的 sidebar.right.pane.tab key=NAME 提供。
- inject 保持 5 服务声明（1.1.20 已修冷启动）；openSchedulePanel 直接读
  ctx.sidebarRight（已声明），ctx.get 兜底。
- 生效方式：**彻底退出客户端再启动**（入口座位变更；硬刷新验证不了冷启动时序）。

## 1.1.20（2026-11-25）

### 冷启动根因修复：照抄 web free 的 inject 声明，重启后按钮不再消失

- 症状：Ctrl+R 硬刷新有按钮，彻底重启客户端后按钮全部消失。
- 根因：1.1.19 把 `exports.inject` 回退成 `[]`，apply 在冷启动立即执行、服务尚未
  provide，`ctx.get("slots")` 返回 null，左侧入口 + 右侧面板注册全部落空；
  热刷新时服务已在故正常。上一版把根因误判为「inject 声明导致 pending」。
- 修正：`exports.inject` 声明内核确实提供的 5 个服务
  （slots / locale / sidebarRight / sidebarRightTabs / uiConversation）——
  与官方版 dsh-deepseek-web-free 完全同款，同一内核实测重启照样有按钮。
- pending 的真因是声明了内核**不存在**的服务名（layout / betterSidebar），
  不是 inject 机制本身；那两个已不作为 inject 声明。
- 生效方式：**彻底退出客户端再启动**（冷启动时序问题，硬刷新验证不了）。

## 1.1.19（2026-11-25）

### 回退 1.1.18 的 inject 声明：它导致 client entry pending、按钮消失

- 用户重启后按钮完全消失；实测 client entry 无任何标记（pending），确认
  在 dsh.client.inject 声明 sidebarRight/sidebarRightTabs 会让本包 entry pending。
- 回退 inject 为 []（1.1.12 已验证能显示按钮的状态）。
- 改用 `ctx.get('sidebarRight')` 读服务（播放器 resolveSlots 已验证 inject=[] 时
  ctx.get 仍可读取已提供服务），失败再退回 ctx.inject 响应式等待。
- 生效方式：刷新界面（Ctrl+R）。

## 1.1.18（2026-11-25）