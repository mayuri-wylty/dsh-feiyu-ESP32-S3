# ui-shots：设置面板静态渲染 + 截图（无需桌面版）

- 原理：真 React + `renderToStaticMarkup`，包装版 hooks 负责跑 effect / 喂假 fetch，直到稳定（见 render-html.mjs 头注释）。时间已钉死，输出可逐字节复现。
- React 来源：仓库外 `D:\AI_Code\_tmp_react`（`npm i --no-save react@18 react-dom@18`）；换位置用环境变量 `UI_SHOTS_REACT_DIR`。
- 生成 HTML：`node test/ui-shots/render-html.mjs --out after`（输出 `out/after.html`；`--dir <目录>` 改目录，`--conn loggedOut|probeFailed|douyinWaiting` 换连接中心夹具，`--expand` 展开折叠分组）。
- 逐字节对比：`cmp test/ui-shots/before/baseline.html test/ui-shots/out/after.html`（`--out after` 默认夹具与 baseline 相同）。
- 截图（无头 Edge，整页）：`node test/ui-shots/shoot.mjs --html test/ui-shots/out/after.html --out test/ui-shots/out/after-desktop.png --width 1100`，窄屏 `--width 420`，深色 `--theme dark`。
- 浏览器预览：`preview_start ui-shots`（`node test/ui-shots/serve.mjs`，端口 4173；`/before/baseline.html`、`/after.html`，可加 `?theme=dark`）。
- 基线在 `before/`（baseline.html、desktop.png、narrow.png）；`out/` 不入库。数据全是编造的（IP 用 192.0.2.x）。
- 不在 `npm test` 内；不要改 client.js 之外的东西来迁就它。
