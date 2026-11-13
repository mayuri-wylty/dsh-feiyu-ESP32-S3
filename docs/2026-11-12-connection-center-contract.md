# 连接中心 · 后端/前端契约（T0，Lead 独占修改）

范围：设置页（`client.js`）新增「连接中心」卡，后端新增 `lib/connections.js`。
前端只保留 `client.js`；`lib/settings.html` 废弃（T6）。所有路由继承 `route()` 的回环 + 信任栅栏。

## 通用规则
- 前缀 `/dsh-feiyu/api`；响应 `Content-Type: application/json`。
- 错误统一 `{ ok:false, error:string, code:string }`（`code` 取下表）。
- **任何响应不得回显** cookie / SESSDATA / bili_jct / token / 文件系统绝对路径。
- 时间戳一律毫秒 epoch；`*Sec` 为秒。
- 默认探测廉价（端口、文件 mtime、单次 HTTP）；抖音 `self-info`（约 9s，起浏览器）只在 `POST /connections/check` 里跑。

错误码：`E_LOOPBACK` `E_BAD_REQUEST` `E_NOT_CONFIGURED` `E_GATEWAY_DOWN` `E_TIMEOUT` `E_BUSY` `E_SPAWN` `E_INTERNAL`

## 1. `GET /connections`
```jsonc
{
  "ok": true,
  "checkedAt": 1731400000000,
  "bilibili": { "configured": true, "loggedIn": true, "mid": "123", "name": "昵称", "checkedAt": 0, "error": null },
  "douyin":   { "configured": true, "loggedIn": true, "nickname": "", "secUid": "", "cookieAgeSec": 3600, "checkedAt": 0, "error": null,
                "login": { "state": "idle" } },
  "qq":       { "gateway": { "ok": true, "url": "http://127.0.0.1:3000" }, "loggedIn": true, "uin": "1523578516", "nickname": "",
                "qr": { "exists": false, "ageSec": null, "expired": false }, "error": null },
  "wechat":   { "alive": true, "ageSec": 12 },
  "esp32":    { }
}
```
- `bilibili`：读 `credentials.json` 是否齐全（`configured`）；GET 时用**缓存的**上次 nav 结果（进程内 5 分钟 TTL），无缓存则只返回 `loggedIn:null`；真实校验走 `/connections/check`。
- `douyin`：`configured` = cookie 文件存在；`loggedIn` = cookie 含 `sessionid`/`sessionid_ss` 且未过期（廉价判断）；`nickname/secUid` 仅来自上次 `check` 缓存，否则 `""`。
- `qq`：`gateway.ok` = 3000 端口探活；`loggedIn/uin/nickname` 来自 OneBot `get_login_info`（网关通时才调，1.5s 超时），否则 `null`。`qr.expired` = 二维码文件 mtime 超过 2 分钟。
- `esp32`：原样复用 `/esp32/status` 的内容。
- `loggedIn:null` 表示「未知/未探测」，前端显示「未检测」，不是「未登录」。

## 2. `POST /connections/check`
请求 `{ "target": "bilibili" | "douyin" | "qq" }`；响应 = 该平台对象（同上结构）外包 `{ ok:true, target, result:{…} }`。
- bilibili：真实调 nav，写入缓存。
- douyin：跑 `douyin_interact.py self-info`（超时 40s），写入缓存；失败 `ok:false, code:"E_TIMEOUT"|"E_SPAWN"`。
- qq：调 `get_login_info`。
- 同一 target 并发再请求 → `409 E_BUSY`。

## 3. `GET /qq/qrcode`
```jsonc
{ "ok": true, "exists": true, "ageSec": 20, "expired": false, "dataUrl": "data:image/png;base64,…" }
// 无二维码：{ "ok": true, "exists": false, "ageSec": null, "expired": false, "dataUrl": null }
```
- 二维码来源目录：`qq.napcat_dir`（配置）→ 默认 `D:/NapCatOld/napcat`，文件 `cache/qrcode.png`。路径不出现在响应里。
- 文件大于 512KB 视为异常，返回 `exists:false`。

## 4. 抖音扫码登录会话
- `POST /douyin/login` 请求 `{ "action": "start" | "cancel" }`，响应 `{ ok:true, state, startedAt, remainingSec }`。
- `GET /douyin/login` 同样返回当前会话状态。
- `state`：`idle`（无会话）｜`waiting`（Chrome 已弹出，等待扫码，≤180s）｜`ok`（cookie 已落盘且含 sessionid）｜`timeout`｜`error`（带 `error` 文本）。
- 同时只允许一个会话；`start` 时已有 `waiting` → 返回当前状态（幂等，不重复拉起）。
- `ok` 之后 GET 仍保持 `ok` 直到下一次 `start`；进程退出码非 0 且无 sessionid → `error`/`timeout`。
- 后端 `dispose` 时必须杀掉登录子进程。

## 5. B站 cookie 写入
沿用现有 `POST /api/cookie`（`{sessdata,bili_jct,buvid3}` → `{ok,self,detail}`），不新增、不改行为。写入成功后后端刷新 B站 nav 缓存。

## 6. 配置键（均可选）
- `qq.napcat_dir`：NapCat 目录（默认 `D:/NapCatOld/napcat`）
- `qq.napcat_token`：OneBot 网关 token（仅后端读取，绝不进任何响应）
- `qq.napcat_http`：已有，默认 `http://127.0.0.1:3000`

## 7. 前端约定（`client.js`）
- API 路径集中在一个常量对象 `CONN_API`。
- 纯函数 `deriveConnections(raw)` → `[{id,label,state:'ok'|'off'|'unknown'|'warn',summary,actions}]`；`loginFlow` 状态机（抖音轮询：start 后每 2s GET，`ok/timeout/error` 即停，卸载即停）。
- B站 cookie 输入框 `type="password"`，提交后立即清空，不在界面回显。
- 抖音 `self-info` 只在点「重新检测」时触发，不自动轮询。
- 夹具：`test/fixtures/connections.json`（四种状态），UI/渲染测试以此为准。
