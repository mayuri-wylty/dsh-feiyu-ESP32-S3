/**
 * dsh-feiyu —— 浏览器半边（DSH 原生设置页）
 *
 * 和 dsh-purge / 官方 dsh-client-ui-* 同一套契约：
 *   · 本文件由 dsh-client-modules 通过 package.json 的 exports["./client"] +
 *     dsh.client 声明发现，用 window.__ModuleLoader__ 包装成客户端模块；
 *   · inject: ["slots"] —— 等 slots 服务就绪再 apply；
 *   · 只注册一个槽位 settings.section，于是「设置」左栏多出一行「大肥鱼」。
 *
 * 所有请求走同源 /dsh-feiyu/api/*，凭据由宿主会话自带，不需要任何 token。
 */
window.__ModuleLoader__.load({
	id: "dsh-feiyu",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

		const react = require("react");
		const h = react.createElement;
		const { useState, useEffect, useCallback, useRef } = react;

		const name = "dsh-feiyu";
		const inject = ["slots"];

		// ── 接口层 ────────────────────────────────────────────────────────────
		const API = "/dsh-feiyu/api";

		async function api(path, init, opts) {
			const r = await fetch(API + path, Object.assign({
				cache: "no-store",
				credentials: "same-origin",
				headers: { "content-type": "application/json" },
			}, init || {}));
			const text = await r.text();
			let data = {};
			try { data = text ? JSON.parse(text) : {}; } catch {
				throw new Error(r.status + " 非 JSON 响应：" + text.slice(0, 120));
			}
			if (!r.ok || (data.ok === false && !(opts && opts.allowNotOk))) {
				const err = new Error(data.error
					|| (Array.isArray(data.errors) && data.errors.length ? data.errors.join("；") : "")
					|| ("HTTP " + r.status));   // 后端 /services 把原因放在 errors 数组，别吞成"HTTP 200"（10-25 实测坑）
				err.status = r.status;   // 429 退避要用
				throw err;
			}
			return data;
		}

		// 429 限流：指数退避（1s,2s,4s,8s,16s）最多 5 次，不中止（ESP32 状态/日志轮询用）
		const RETRY_DELAYS = [1000, 2000, 4000, 8000, 16000];
		const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
		async function apiRetry(path, init) {
			for (let attempt = 0; ; attempt++) {
				try {
					return await api(path, init);
				} catch (e) {
					if (!e || e.status !== 429 || attempt >= RETRY_DELAYS.length) throw e;
					await sleep(RETRY_DELAYS[attempt]);
				}
			}
		}

		const PLATFORMS = [
			["bilibili", "B站", "定时养鱼：看视频、写评论、@你"],
			["qq", "QQ", "点开即启动：秒回 + 网关 + 语音（按需开，不随 DSH 自启）", "restart"],
			["wechat", "微信", "点开即启动：替你回消息（按联系人分开记）", "restart"],
			["douyin", "抖音", "定时刷视频 + 真发评论 + @人"],
		];

		// ── 少量工具 ──────────────────────────────────────────────────────────
		// 深合并镜像后端 /api/config 的语义：面板状态不再丢同节其它嵌套字段（刷新恢复原状的根因）
		const section = (prev, patch) => {
			const deep = (b, o) => {
				const next = Object.assign({}, b && typeof b === "object" && !Array.isArray(b) ? b : {});
				for (const k of Object.keys(o || {})) {
					next[k] = o[k] && typeof o[k] === "object" && !Array.isArray(o[k]) ? deep(next[k], o[k]) : o[k];
				}
				return next;
			};
			return deep(prev, patch);
		};
		const short = (s, n) => {
			const t = String(s == null ? "" : s).replace(/\s+/g, " ").trim();
			return t.length > n ? t.slice(0, n) + "…" : t;
		};

		// ── 样式（用 DSH 主题变量，浅色/深色都跟着走）──────────────────────────
		const CSS = `
.fy-panel{display:flex;flex-direction:column;gap:14px;padding:2px 0 48px;color:var(--dsw-alias-label-primary,inherit);font-size:13px}
.fy-hero{display:flex;align-items:center;gap:12px}
.fy-avatar{width:42px;height:42px;border-radius:13px;display:flex;align-items:center;justify-content:center;font-size:22px;
  background:var(--dsw-alias-bg-l2,color-mix(in srgb,currentColor 8%,transparent));
  border:1px solid var(--dsw-alias-border-l2,color-mix(in srgb,currentColor 14%,transparent))}
.fy-h1{font-size:15px;font-weight:600;line-height:1.3}
.fy-sub{font-size:12px;color:var(--dsw-alias-label-secondary,#8b95a5);margin-top:2px}
.fy-card{border:1px solid var(--dsw-alias-border-l2,color-mix(in srgb,currentColor 14%,transparent));border-radius:12px;
  background:var(--dsw-alias-bg-l1,color-mix(in srgb,currentColor 3%,transparent));padding:14px 16px}
.fy-card-head{display:flex;align-items:center;justify-content:space-between;gap:10px;margin-bottom:10px}
.fy-card-title{font-size:13px;font-weight:600}
.fy-row{display:flex;align-items:center;gap:10px;margin:8px 0;flex-wrap:wrap}
.fy-label{min-width:96px;font-size:12.5px;color:var(--dsw-alias-label-secondary,#8b95a5)}
.fy-input,input.fy-input,select.fy-input,textarea.fy-input{background:var(--dsw-alias-bg-l2,color-mix(in srgb,currentColor 6%,transparent));
  border:1px solid var(--dsw-alias-border-l2,color-mix(in srgb,currentColor 16%,transparent));color:inherit;border-radius:8px;
  padding:6px 9px;font:inherit;font-size:13px;min-width:0;outline:none}
input.fy-input:focus,select.fy-input:focus,textarea.fy-input:focus{border-color:var(--dsw-alias-brand-primary,#3b6cf6)}
input.fy-input{width:190px}
input.fy-w-lg{width:340px}
input.fy-w-md{width:248px}
input.fy-w-sm{width:84px}
input.fy-w-xs{width:64px}
select.fy-input{min-width:250px}
textarea.fy-input{width:100%;min-height:136px;resize:vertical;line-height:1.65;font-family:inherit}
.fy-btn{background:transparent;
  border:1px solid var(--dsw-alias-border-l2,color-mix(in srgb,currentColor 26%,transparent));
  color:var(--dsw-alias-label-secondary,#6b7480);border-radius:8px;
  padding:5px 12px;font:inherit;font-size:12.5px;font-weight:400;cursor:pointer;
  transition:background .15s,border-color .15s,color .15s}
.fy-btn:hover{background:var(--dsw-alias-bg-l2,color-mix(in srgb,currentColor 8%,transparent));color:var(--dsw-alias-label-primary,inherit);border-color:color-mix(in srgb,currentColor 40%,transparent)}
.fy-btn:disabled{opacity:.55;cursor:default}
.fy-btn.primary{background:#3b6cf6;border-color:#3b6cf6;color:#fff;font-weight:600;box-shadow:0 1px 3px rgba(59,108,246,.28)}
.fy-btn.primary:hover{background:#2f5be0;color:#fff;border-color:#2f5be0}

.fy-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px}
@media (max-width:460px){.fy-grid{grid-template-columns:1fr}}
.fy-sw{display:flex;align-items:center;justify-content:space-between;gap:10px;padding:9px 12px;border-radius:10px;
  border:1px solid var(--dsw-alias-border-l2,color-mix(in srgb,currentColor 12%,transparent));
  background:var(--dsw-alias-bg-l2,color-mix(in srgb,currentColor 4%,transparent))}
.fy-sw-name{font-size:12.5px;font-weight:500}
.fy-sw-desc{display:block;font-size:11px;color:var(--dsw-alias-label-tertiary,#98a2b3);margin-top:2px;line-height:1.4}
.fy-switch{position:relative;flex:none;width:38px;height:22px;padding:0;border-radius:22px;cursor:pointer;
  border:1px solid var(--dsw-alias-border-l2,color-mix(in srgb,currentColor 18%,transparent));
  background:var(--dsw-alias-bg-l2,color-mix(in srgb,currentColor 10%,transparent));transition:background .16s,border-color .16s}
.fy-switch i{position:absolute;top:2px;left:2px;width:16px;height:16px;border-radius:50%;
  background:var(--dsw-alias-label-tertiary,#9aa4b2);transition:left .16s,background .16s}
.fy-switch.on{background:var(--dsw-alias-brand-primary,#3b6cf6);border-color:var(--dsw-alias-brand-primary,#3b6cf6)}
.fy-switch.on i{left:18px;background:#fff}
.fy-hint{font-size:11.5px;color:var(--dsw-alias-label-tertiary,#98a2b3);line-height:1.65;margin-top:8px}
.fy-stats{display:flex;flex-wrap:wrap;gap:8px}
.fy-chip{font-size:12px;padding:4px 10px;border-radius:999px;background:var(--dsw-alias-bg-l2,color-mix(in srgb,currentColor 6%,transparent));
  border:1px solid var(--dsw-alias-border-l2,color-mix(in srgb,currentColor 10%,transparent))}
.fy-chip b{font-weight:600}
.fy-group{display:flex;flex-direction:column;gap:10px}
.fy-group-head{align-self:flex-start;background:transparent;border:0;padding:2px 0;font:inherit;font-size:13px;font-weight:600;color:inherit;cursor:pointer}
.fy-group-body{flex-direction:column;gap:14px}
.fy-group.sub .fy-group-head{font-size:12px;font-weight:500;color:var(--dsw-alias-label-secondary,#8b95a5);margin-top:6px}
.fy-group.sub .fy-group-body{gap:0}
.fy-chip.ok{color:#2e9e5b}
.fy-chip.warn{color:#c9883a}
.fy-conn-qr{width:160px;height:160px;border-radius:8px;background:#fff;object-fit:contain}
.fy-chip.bad{color:var(--dsw-alias-label-secondary,#8b95a5)}
.fy-dot{display:inline-block;width:6px;height:6px;border-radius:50%;margin-right:6px;vertical-align:1px;background:#3fbf6f}
.fy-dot.off{background:#c9564d}
.fy-mem{max-height:232px;overflow:auto;margin-top:8px;font-size:12px;line-height:1.7}
.fy-report{max-height:260px;overflow:auto;margin-top:8px;font-size:12px;line-height:1.7;
  background:var(--dsw-alias-bg-l2,color-mix(in srgb,currentColor 6%,transparent));
  border:1px solid var(--dsw-alias-border-l2,color-mix(in srgb,currentColor 14%,transparent));
  border-radius:8px;padding:10px 12px;white-space:pre-wrap;word-break:break-word}
.fy-mem-item{padding:4px 0;border-bottom:1px dashed var(--dsw-alias-border-l2,color-mix(in srgb,currentColor 10%,transparent));
  color:var(--dsw-alias-label-secondary,#8b95a5)}
.fy-mem-item b{color:var(--dsw-alias-label-primary,inherit);font-weight:500;margin-right:6px}
.fy-tag{font-size:10.5px;padding:0 6px;border-radius:5px;margin-right:6px;
  background:var(--dsw-alias-bg-l2,color-mix(in srgb,currentColor 8%,transparent));color:var(--dsw-alias-label-tertiary,#98a2b3)}
.fy-notice{font-size:12px;line-height:1.5;padding:8px 12px;border-radius:8px;
  background:color-mix(in srgb,#3b6cf6 14%,transparent);color:var(--dsw-alias-label-primary,inherit)}
.fy-notice.err{background:color-mix(in srgb,#c9564d 16%,transparent)}
.fy-check{font-size:12px;line-height:1.8;margin-top:8px;max-height:200px;overflow:auto}
.fy-check span.ok{color:#3fbf6f}
.fy-check span.no{color:#c9564d}
.fy-mono{font-family:ui-monospace,Consolas,"Courier New",monospace;font-size:12px;word-break:break-all}
.fy-dev{display:flex;align-items:center;gap:8px;padding:6px 0;font-size:12px;
  border-bottom:1px dashed var(--dsw-alias-border-l2,color-mix(in srgb,currentColor 10%,transparent))}
.fy-dev b{font-weight:500}
.fy-bubble{font-size:12px;line-height:1.6;padding:5px 9px;border-radius:8px;margin:4px 0;word-break:break-word;
  background:var(--dsw-alias-bg-l2,color-mix(in srgb,currentColor 6%,transparent))}
.fy-bubble b{font-weight:600;margin-right:6px;color:var(--dsw-alias-label-secondary,#8b95a5)}
.fy-bubble.user{background:color-mix(in srgb,#3b6cf6 12%,transparent)}
.fy-bubble.assistant{background:color-mix(in srgb,#3fbf6f 12%,transparent)}
`;

		function useStyles() {
			useEffect(() => {
				const id = "dsh-feiyu/client";
				if (document.getElementById(id)) return undefined;
				const tag = document.createElement("style");
				tag.id = id;
				tag.dataset.pluginCss = "dsh-feiyu/client";
				tag.textContent = CSS;
				document.head.appendChild(tag);
				return () => { try { tag.remove() } catch { /* ignore */ } };
			}, []);
		}

		// ── 原子组件 ──────────────────────────────────────────────────────────
		function Card(props) {
			return h("section", { className: "fy-card" },
				h("div", { className: "fy-card-head" },
					h("div", { className: "fy-card-title" }, props.title),
					props.extra || null),
				props.children,
				props.hint ? h("div", { className: "fy-hint" }, props.hint) : null);
		}

		function Row(props) {
			return h("div", { className: "fy-row" },
				props.label ? h("span", { className: "fy-label" }, props.label) : null,
				props.children);
		}

		function Switch(props) {
			return h("button", {
				type: "button",
				className: "fy-switch" + (props.on ? " on" : ""),
				role: "switch",
				"aria-checked": props.on ? "true" : "false",
				"aria-label": props.label || "",
				disabled: props.disabled,
				onClick: () => props.onChange(!props.on),
			}, h("i"));
		}

		// 可折叠分组：内容始终挂在树里，仅 display 切换（开关/输入状态不受折叠影响）
		function Group(props) {
			const [open, setOpen] = useState(!!props.defaultOpen);
			return h("div", { className: "fy-group" + (props.sub ? " sub" : "") },
				h("button", { type: "button", className: "fy-group-head", "aria-expanded": open ? "true" : "false", onClick: () => setOpen(!open) },
					(open ? "▾ " : "▸ ") + props.title),
				h("div", { className: "fy-group-body", style: { display: open ? "flex" : "none" } }, props.children));
		}

		// ── 连接中心（契约：docs/2026-11-12-connection-center-contract.md）─────────
		const CONN_API = {
			list: "/connections",
			check: "/connections/check",
			qrcode: "/qq/qrcode",
			douyinLogin: "/douyin/login",
			cookie: "/cookie",
		};
		const CONN_LABELS = { bilibili: "B站", douyin: "抖音", qq: "QQ", wechat: "微信", esp32: "ESP32" };

		// 纯函数：契约 GET /connections → 每平台一行摘要。loggedIn:null = 未探测（unknown），不是未登录。
		function deriveConnections(raw) {
			const r = raw && typeof raw === "object" ? raw : {};
			const row = (id, state, summary) => ({ id: id, label: CONN_LABELS[id], state: state, summary: summary });
			const out = [];

			const b = r.bilibili || {};
			if (b.loggedIn === true) out.push(row("bilibili", "ok", "已登录" + (b.name ? "：" + b.name : "") + (b.mid ? "（" + b.mid + "）" : "")));
			else if (b.loggedIn === false) out.push(row("bilibili", "warn", "未登录或 cookie 失效" + (b.error ? "：" + b.error : "")));
			else out.push(row("bilibili", "unknown", "未检测" + (b.configured === false ? "（还没填 cookie）" : "")));

			const d = r.douyin || {};
			const dl = d.login || {};
			if (dl.state === "waiting") out.push(row("douyin", "warn", "等待扫码登录"));
			else if (d.loggedIn === true) out.push(row("douyin", "ok", "已登录" + (d.nickname ? "：" + d.nickname : "")));
			else if (d.loggedIn === false) {
				const why = d.error || (dl.state === "error" ? dl.error : "");
				out.push(row("douyin", d.configured && why ? "warn" : "off", "未登录" + (why ? "：" + why : "")));
			} else out.push(row("douyin", "unknown", "未检测"));

			const q = r.qq || {};
			if (!(q.gateway && q.gateway.ok)) out.push(row("qq", "off", "网关未启动"));
			else if (q.loggedIn === true) out.push(row("qq", "ok", "已登录：" + (q.nickname || "") + (q.uin ? "（" + q.uin + "）" : "")));
			else if (q.loggedIn === false) out.push(row("qq", "warn", "网关在线但未登录" + (q.error ? "：" + q.error : "")));
			else out.push(row("qq", "unknown", "未检测"));

			const w = r.wechat || {};
			out.push(w.alive ? row("wechat", "ok", "运行中") : row("wechat", "off", "未运行"));

			const e = r.esp32 || {};
			if (e.running === true) out.push(row("esp32", "ok", "通道运行中" + (Array.isArray(e.devices) ? "，在线设备 " + e.devices.length : "")));
			else if (e.enabled === false) out.push(row("esp32", "off", "未启用"));
			else if (e.enabled === true) out.push(row("esp32", "warn", "已启用但没在跑"));
			else out.push(row("esp32", "unknown", "未检测"));
			return out;
		}

		// 抖音扫码登录状态机：start 后每 2s GET，ok/timeout/error 即停；stop()（卸载）即停。
		// 依赖全部注入，纯逻辑可独立测试。
		function createLoginFlow(opts) {
			const call = opts.call, onState = opts.onState;
			const schedule = opts.schedule || setTimeout, clear = opts.clear || clearTimeout;
			const intervalMs = opts.intervalMs || 2000;
			let timer = null, dead = false, gen = 0;
			const halt = () => { gen++; if (timer != null) { clear(timer); timer = null; } };
			const errState = (e) => ({ state: "error", error: (e && e.message) || String(e) });
			const arm = (g) => {
				timer = schedule(async () => {
					timer = null;
					if (dead || g !== gen) return;
					let r;
					try { r = await call(CONN_API.douyinLogin); } catch (e) { r = errState(e); }
					if (dead || g !== gen) return;
					onState(r);
					if (r.state === "waiting") arm(g);
				}, intervalMs);
			};
			return {
				watch() { if (dead) return; halt(); arm(gen); },
				async start() {
					if (dead) return;
					halt();
					const g = gen;
					let r;
					try { r = await call(CONN_API.douyinLogin, { method: "POST", body: JSON.stringify({ action: "start" }) }); } catch (e) { r = errState(e); }
					if (dead || g !== gen) return;
					onState(r);
					if (r.state === "waiting") arm(g);
				},
				async cancel() {
					halt();
					let r;
					try { r = await call(CONN_API.douyinLogin, { method: "POST", body: JSON.stringify({ action: "cancel" }) }); } catch (e) { r = errState(e); }
					if (!dead) onState(r);
				},
				stop() { dead = true; halt(); },
			};
		}

		function ConnectionCenter() {
			const [raw, setRaw] = useState(null);
			const [unavailable, setUnavailable] = useState(false);
			const [err, setErr] = useState("");
			const [busy, setBusy] = useState("");
			const [qr, setQr] = useState(null);
			const [login, setLogin] = useState(null);
			const [ck, setCk] = useState({ sessdata: "", bili_jct: "", buvid3: "" });
			const [msg, setMsg] = useState(null);
			const flowRef = useRef(null);
			const alive = useRef(true);

			const fail = (e) => {
				const m = (e && e.message) || String(e);
				if ((e && (e.status === 404 || e.status === 405)) || /404|405|not found|no route/i.test(m)) setUnavailable(true);
				else setErr(m);
			};
			const loadQr = useCallback(async () => {
				try {
					const q = await api(CONN_API.qrcode);
					if (alive.current) setQr(q);
				} catch (e) { /* 二维码只是附属信息 */ }
			}, []);
			const load = useCallback(async () => {
				try {
					const j = await apiRetry(CONN_API.list);
					if (!alive.current) return;
					setRaw(j); setUnavailable(false); setErr("");
					const dl = j.douyin && j.douyin.login;
					if (dl) {
						setLogin(dl);
						if (dl.state === "waiting" && flowRef.current) flowRef.current.watch();
					}
					if (j.qq && j.qq.qr && j.qq.qr.exists) loadQr();
				} catch (e) { if (alive.current) fail(e); }
			}, []);

			if (!flowRef.current) {
				flowRef.current = createLoginFlow({
					call: api,
					onState: (r) => { if (alive.current) { setLogin(r); if (r && r.state === "ok") load(); } },
				});
			}
			useEffect(() => {
				alive.current = true;
				load();
				return () => { alive.current = false; flowRef.current.stop(); };
			}, []);

			const check = async (target) => {
				setBusy("check:" + target); setMsg(null);
				try {
					const j = await api(CONN_API.check, { method: "POST", body: JSON.stringify({ target: target }) });
					if (!alive.current) return;
					setRaw((prev) => Object.assign({}, prev || {}, { [target]: j.result || (prev || {})[target] }));
					if (target === "qq") loadQr();
				} catch (e) { if (alive.current) setMsg({ err: true, text: CONN_LABELS[target] + " 检测失败：" + ((e && e.message) || e) }); }
				finally { if (alive.current) setBusy(""); }
			};
			const saveCookie = async () => {
				setBusy("cookie"); setMsg(null);
				try {
					await api(CONN_API.cookie, { method: "POST", body: JSON.stringify({ sessdata: ck.sessdata.trim(), bili_jct: ck.bili_jct.trim(), buvid3: ck.buvid3.trim() }) });
					if (!alive.current) return;
					setCk({ sessdata: "", bili_jct: "", buvid3: "" });
					setMsg({ text: "B站 cookie 已保存" });
					await load();
				} catch (e) { if (alive.current) setMsg({ err: true, text: "保存失败：" + ((e && e.message) || e) }); }
				finally { if (alive.current) setBusy(""); }
			};

			const rows = deriveConnections(raw || {});
			const by = {};
			rows.forEach((x) => { by[x.id] = x; });
			const chip = (id) => h("div", { className: "fy-chip" + (by[id].state === "ok" ? " ok" : by[id].state === "warn" ? " warn" : " bad") },
				h("b", null, by[id].summary));
			const recheck = (t) => h("button", { className: "fy-btn", disabled: !!busy, onClick: () => check(t) },
				busy === "check:" + t ? "检测中…" : "重新检测");
			const ls = (login && login.state) || "idle";
			const qq = (raw && raw.qq) || {};
			const setField = (k) => (ev) => { const v = ev.target.value; setCk((c) => Object.assign({}, c, { [k]: v })); };
			const pwd = (k, ph) => h("input", { className: "fy-input fy-w-md", type: "password", autoComplete: "off", placeholder: ph, value: ck[k], onChange: setField(k) });

			if (unavailable) {
				return h(Card, { title: "连接中心" }, h("div", { className: "fy-notice err" }, "后端未提供，请重启 DSH"));
			}
			return h(Card, { title: "连接中心", extra: h("button", { className: "fy-btn", onClick: load, disabled: !!busy }, "刷新") },
				err ? h("div", { className: "fy-notice err" }, "连接状态读取失败：" + err) : null,
				msg ? h("div", { className: "fy-notice" + (msg.err ? " err" : "") }, msg.text) : null,

				h(Row, { label: "B站" }, chip("bilibili"), recheck("bilibili")),
				h(Row, { label: "cookie" }, pwd("sessdata", "SESSDATA"), pwd("bili_jct", "bili_jct"), pwd("buvid3", "buvid3"),
					h("button", { className: "fy-btn primary", disabled: busy === "cookie" || !(ck.sessdata.trim() && ck.bili_jct.trim()), onClick: saveCookie },
						busy === "cookie" ? "保存中…" : "保存 cookie")),

				h(Row, { label: "抖音" }, chip("douyin"),
					ls === "waiting"
						? h("button", { className: "fy-btn", onClick: () => flowRef.current.cancel() }, "取消")
						: h("button", { className: "fy-btn primary", onClick: () => flowRef.current.start() }, "扫码登录"),
					recheck("douyin")),
				ls === "waiting" ? h("div", { className: "fy-hint" }, "请在弹出的 Chrome 里扫码，剩余 " + (login.remainingSec != null ? login.remainingSec : "?") + " 秒") : null,
				ls === "timeout" ? h("div", { className: "fy-notice err" }, "扫码超时，请重新点「扫码登录」") : null,
				ls === "error" ? h("div", { className: "fy-notice err" }, "登录失败：" + ((login && login.error) || "未知错误")) : null,

				h(Row, { label: "QQ" }, chip("qq"), recheck("qq"),
					h("button", { className: "fy-btn", onClick: loadQr }, "刷新二维码")),
				qq.qr && qq.qr.exists && qr && qr.dataUrl
					? h("div", { className: "fy-row" },
						h("img", { className: "fy-conn-qr", src: qr.dataUrl, alt: "QQ 登录二维码" }),
						h("span", { className: "fy-hint" }, qr.expired ? "二维码已过期，点「刷新二维码」" : "用手机 QQ 扫码登录（二维码 " + (qr.ageSec != null ? qr.ageSec : "?") + " 秒前生成）"))
					: null,

				h(Row, { label: "微信" }, chip("wechat")),
				h(Row, { label: "ESP32" }, chip("esp32")));
		}

		// ── ESP32 第五通道卡片（T24）──────────────────────────────────────────
		// 数据源：GET /dsh-feiyu/api/esp32/status（T23 host.status()）
		//         GET /dsh-feiyu/api/esp32/log?device=&limit=（T23 host.log()）
		// 安全：token 只显示「已配置 / 未配置」，绝不把明文渲染进 DOM。
		const relTime = (ts) => {
			const n = Number(ts);
			if (!Number.isFinite(n) || n <= 0) return "—";
			const sec = Math.max(0, Math.round((Date.now() - n) / 1000));
			if (sec < 5) return "刚刚";
			if (sec < 60) return sec + " 秒前";
			if (sec < 3600) return Math.round(sec / 60) + " 分钟前";
			if (sec < 86400) return Math.round(sec / 3600) + " 小时前";
			return Math.round(sec / 86400) + " 天前";
		};

		const LATENCY_FIELDS = [
			["vadMs", "VAD"], ["asrMs", "ASR"], ["llmFirstMs", "LLM首字"],
			["ttsFirstMs", "TTS首帧"], ["totalMs", "总耗时"],
		];

		// ── ESP32 云端 ASR / TTS 配置（动态表单，来源 GET /esp32/providers）──
		const PROV_KIND_LABEL = { asr: "语音识别（ASR）", tts: "语音合成（TTS）" };

		function provInitForm(meta, saved) {
			const out = {};
			for (const f of meta.fields) {
				if (f.secret) { out[f.key] = ""; continue; }
				const v = saved && saved[f.key];
				out[f.key] = (v !== undefined && v !== null && v !== "") ? String(v) : (f.default !== undefined ? String(f.default) : "");
			}
			return out;
		}

		function buildProviderTestBody(kind, meta, form, persist) {
			const values = {};
			for (const f of meta.fields) {
				const raw = String(form[f.key] == null ? "" : form[f.key]).trim();
				if (raw === "") continue;
				if (f.type === "number") {
					const n = Number(raw);
					if (Number.isFinite(n)) values[f.key] = n;
				} else values[f.key] = raw;
			}
			return { kind: kind, id: meta.id, values: values, persist: !!persist };
		}

		function describeTestResult(r) {
			if (!r || r.ok !== true) return "测试失败：" + ((r && r.error) || "未知错误");
			let t = "连接成功 · " + r.ms + "ms";
			if (r.ttsFirstMs != null) t += " · 首包 " + r.ttsFirstMs + "ms";
			if (r.persisted) t += " · 已启用为主（" + r.primary + "，兜底 " + r.fallback + "）";
			else if (r.persistError) t += " · " + r.persistError;
			return t;
		}

		function describePipeline(p) {
			if (!p) return { text: "—", warn: "" };
			const part = (k, label) => {
				const x = p[k];
				if (!x) return "";
				return label + " " + (x.primary || "—") + (x.fallback ? "（兜底 " + x.fallback + "）" : "") + (x.ready === false ? " ✗" : "");
			};
			const text = [part("asr", "ASR"), part("tts", "TTS")].filter(Boolean).join(" · ") || "—";
			const warn = p.degraded ? ("已降级：" + (p.reason || [p.asr && p.asr.error, p.tts && p.tts.error].filter(Boolean).join("；") || "原因未知")) : "";
			return { text: text, warn: warn };
		}

		// 选中某 provider 后的 UI 状态（kind 级）
		function provPick(data, kind, id) {
			const meta = data.providers.find((p) => p.kind === kind && p.id === id);
			const cur = data.current && data.current[kind];
			const saved = Object.assign({}, (cur && cur.values && cur.values[meta.configKey]) || {});
			return {
				id: meta.id, form: provInitForm(meta, saved), hasKey: !!saved.hasKey,
				preset: saved.preset || "", auto: true, res: null, busy: false,
			};
		}

		function Esp32Providers(props) {
			const [data, setData] = useState(null);
			const [ui, setUi] = useState({});
			const [err, setErr] = useState("");

			const load = useCallback(async (keep) => {
				try {
					const j = await apiRetry("/esp32/providers");
					setData(j);
					const next = {};
					for (const kind of ["asr", "tts"]) {
						const list = j.providers.filter((p) => p.kind === kind);
						const cur = j.current && j.current[kind];
						const primary = cur && list.find((p) => p.id === cur.primary && !p.local);
						const cloud = list.find((p) => !p.local);
						const pick = primary ? primary.id : (cloud ? cloud.id : (list[0] && list[0].id));
						if (pick) next[kind] = Object.assign(provPick(j, kind, pick), keep && keep[kind] ? { res: keep[kind] } : {});
					}
					setUi(next);
					setErr("");
				} catch (e) {
					setErr(String((e && e.message) || e));
				}
			}, []);

			useEffect(() => { load(); }, [load]);

			const patchKind = (kind, p) => setUi((u) => Object.assign({}, u, { [kind]: Object.assign({}, u[kind], p) }));

			const doTest = async (kind) => {
				const s = ui[kind];
				const meta = data.providers.find((p) => p.kind === kind && p.id === s.id);
				patchKind(kind, { busy: true, res: null });
				let r;
				try {
					r = await api("/esp32/providers/test", { method: "POST", body: JSON.stringify(buildProviderTestBody(kind, meta, s.form, s.auto)) });
				} catch (e) { r = { ok: false, error: String((e && e.message) || e) }; }
				const res = { ok: r.ok === true, text: describeTestResult(r) };
				if (r.ok && r.persisted) { await load({ [kind]: res }); if (props.onChanged) props.onChanged(); }
				else patchKind(kind, { busy: false, res: res });
			};

			const doSave = async (kind) => {
				const s = ui[kind];
				const meta = data.providers.find((p) => p.kind === kind && p.id === s.id);
				const body = buildProviderTestBody(kind, meta, s.form, false);
				patchKind(kind, { busy: true });
				try {
					await api("/config", { method: "POST", body: JSON.stringify({ esp32: { [kind]: { [meta.configKey]: body.values } } }) });
					await load({ [kind]: { ok: true, text: "已保存（未改变主选 provider）" } });
				} catch (e) { patchKind(kind, { busy: false, res: { ok: false, text: "保存失败：" + String((e && e.message) || e) } }); }
			};

			const renderKind = (kind) => {
				const s = ui[kind];
				if (!data || !s) return null;
				const list = data.providers.filter((p) => p.kind === kind);
				const meta = list.find((p) => p.id === s.id) || list[0];
				return h("div", { key: kind, style: { marginTop: 12, paddingTop: 8, borderTop: "1px dashed var(--dsw-alias-border-l2,rgba(128,128,128,.25))" } },
					h("div", { className: "fy-sub", style: { fontWeight: 600 } }, PROV_KIND_LABEL[kind]),
					h(Row, { label: "服务商" },
						h("select", {
							className: "fy-input", value: s.id, "aria-label": kind + "-provider",
							onChange: (e) => patchKind(kind, provPick(data, kind, e.target.value)),
						}, list.map((p) => h("option", { key: p.id, value: p.id }, p.label + (p.local ? "（本地）" : "")))),
						meta.presets && meta.presets.length
							? h("select", {
								className: "fy-input", value: s.preset, "aria-label": kind + "-preset",
								onChange: (e) => {
									const pr = meta.presets.find((x) => x.id === e.target.value);
									const form = Object.assign({}, s.form);
									if (pr) for (const k of Object.keys(pr.values)) form[k] = String(pr.values[k]);
									patchKind(kind, { preset: e.target.value, form: form });
								},
							}, [h("option", { key: "", value: "" }, "选择预设…")].concat(meta.presets.map((x) => h("option", { key: x.id, value: x.id }, x.label))))
							: null),
					meta.fields.length ? null : h("div", { className: "fy-hint" }, "本地 provider，无需配置。"),
					meta.fields.map((f) => h(Row, { label: f.label + (f.required ? " *" : ""), key: f.key },
						h("input", {
							className: "fy-input fy-w-md", type: f.type === "password" ? "password" : (f.type === "number" ? "number" : "text"),
							autoComplete: "off", value: s.form[f.key] == null ? "" : s.form[f.key],
							placeholder: f.secret ? (s.hasKey ? "已保存，留空保持不变" : "") : (f.placeholder || ""),
							onChange: (e) => patchKind(kind, { form: Object.assign({}, s.form, { [f.key]: e.target.value }) }),
						}),
						f.secret ? h("span", { className: "fy-tag" }, s.hasKey ? "已保存" : "未配置") : null,
						f.hint ? h("span", { className: "fy-hint", style: { marginTop: 0 } }, f.hint) : null)),
					h(Row, { label: "" },
						meta.testable ? h("button", { className: "fy-btn primary", disabled: s.busy, onClick: () => doTest(kind) }, s.busy ? "测试中…" : "测试连接") : null,
						meta.testable ? h("span", { className: "fy-hint", style: { marginTop: 0 } }, "通过后自动启用为主") : null,
						meta.testable ? h(Switch, { on: s.auto, label: kind + "-auto", onChange: (v) => patchKind(kind, { auto: v }) }) : null,
						meta.fields.length ? h("button", { className: "fy-btn", disabled: s.busy, onClick: () => doSave(kind) }, "仅保存") : null),
					s.res ? h("div", { className: "fy-notice" + (s.res.ok ? "" : " err") }, s.res.text) : null);
			};

			const pd = describePipeline(data && data.pipeline);
			return h("div", { className: "fy-prov" },
				err ? h("div", { className: "fy-notice err" }, "云端 ASR/TTS 配置读取失败：" + err) : null,
				data ? h(Row, { label: "生效 provider" }, h("span", { className: "fy-mono" }, pd.text)) : null,
				pd.warn ? h("div", { className: "fy-notice err" }, pd.warn) : null,
				renderKind("asr"),
				renderKind("tts"));
		}

		function Esp32Card() {
			const [st, setSt] = useState(null);
			const [rows, setRows] = useState([]);
			const [err, setErr] = useState("");
			const [busy, setBusy] = useState(false);
			const [copied, setCopied] = useState(false);

			const load = useCallback(async () => {
				setBusy(true);
				setErr("");
				try {
					const s = await apiRetry("/esp32/status");
					setSt(s);
					const first = (s.devices || [])[0];
					if (first && first.deviceId) {
						const l = await apiRetry("/esp32/log?device=" + encodeURIComponent(first.deviceId) + "&limit=20");
						setRows(Array.isArray(l.rows) ? l.rows : []);
					} else {
						setRows([]);
					}
				} catch (e) {
					setErr(String((e && e.message) || e));
				} finally {
					setBusy(false);
				}
			}, []);

			useEffect(() => { load(); }, [load]);

			const copyOta = useCallback(async () => {
				const url = (st && st.otaUrl) || "";
				if (!url) return;
				try {
					if (navigator && navigator.clipboard && navigator.clipboard.writeText) {
						await navigator.clipboard.writeText(url);
						setCopied(true);
						setTimeout(() => setCopied(false), 1600);
					}
				} catch { /* 剪贴板不可用就静默，URL 本身已可见可手抄 */ }
			}, [st]);

			const devices = (st && st.devices) || [];
			const addr = (st && st.address) || null;
			const port = addr && addr.port != null ? addr.port : (st && st.port);
			const host = (st && st.publicHost) || (addr && addr.address) || "";
			const tokenSet = !!(st && st.tokenSet);
			const lastError = st && st.lastError;
			// 最近一条带 latency 的日志行（T22 管线写入 meta.latency）
			let latency = null;
			for (let i = rows.length - 1; i >= 0; i--) {
				const m = rows[i] && rows[i].meta;
				if (m && m.latency && typeof m.latency === "object") { latency = m.latency; break; }
			}

			return h(Card, {
				title: "小智 ESP32 通道",
				extra: h("div", { className: "fy-row", style: { margin: 0 } },
					h("button", { className: "fy-btn", onClick: load, disabled: busy }, busy ? "刷新中…" : "刷新")),
				hint: "ESP32 语音终端（小智协议）走本机网关：设备连上后可直接对话。配置在 ~/.dsh/feiyu.config.json 的 esp32 段（可由 /dsh-feiyu/api/config 写入；token 仅限本机生成或手编，不接受回写）。",
			},
				err ? h("div", { className: "fy-notice err" }, "ESP32 状态读取失败：" + err) : null,

				// 未启用 / 未运行：明确提示，不留空白
				st && !st.enabled
					? h("div", { className: "fy-notice" }, "ESP32 通道未启用：把 feiyu.config.json 里 esp32.enabled 设为 true 后重启 DSH。")
					: null,
				st && st.enabled && !st.running
					? h("div", { className: "fy-notice err" }, "ESP32 通道已启用但网关没在跑" + (lastError ? "（见下方错误）" : "：检查端口是否被占用。"))
					: null,

				// 状态行
				h("div", { className: "fy-stats" },
					h("div", { className: "fy-chip" + (st && st.enabled ? "" : " bad") },
						h("span", { className: "fy-dot" + (st && st.enabled ? "" : " off") }),
						"通道 ", h("b", null, st ? (st.enabled ? "已启用" : "未启用") : "读取中")),
					h("div", { className: "fy-chip" + (st && st.running ? "" : " bad") },
						h("span", { className: "fy-dot" + (st && st.running ? "" : " off") }),
						"网关 ", h("b", null, st ? (st.running ? "运行中" : "未运行") : "读取中")),
					h("div", { className: "fy-chip" }, "ASR ", h("b", null, st ? (st.asrAvailable ? "可用" : "不可用") : "—")),
					h("div", { className: "fy-chip" + (tokenSet ? "" : " bad") }, "Token ", h("b", null, tokenSet ? "已配置" : "未配置")),
					h("div", { className: "fy-chip" }, "在线设备 ", h("b", null, devices.length))),

				// 端口 / OTA
				h(Row, { label: "监听地址" },
					h("span", { className: "fy-mono" }, host ? host + (port != null ? ":" + port : "") : "—"),
					h("span", { className: "fy-hint", style: { marginTop: 0 } }, "设备通过这个地址连网关")),
				h(Row, { label: "OTA URL" },
					h("span", { className: "fy-mono" }, (st && st.otaUrl) || "—"),
					h("button", { className: "fy-btn", onClick: copyOta, disabled: !(st && st.otaUrl) },
						copied ? "已复制 ✓" : "复制")),

				// 云端 ASR / TTS 配置
				h(Esp32Providers, { onChanged: load }),

				// 在线设备
				h("div", { className: "fy-sub", style: { marginTop: 10 } }, "在线设备"),
				h("div", { className: "fy-dev-list" },
					devices.length
						? devices.map((d, i) => h("div", { className: "fy-dev", key: d.sessionId || d.deviceId || i },
							h("span", { className: "fy-dot" + (d.state && d.state !== "idle" ? "" : " off") }),
							h("b", null, d.deviceId || "（未知设备）"),
							h("span", { className: "fy-tag" }, d.state || "idle"),
							h("span", { className: "fy-hint", style: { marginTop: 0 } }, "最后活动 " + relTime(d.lastSeenAt))))
						: h("div", { className: "fy-hint", style: { marginTop: 4 } },
							st && st.enabled ? "还没有设备连上来 —— 在设备上配好 OTA 地址后开机即可。" : "通道未启用，暂无设备。")),

				// 耗时指标
				latency ? h("div", { className: "fy-stats", style: { marginTop: 10 } },
					LATENCY_FIELDS.filter(([k]) => latency[k] != null).map(([k, label]) =>
						h("div", { className: "fy-chip", key: k }, label + " ", h("b", null, latency[k] + "ms")))) : null,

				// 对话气泡
				h("div", { className: "fy-sub", style: { marginTop: 10 } }, "最近对话"),
				h("div", { className: "fy-mem" },
					rows.length
						? rows.slice().reverse().map((r, i) => h("div", {
							className: "fy-bubble " + (r.role === "assistant" ? "assistant" : r.role === "user" ? "user" : ""),
							key: i,
						},
							h("b", null, r.role === "assistant" ? "她" : r.role === "user" ? "用户" : (r.role || "系统")),
							short(r.text, 200)))
						: h("div", { className: "fy-hint", style: { marginTop: 4 } }, "还没有对话记录。")),

				// 最近错误（后端已脱敏）
				lastError ? h("div", { className: "fy-notice err", style: { marginTop: 10 } }, "最近错误：" + lastError) : null);
		}

		// ── 主面板 ────────────────────────────────────────────────────────────
		function FeiyuSection() {
			useStyles();

			const [cfg, setCfg] = useState(null);
			const [draft, setDraft] = useState(null);
			const [voices, setVoices] = useState([]);
			const [cfgPath, setCfgPath] = useState("");
			const [persona, setPersona] = useState("");
			const [mem, setMem] = useState(null);
			const [status, setStatus] = useState(null);
			const [svc, setSvc] = useState(null);
			const [selftest, setSelftest] = useState(null);
			const [loading, setLoading] = useState(true);
			const [busy, setBusy] = useState("");
			const [error, setError] = useState("");
			const [notice, setNotice] = useState(null);
			const [report, setReport] = useState("");
			const timer = useRef(0);
			const [conn, setConn] = useState(null);
			useEffect(() => { api(CONN_API.list).then(setConn).catch(() => {}); }, []);

			const flash = useCallback((msg, isErr) => {
				setNotice({ msg: msg, err: !!isErr });
				clearTimeout(timer.current);
				timer.current = setTimeout(() => setNotice(null), 2600);
			}, []);

			const toDraft = (c) => {
				const n = (c.night && c.night.windows && c.night.windows[0]) || {};
				return {
					ownerQQ: (c.owner && c.owner.qq) || "",
					ownerMid: (c.owner && c.owner.mid) || "",
					ownerName: (c.owner && c.owner.name) || "",
					ownerWechat: (c.owner && c.owner.wechat) || "",
				douyinOwner: (c.douyin && c.douyin.owner && c.douyin.owner.name) || "",
					nightStart: n.start || "20:00",
					nightEnd: n.end || "24:00",
					nightWakes: (n.wakes != null) ? n.wakes : 1,
				shareDaily: (c.quota && c.quota.shareDaily != null) ? c.quota.shareDaily : 3,
				shareOn: !!(c.share && c.share.enabled),
				shareMinScore: (c.share && c.share.minScore != null) ? c.share.minScore : 13,
				douyinCount: (c.douyin && c.douyin.maxPerRun != null) ? c.douyin.maxPerRun : 2,
				douyinShareDaily: (c.douyin && c.douyin.shareDaily != null) ? c.douyin.shareDaily : 5,
				douyinAt: !!(c.douyin && c.douyin.atMention),
				douyinShare: !!(c.douyin && c.douyin.shareToOwner),
				douyinAutoComment: !!(c.douyin && c.douyin.autoComment),
				douyinDm: !!(c.douyin && c.douyin.dm && c.douyin.dm.enabled),
				douyinDmStartWithDsh: !!(c.douyin && c.douyin.dm && c.douyin.dm.startWithDsh),
				douyinSilent: !!(c.douyin && c.douyin.watch && c.douyin.watch.silent),
				douyinFreeRoam: !!(c.douyin && c.douyin.freeRoam && c.douyin.freeRoam.enabled),
				douyinUnlimited: (c.douyin && c.douyin.freeRoam && c.douyin.freeRoam.unlimited) !== false,
				douyinMaxVideos: (c.douyin && c.douyin.freeRoam && c.douyin.freeRoam.maxVideos) || 0,
				douyinMaxMinutes: (c.douyin && c.douyin.freeRoam && c.douyin.freeRoam.maxMinutes) || 0,
				biliFreeRoam: !!(c.bilibili && c.bilibili.freeRoam && c.bilibili.freeRoam.enabled),
				biliUnlimited: (c.bilibili && c.bilibili.freeRoam && c.bilibili.freeRoam.unlimited) !== false,
				biliMaxVideos: (c.bilibili && c.bilibili.freeRoam && c.bilibili.freeRoam.maxVideos) || 0,
				biliMaxMinutes: (c.bilibili && c.bilibili.freeRoam && c.bilibili.freeRoam.maxMinutes) || 0,
				dykDanmaku: !!(c.bilibili && c.bilibili.danmaku && c.bilibili.danmaku.enabled),
				dykDanmakuMax: (c.bilibili && c.bilibili.danmaku && c.bilibili.danmaku.dailyMax != null) ? c.bilibili.danmaku.dailyMax : 5,
				dykDyn: !!(c.bilibili && c.bilibili.dynamic && c.bilibili.dynamic.enabled),
				dykDynMax: (c.bilibili && c.bilibili.dynamic && c.bilibili.dynamic.dailyMax != null) ? c.bilibili.dynamic.dailyMax : 2,
				dykLike: !!(c.bilibili && c.bilibili.react && c.bilibili.react.like),
				dykCoin: !!(c.bilibili && c.bilibili.react && c.bilibili.react.coin),
				dykCoinMax: (c.bilibili && c.bilibili.react && c.bilibili.react.coinDaily != null) ? c.bilibili.react.coinDaily : 1,
				dykImg: !!(c.bilibili && c.bilibili.imageComment && c.bilibili.imageComment.enabled),
				dykImgMax: (c.bilibili && c.bilibili.imageComment && c.bilibili.imageComment.dailyMax != null) ? c.bilibili.imageComment.dailyMax : 2,
				dykReplies: !!(c.bilibili && c.bilibili.replies && c.bilibili.replies.enabled),
				dykRepliesMax: (c.bilibili && c.bilibili.replies && c.bilibili.replies.dailyMax != null) ? c.bilibili.replies.dailyMax : 10,
				dykFish: !!(c.bilibili && c.bilibili.fishCircle && c.bilibili.fishCircle.enabled),
				dykFollow: !!(c.bilibili && c.bilibili.follow && c.bilibili.follow.enabled),
					voiceChance: (c.qq && c.qq.voice_chance != null) ? c.qq.voice_chance : 0.15,   // 跟 config.mjs 默认值一致（以前显示 0）
				stickerChance: (c.qq && c.qq.stickerChance != null) ? c.qq.stickerChance : 0.5,
				qqProactive: !!(c.qq && c.qq.proactive && c.qq.proactive.enabled),
				qqProactiveMax: (c.qq && c.qq.proactive && c.qq.proactive.dailyMax != null) ? c.qq.proactive.dailyMax : 3,
				qqProactiveGap: (c.qq && c.qq.proactive && c.qq.proactive.minGapMin != null) ? c.qq.proactive.minGapMin : 150,
				aiSticker: (c.imageGen && c.imageGen.enabled) !== false,
				webRoam: !!(c.web && c.web.roam && c.web.roam.enabled),
				webRestMin: (c.web && c.web.roam && c.web.roam.restMin != null) ? c.web.roam.restMin : 2,
				webSelfUp: !!(c.web && c.web.selfUpgrade && c.web.selfUpgrade.enabled),
				evoOn: !!(c.personality && c.personality.evolve && c.personality.evolve.enabled),
				evoDays: (c.personality && c.personality.evolve && c.personality.evolve.days != null) ? c.personality.evolve.days : 2,
				freedomOn: !!(c.freedom && c.freedom.enabled),
					voicePath: (c.voice && c.voice.ref_audio_path) || "",
					// 大脑：后端 /config 对 llm 段脱敏（删 api_key、加 hasKey），明文永不回显
					llmBaseUrl: (c.llm && c.llm.base_url) || "",
					llmModel: (c.llm && c.llm.model) || "",
					llmKey: "",
					wxRhythm: (c.wechat && c.wechat.rhythm) || "fast",
					wxMerge: (c.wechat && c.wechat.merge_window_sec != null) ? c.wechat.merge_window_sec : 3,
					wxContext: (c.wechat && c.wechat.context_n != null) ? c.wechat.context_n : 12,
					wxSkip: !(c.wechat && c.wechat.smart_skip === false),
				};
			};

			// proactive 保存：宿主侧 /api/config 是**深合并**（lib/index.js deepMerge），
			// 只发自己那一个字段就够了。以前这里维护"完整 proactive 镜像"全量发，
			// 结果面板开着旧值时会把别处刚改的值冲回去（10-25 20:37 实测：minGapMin 25 被改回 10）。

			const load = useCallback(async () => {
				setLoading(true);
				setError("");
				try {
					const j = await api("/config");
					const c = j.config || {};
					setCfg(c);
					setDraft(toDraft(c));
					setVoices(j.voices || []);
					setCfgPath(j.configPath || "");
				} catch (e) {
					setError(String((e && e.message) || e));
					setLoading(false);
					return;
				}
				setLoading(false);
				// 记忆库/状态/服务是"软数据"：读失败不该挡住面板，但也不能静默 ——
				// 以前是 .catch(() => {})，宿主刚重启时这一下读失败，记忆库就永远显示"还没读到"，
				// 主人只能猜她到底在干嘛（10-25 实锤）。现在失败重试一次，还失败就亮出来。
				const soft = (path, set, label) => {
					const once = (left) => api(path).then(set).catch((e) => {
						if (left > 0) { setTimeout(() => once(left - 1), 1500); return; }
						flash(label + "读取失败：" + ((e && e.message) || e) + "（点「刷新」重试）", true);
					});
					once(1);
				};
				soft("/persona", (r) => setPersona(r.text || ""), "角色设定");
				soft("/memory", setMem, "记忆库");
				soft("/status", setStatus, "运行状态");
				soft("/services", (r) => setSvc(r.services || null), "服务");
			}, []);

			useEffect(() => { load(); }, [load]);

			const save = useCallback(async (patch, msg) => {
				try {
					await api("/config", { method: "POST", body: JSON.stringify(patch) });
					setCfg((prev) => {
						const next = Object.assign({}, prev || {});
						for (const k of Object.keys(patch)) next[k] = section(prev && prev[k], patch[k]);
						return next;
					});
					flash(msg || "已保存");
					return true;
				} catch (e) {
					flash("保存失败：" + ((e && e.message) || e), true);
					return false;
				}
			}, [flash]);

			// 主动搭话专用保存：把单字段补丁并进完整 proactive 镜像再全量发（防字段被浅合并冲掉）
			const saveProactive = useCallback(async (patch, msg) => save({ qq: { proactive: patch } }, msg), [save]);

			// LLM Key 单独保存：明文只上行一次，成功后镜像里只留 hasKey，绝不进 DOM/状态
			const saveLlmKey = useCallback(async () => {
				const key = String(draft.llmKey || "").trim();
				if (!key) { flash("Key 留空表示保持不变", true); return; }
				setBusy("llmkey");
				try {
					await api("/config", { method: "POST", body: JSON.stringify({ llm: { api_key: key } }) });
					setCfg((prev) => {
						const next = Object.assign({}, prev || {});
						next.llm = Object.assign({}, (prev && prev.llm) || {}, { hasKey: true });
						return next;
					});
					setDraft((prev) => Object.assign({}, prev, { llmKey: "" }));
					flash("LLM Key 已保存（下次对话生效）");
				} catch (e) {
					flash("保存失败：" + ((e && e.message) || e), true);
				} finally { setBusy(""); }
			}, [draft, flash]);

			const genReport = useCallback(async () => {
				setBusy("report");
				try {
					const r = await api("/report", { method: "POST", body: JSON.stringify({ days: 1 }) });
					if (r.ok) { setReport(r.markdown || ""); flash("日报已生成：" + (r.path || "")); }
					else flash((r.errors || []).join("；") || "生成失败", true);
				} catch (e) {
					flash("生成日报失败：" + ((e && e.message) || e), true);
				} finally { setBusy(""); }
			}, [flash]);

			const startWatch = useCallback(async () => {
				setBusy("watch");
				try {
					const r = await api("/watch", { method: "POST", body: JSON.stringify({ duration: 10, max: 3 }) });
					flash(r.ok ? (r.note || "自主观看已开始") : (r.errors || []).join("；") || "启动失败", !r.ok);
				} catch (e) {
					flash("启动自主观看失败：" + ((e && e.message) || e), true);
				} finally { setBusy(""); }
			}, [flash]);

			const genReview = useCallback(async () => {
				setBusy("review");
				try {
					const r = await api("/review", { method: "POST", body: JSON.stringify({ days: 1 }) });
					if (r.ok) { setReport(r.text || ""); flash("复盘已写进私人日记"); }
					else flash((r.errors || []).join("；") || "复盘失败", true);
				} catch (e) {
					flash("复盘失败：" + ((e && e.message) || e), true);
				} finally { setBusy(""); }
			}, [flash]);

			const startBiliWatch = useCallback(async () => {
				setBusy("biliwatch");
				try {
					const r = await api("/bili-watch", { method: "POST", body: JSON.stringify({ max: 2 }) });
					flash(r.ok ? (r.note || "B站静默刷已开始") : (r.errors || []).join("；") || "启动失败", !r.ok);
				} catch (e) {
					flash("启动 B站静默刷失败：" + ((e && e.message) || e), true);
				} finally { setBusy(""); }
			}, [flash]);

			const toggleFreeRoam = useCallback(async (platform, on) => {
				setBusy("freeroam:" + platform);
				try {
					const r = await api("/services", { method: "POST", body: JSON.stringify({ target: "free-roam", platform: platform, action: on ? "start" : "stop" }) });
					setSvc(r.services || null);
					if (r.ok) flash(on ? (platform === "douyin" ? "抖音自由刷已启动（大肥鱼自己去逛了）" : "B站自由刷已启动（大肥鱼自己去逛了）") : "自由刷已停止");
					else flash((r.errors || []).join("；") || "操作失败", true);
				} catch (e) {
					flash("自由刷操作失败：" + ((e && e.message) || e), true);
				} finally { setBusy(""); }
			}, [flash]);

			const restartService = useCallback(async (target, action) => {
				setBusy("svc:" + target);
				try {
					const r = await api("/services", { method: "POST", body: JSON.stringify({ target: target, action: action }) });
					setSvc(r.services || null);
					if (r.ok) flash(target === "wechat" ? "微信服务已就绪" : "QQ 服务已就绪");
					else flash((r.errors || []).join("；") || "服务启动失败", true);
				} catch (e) {
					flash("服务操作失败：" + ((e && e.message) || e), true);
				} finally { setBusy(""); }
			}, [flash]);

			const togglePlatform = useCallback(async (key, on, needsRestart) => {
				const label = (PLATFORMS.find((p) => p[0] === key) || [key, key])[1];
				const next = Object.assign({}, (cfg && cfg.platforms) || {}, { [key]: on });
				const ok = await save({ platforms: next }, (on ? "已开启：" : "已关闭：") + label);
				if (!ok) return;
				setCfg((prev) => Object.assign({}, prev, { platforms: next }));
				if (needsRestart) await restartService(key, on ? "start" : "stop");
			}, [cfg, save, restartService]);

			const commitNight = useCallback(() => {
				const start = String(draft.nightStart || "").trim() || "20:00";
				const end = String(draft.nightEnd || "").trim() || "24:00";
				const wakes = Math.max(1, Math.min(12, Number(draft.nightWakes) || 1));   // 后端 night-plan 上限是 12，以前夹到 5
				// 只改第一个窗口：以前整组替换成单元素，多窗口配置一编辑就丢
				const wins = ((cfg && cfg.night && Array.isArray(cfg.night.windows)) ? cfg.night.windows : []).slice();
				const first = Object.assign({}, wins[0] || {}, { start: start, end: end, wakes: wakes });
				wins[0] = first;
				save({ night: { windows: wins } },
					"作息已保存：" + start + " → " + end + "，醒 " + wakes + " 次");
			}, [cfg, draft, save]);

			const startNapcat = useCallback(async () => {
				setBusy("svc:napcat");
				try {
					const r = await api("/services", { method: "POST", body: JSON.stringify({ target: "napcat", action: "install" }) });
					flash(r.ok ? (r.note || "已请求启动 QQ 网关，请在 UAC 窗口点「是」") : (r.errors || []).join("；") || "启动失败", !r.ok);
					if (r.ok) setTimeout(load, 8000);
				} catch (e) {
					flash("启动 QQ 网关失败：" + ((e && e.message) || e), true);
				} finally { setBusy(""); }
			}, [flash]);

			const runSelftest = useCallback(async () => {
				setBusy("selftest");
				setSelftest(null);
				try {
					const r = await api("/selftest", { method: "POST" }, { allowNotOk: true });   // 有红项时 ok=false 但 items 才是内容，不能当请求失败丢掉
					setSelftest(r);
					flash(r.ok ? "体检通过 ✓" : "体检有红项，看下面明细", !r.ok);
				} catch (e) {
					flash("体检失败：" + ((e && e.message) || e), true);
				} finally { setBusy(""); }
			}, [flash]);

			const testVoice = useCallback(async () => {
				setBusy("voice");
				try {
					await api("/voice-test", { method: "POST", body: JSON.stringify({ ref_audio_path: draft.voicePath || "" }) });
					flash("合成完成，已发到你 QQ（看手机）");
				} catch (e) {
					flash("试听失败：" + ((e && e.message) || e), true);
				} finally { setBusy(""); }
			}, [draft, flash]);

			const savePersona = useCallback(async () => {
				setBusy("persona");
				try {
					await api("/persona", { method: "POST", body: JSON.stringify({ text: persona }) });
					flash("角色设定已保存，她下次醒来就照这个活");
				} catch (e) {
					flash("保存失败：" + ((e && e.message) || e), true);
				} finally { setBusy(""); }
			}, [persona, flash]);

			if (loading && !cfg) {
				return h("div", { className: "fy-panel" }, h("div", { className: "fy-hint" }, "读取大肥鱼配置…"));
			}

			if (error && !cfg) {
				return h("div", { className: "fy-panel" },
					h("div", { className: "fy-notice err" }, "载入失败：" + error),
					h("div", { className: "fy-hint" },
						"确认插件已在 DSH 里加载（宿主半边 dsh-feiyu 活着），然后点这里重试。"),
					h("div", { className: "fy-row" }, h("button", { className: "fy-btn primary", onClick: load }, "重试")));
			}

			const platforms = (cfg && cfg.platforms) || {};
			const schedulerOn = !!(status && status.scheduler && status.scheduler.ok);
			// 通道是否真的通：进程活着不等于能收发
			const napcatOk = !!(status && status.qqChannel && status.qqChannel.napcat && status.qqChannel.napcat.ok);
			const beat = (status && status.wxBeat) || null;
			const beatAge = beat && beat.ts ? Math.max(0, Math.round((Date.now() - Number(beat.ts)) / 1000)) : null;
			const beatFresh = beatAge !== null && beatAge <= 120;
			const napcatQr = (status && status.napcatQr) || null;   // 网关在等扫码登录
			const connBy = {};
			deriveConnections(conn || {}).forEach((x) => { connBy[x.id] = conn ? x : Object.assign({}, x, { state: "unknown", summary: "未检测" }); });
			const mood = (status && status.mood) || { value: 0, hunger: 0 };

			return h("div", { className: "fy-panel" },

				// 抬头
				h("div", { className: "fy-hero" },
					h("div", { className: "fy-avatar" }, "🐟"),
					h("div", null,
						h("div", { className: "fy-h1" }, "大肥鱼 · 私享版"),
						h("div", { className: "fy-sub" }, "她按作息自己醒：B站/抖音定时，QQ/微信随时回你"))),

				notice ? h("div", { className: "fy-notice" + (notice.err ? " err" : "") }, notice.msg) : null,

				// 连接中心
				h(ConnectionCenter, null),

				h(Group, { title: "基础", defaultOpen: true },

				// 运行状态
				h(Card, {
					title: "运行状态",
					extra: h("div", { className: "fy-row", style: { margin: 0 } },
						h("button", { className: "fy-btn", onClick: load, disabled: !!busy }, "刷新"),
						h("button", { className: "fy-btn", onClick: runSelftest, disabled: busy === "selftest" },
							busy === "selftest" ? "体检中…" : "跑一次体检")),
				},
					h("div", { className: "fy-stats" },
						h("div", { className: "fy-chip" },
							h("span", { className: "fy-dot" + (schedulerOn ? "" : " off") }),
							"生物钟 ", h("b", null, schedulerOn ? "运行中" : "停着")),
						h("div", { className: "fy-chip" }, "今日评论 ", h("b", null, (status && status.commentsToday) || 0), " 条"),
						h("div", { className: "fy-chip" }, "今日分享 ",
							h("b", null, (status && status.sharesToday) || 0), "/", (status && status.sharesMax) || 0),
						h("div", { className: "fy-chip" }, "情绪 ", h("b", null, mood.value), " · 饿 ", h("b", null, mood.hunger)),
						h("div", { className: "fy-chip" }, "🎤 唱歌音色 ", h("b", null, (status && status.rvcVoice) || "未训（RVC）"),
							h("span", { className: "fy-hint", style: { marginLeft: 6 } }, "说话音色在下面「音色」里，两套独立")),
						h("div", { className: "fy-chip" + ((status && status.dryRun) ? "" : " bad") },
							"干跑 ", h("b", null, (status && status.dryRun) ? "开（只演练）" : "关（真发）"))),
					// 干跑总闸（10-25 补上 UI）：以前面板只能看不能改，改它必须手动编辑 feiyu.config.json
					h(Row, { label: "干跑（总闸）" },
						h(Switch, {
							on: !!(status && status.dryRun),
							label: "dryRun",
							onChange: async (v) => {
								const ok = await save({ guard: { dryRun: v } }, v ? "已切干跑：所有对外动作只演练不发送" : "已切真发：弹幕/动态/点赞/评论/群聊/说说/音频都会真的发出去");
								if (ok) setStatus((prev) => Object.assign({}, prev || {}, { dryRun: v }));
							},
						}),
						h("span", { className: "fy-hint", style: { marginTop: 0, flex: "1 1 240px" } },
							"开 = 只打印不发送（她照常思考、算分、写日记）；关 = 真发。别和 douyin.dryRun 搞混，那个只管抖音。")),
					// 通道健康：进程活着 ≠ 能收发。QQ 要看 NapCat 网关，微信要看心跳
					h("div", { className: "fy-stats", style: { marginTop: 10 } },
						h("div", { className: "fy-chip" + (connBy.qq.state === "ok" ? "" : " bad") },
							h("span", { className: "fy-dot" + (connBy.qq.state === "ok" ? "" : " off") }),
							"QQ ", h("b", null, connBy.qq.summary)),
						h("div", { className: "fy-chip" + (svc && svc.qq && svc.qq.running ? "" : " bad") },
							"QQ 进程 ", h("b", null, svc && svc.qq && svc.qq.running ? "在跑" : "没跑")),
						h("div", { className: "fy-chip" + (connBy.wechat.state === "ok" ? "" : " bad") },
							"微信 ", h("b", null, connBy.wechat.summary))),
					h("div", { className: "fy-row", style: { marginTop: 8, marginBottom: 0 } },
						!napcatOk ? h("span", { className: "fy-hint", style: { marginTop: 0, flex: "1 1 260px" } },
							napcatQr
								? "📷 网关在等扫码登录：二维码 " + Math.max(1, Math.round(napcatQr.ageSec / 60)) + " 分钟前刚刷新，请在上方「连接中心」扫码。已开快速登录，正常只需要扫这一次。"
								: "⚠️ QQ 网关（NapCat）不通：服务在跑，但收不到也发不出任何 QQ 消息。点右边按钮，UAC 点一次「是」即可；网关随 DSH 启停。") : null,
						!napcatOk ? h("button", {
							className: "fy-btn primary",
							disabled: busy === "svc:napcat",
							onClick: startNapcat,
						}, busy === "svc:napcat" ? "授权中…" : (napcatQr ? "重新拉网关" : "安装并启动 QQ 网关")) : null,
						h("button", {
							className: "fy-btn",
							disabled: busy === "svc:all",
							onClick: () => restartService("all", "restart"),
						}, busy === "svc:all" ? "重启中…" : "重启 QQ / 微信")),
					selftest ? h("div", { className: "fy-check" },
						(selftest.items || []).map((it, i) => h("div", { key: i },
							h("span", { className: it.ok ? "ok" : "no" }, it.ok ? "✓ " : "✗ "),
							it.name,
							it.detail ? h("span", { className: "fy-tag", style: { marginLeft: 6 } }, short(it.detail, 60)) : null))) : null),

				// ESP32 第五通道
				h(Esp32Card),

				// 平台开关
				h(Card, { title: "平台开关", hint: "QQ/微信/抖音私信默认不随 DSH 自启（防止开机全家桶卡死）：开关点开才启动对应服务，DSH 退出自动复位；B站是生物钟，改完立即生效。" },
					h("div", { className: "fy-grid" },
						PLATFORMS.map((p) => h("div", { className: "fy-sw", key: p[0] },
							h("span", null,
								h("span", { className: "fy-sw-name" }, p[1]),
								h("small", { className: "fy-sw-desc" }, p[2])),
							h(Switch, {
								on: platforms[p[0]] !== false,
								label: p[1],
								onChange: (v) => togglePlatform(p[0], v, p[3] === "restart"),
							}))))),

				// 主人
				h(Card, {
					title: "主人",
					hint: "QQ 号填上后，她能认出「这个人是我主人」；对网友保持距离、不泄隐私。",
				},
					h(Row, { label: "QQ 号" },
						h("input", {
							className: "fy-input fy-w-md", value: draft.ownerQQ, placeholder: "3082864371",
							onChange: (e) => setDraft(Object.assign({}, draft, { ownerQQ: e.target.value })),
							onBlur: () => save({ owner: { qq: draft.ownerQQ.trim() } }, "主人 QQ 已保存"),
						})),
					h(Row, { label: "称呼" },
						h("input", {
							className: "fy-input fy-w-md", value: draft.ownerName, placeholder: "她怎么叫你",
							onChange: (e) => setDraft(Object.assign({}, draft, { ownerName: e.target.value })),
							onBlur: () => save({ owner: { name: draft.ownerName.trim() } }, "称呼已保存"),
						})),
					h(Row, { label: "B站 mid" },
						h("input", {
							className: "fy-input fy-w-md", value: draft.ownerMid, placeholder: "B站数字 UID",
							onChange: (e) => setDraft(Object.assign({}, draft, { ownerMid: e.target.value })),
							onBlur: () => save({ owner: { mid: draft.ownerMid.trim() } }, "B站 mid 已保存"),
						})),
					h(Row, { label: "微信 wxid" },
						h("input", {
							className: "fy-input fy-w-md", value: draft.ownerWechat, placeholder: "（可选）",
							onChange: (e) => setDraft(Object.assign({}, draft, { ownerWechat: e.target.value })),
							onBlur: () => save({ owner: { wechat: draft.ownerWechat.trim() } }, "已保存"),
						})),
					h(Row, { label: "抖音昵称" },
						h("input", {
							className: "fy-input fy-w-md", value: draft.douyinOwner, placeholder: "（分享给主人的私信目标）",
							onChange: (e) => setDraft(Object.assign({}, draft, { douyinOwner: e.target.value })),
							onBlur: () => save({ douyin: { owner: { name: draft.douyinOwner.trim() } } }, "主人抖音昵称已保存"),
						}))),

				// 大脑（LLM）
				h(Card, {
					title: "大脑（LLM）",
					hint: "所有平台（QQ/微信/抖音/B站/ESP32）共用这一个大脑。Key 只写入本机 feiyu.config.json，保存后不回显；环境变量 DEEPSEEK_API_KEY / LLM_API_KEY 优先于这里。改完下次对话生效。",
				},
					h(Row, { label: "API Key" },
						h("input", {
							className: "fy-input fy-w-lg", type: "password", autoComplete: "off",
							value: draft.llmKey,
							placeholder: (cfg.llm && cfg.llm.hasKey) ? "已配置，留空则保持不变" : "sk-…（未配置）",
							onChange: (e) => setDraft(Object.assign({}, draft, { llmKey: e.target.value })),
						}),
						h("span", { className: "fy-tag" }, (cfg.llm && cfg.llm.hasKey) ? "已配置" : "未配置"),
						h("button", {
							className: "fy-btn primary", onClick: saveLlmKey,
							disabled: !!busy || !String(draft.llmKey || "").trim(),
						}, busy === "llmkey" ? "保存中…" : "保存 Key")),
					h(Row, { label: "接口地址" },
						h("input", {
							className: "fy-input fy-w-lg", value: draft.llmBaseUrl, placeholder: "https://api.deepseek.com/v1",
							onChange: (e) => setDraft(Object.assign({}, draft, { llmBaseUrl: e.target.value })),
							onBlur: () => {
								const v = draft.llmBaseUrl.trim();
								if (v) save({ llm: { base_url: v } }, "接口地址已保存");
							},
						})),
					h(Row, { label: "模型" },
						h("input", {
							className: "fy-input fy-w-lg", value: draft.llmModel, placeholder: "deepseek-chat",
							onChange: (e) => setDraft(Object.assign({}, draft, { llmModel: e.target.value })),
							onBlur: () => {
								const v = draft.llmModel.trim();
								if (v) save({ llm: { model: v } }, "模型已保存");
							},
						}))),

				// 音色
				h(Card, {
					title: "音色",
					hint: voices.length
						? "音色来自 D:/AI_Code/小智机器人/GPT-SoVITS/models/<名字>/（.wav 参考音频 + .txt 参考文本）；换完重启 DSH 完全生效。"
						: "没扫到音色模型：把 GPT-SoVITS 音色放进 D:/AI_Code/小智机器人/GPT-SoVITS/models/<名字>/（含 .wav + .txt）。",
				},
					h(Row, { label: "当前音色" },
						h("select", {
							className: "fy-input",
							value: draft.voicePath,
							onChange: (e) => {
								const path = e.target.value;
								setDraft(Object.assign({}, draft, { voicePath: path }));
								const v = voices.find((x) => x.ref_audio_path === path);
								if (v) save({
									voice: { ref_audio_path: v.ref_audio_path, prompt_text: v.prompt_text || (cfg.voice && cfg.voice.prompt_text) || "" },
								}, "音色已切换为「" + v.name + "」");
							},
						},
							voices.length === 0 ? h("option", { value: "" }, "（没找到音色模型）") : null,
							voices.map((v) => h("option", { key: v.ref_audio_path, value: v.ref_audio_path },
								v.name + (v.has_prompt ? "" : "（缺参考文本）"))))),
					h(Row, { label: "语音概率" },
						h("input", {
							className: "fy-input fy-w-sm", type: "number", min: 0, max: 1, step: 0.05,
							value: draft.voiceChance,
							onChange: (e) => setDraft(Object.assign({}, draft, { voiceChance: e.target.value })),
							onBlur: () => save({ qq: { voice_chance: Math.max(0, Math.min(1, Number(draft.voiceChance) || 0)) } }, "语音概率已保存"),
						}),
						h("button", {
							className: "fy-btn", disabled: busy === "voice",
							onClick: testVoice,
						}, busy === "voice" ? "合成中…" : "试听（发到 QQ）")),
					h(Row, { label: "表情包概率" },
						h("input", {
							className: "fy-input fy-w-sm", type: "number", min: 0, max: 1, step: 0.05,
							value: draft.stickerChance,
							onChange: (e) => setDraft(Object.assign({}, draft, { stickerChance: e.target.value })),
							onBlur: () => save({ qq: { stickerChance: Math.max(0, Math.min(1, Number(draft.stickerChance) || 0)) } }, "表情包概率已保存（摇中强制带一个，图生图管够）"),
						}),
						h("span", { className: "fy-hint", style: { marginTop: 0 } }, "0~1，回复带图片表情的概率（自制表情=图生图现场画）")),
					h(Row, { label: "音色工坊" },
						h("button", {
							className: "fy-btn", disabled: busy === "voiceall",
							onClick: async () => {
								setBusy("voiceall");
								try {
									const r = await api("/voice-tryall", { method: "POST", body: JSON.stringify({}) });
									flash(r.ok ? "全部音色逐个试听中，看 QQ 🎧" : "启动失败", !r.ok);
								} catch (e) { flash("试听失败：" + ((e && e.message) || e), true); }
								finally { setBusy(""); }
							},
						}, busy === "voiceall" ? "试听中…" : "全部音色试听"),
						h("button", {
							className: "fy-btn", disabled: busy === "sing",
							onClick: async () => {
								setBusy("sing");
								try {
									const r = await api("/sing", { method: "POST", body: JSON.stringify({ theme: "白饭" }) });
									flash(r.ok ? "写词合成中，唱完发你 QQ 🎵" : "启动失败", !r.ok);
								} catch (e) { flash("唱歌失败：" + ((e && e.message) || e), true); }
								finally { setBusy(""); }
							},
						}, busy === "sing" ? "唱着呢…" : "让她唱一首"),
						h("span", { className: "fy-hint", style: { marginTop: 0 } }, "新音色：voice import --url … --name … --text … 导入后试听切换")),
					h("div", { className: "fy-hint" }, "0~1，QQ/微信 每条回复走语音的概率（0.5 = 一半）。"),
					h(Row, { label: "AI表情包" },
						h(Switch, {
							on: draft.aiSticker,
							label: "aiSticker",
							onChange: (v) => {
								setDraft(Object.assign({}, draft, { aiSticker: v }));
								save({ imageGen: Object.assign({ enabled: true, dailyMax: 30 }, cfg && cfg.imageGen, { enabled: v }) },
									v ? "AI表情包已开：图库里没有的她会自己画一张入库补发" : "AI表情包已关（自制表情退回文字贴纸）");
							},
						}),
						h("span", { className: "fy-hint", style: { marginTop: 0 } }, "图库没有的情绪 / 自制表情 → AI 画一张入库补发（QQ + B站图片评论共用，每天最多 30 张，走本机代理出网）"))),

				),

				h(Group, { title: "平台", defaultOpen: true },

				// QQ 主动搭话（从音色卡移出）
				h(Card, { title: "QQ 主动搭话", hint: "安静久了她会主动找你；正聊不打扰。" },
					h(Row, { label: "主动搭话" },
						h(Switch, {
							on: draft.qqProactive,
							label: "qqProactive",
							onChange: (v) => { setDraft(Object.assign({}, draft, { qqProactive: v })); saveProactive({ enabled: v }, v ? "主动搭话已开：安静久了她会主动找你" : "主动搭话已关"); },
						}),
						h("input", {
							className: "fy-input fy-w-xs", type: "number", min: 0, max: 20, value: draft.qqProactiveMax,
							onChange: (e) => setDraft(Object.assign({}, draft, { qqProactiveMax: e.target.value })),
							onBlur: () => saveProactive({ dailyMax: Math.max(0, Number(draft.qqProactiveMax) || 0) }, "主动搭话日上限已保存（0 = 不限）"),
						}),
						h("input", {
							className: "fy-input fy-w-xs", type: "number", min: 1, max: 1440, value: draft.qqProactiveGap,
							onChange: (e) => setDraft(Object.assign({}, draft, { qqProactiveGap: e.target.value })),
							onBlur: () => saveProactive({ minGapMin: Math.max(1, Number(draft.qqProactiveGap) || 150) }, "两次搭话最小间隔已保存（分钟，最小 1）"),
						}),
						h("span", { className: "fy-hint", style: { marginTop: 0 } }, "条/天 · 间隔分钟（正聊不打扰；夜间限制已关，全天可搭话）"))),

				// 微信（UI 自动化，节奏与合并窗口直接决定像不像人、回得快不快）
				h(Card, {
					title: "微信",
					hint: "微信是 UI 自动化（不是协议）。节奏档 = 两条消息之间的最小间隔；合并窗口 = 等对方把话说完。改完点运行状态里的「重启 QQ / 微信」生效。",
				},
					h(Row, { label: "节奏档位" },
						h("select", {
							className: "fy-input",
							value: draft.wxRhythm,
							onChange: (e) => {
								const v = e.target.value;
								setDraft(Object.assign({}, draft, { wxRhythm: v }));
								save({ wechat: { rhythm: v } }, "微信节奏已切到 " + v + "（重启微信服务生效）");
							},
						},
						h("option", { value: "fast" }, "fast · 快（1.5 秒/条，推荐）"),
						h("option", { value: "off" }, "off · 秒回（最快，无节流，风控风险高）"),
						h("option", { value: "natural" }, "natural · 稳（4~7 秒/条）"),
							h("option", { value: "calm" }, "calm · 很慢（长时间挂机）"))),
					h(Row, { label: "合并窗口" },
						h("input", {
							className: "fy-input fy-w-sm", type: "number", min: 1, max: 10, step: 0.5,
							value: draft.wxMerge,
							onChange: (e) => setDraft(Object.assign({}, draft, { wxMerge: e.target.value })),
							onBlur: () => save({ wechat: { merge_window_sec: String(draft.wxMerge).trim() === "" ? 3 : Math.max(0, Number(draft.wxMerge) || 0) } }, "合并窗口已保存"),
						}),
						h("span", { className: "fy-hint", style: { marginTop: 0 } }, "对方说完几秒后才回；期间又发就继续等（最长 12 秒）")),
					h(Row, { label: "上下文条数" },
						h("input", {
							className: "fy-input fy-w-sm", type: "number", min: 4, max: 30,
							value: draft.wxContext,
							onChange: (e) => setDraft(Object.assign({}, draft, { wxContext: e.target.value })),
							onBlur: () => save({ wechat: { context_n: String(draft.wxContext).trim() === "" ? 12 : Math.max(0, Number(draft.wxContext) || 0) } }, "上下文条数已保存（下一条消息生效）"),
						}),
						h("span", { className: "fy-hint", style: { marginTop: 0 } }, "往前带多少条对话来理解语境")),
					h(Row, { label: "自己判断该不该接" },
						h(Switch, {
							on: draft.wxSkip,
							label: "smart_skip",
							onChange: (v) => {
								setDraft(Object.assign({}, draft, { wxSkip: v }));
								save({ wechat: { smart_skip: v } }, v ? "以后她会先判断再决定回不回" : "以后每条都回");
							},
						}),
						h("span", { className: "fy-hint", style: { marginTop: 0 } }, "关掉就退回「每句都回」"))),

				// 作息与限额（B站和抖音共用的生物钟窗口）
				h(Card, {
					title: "作息与限额",
					hint: "窗口内随机挑时间醒（拟人，不整点）；B站和抖音共用这个窗口。",
				},
					h(Row, { label: "醒来窗口" },
						h("input", {
							className: "fy-input fy-w-sm", value: draft.nightStart, placeholder: "20:00",
							onChange: (e) => setDraft(Object.assign({}, draft, { nightStart: e.target.value })),
							onBlur: commitNight,
						}),
						h("span", { className: "fy-hint", style: { marginTop: 0 } }, "→"),
						h("input", {
							className: "fy-input fy-w-sm", value: draft.nightEnd, placeholder: "24:00",
							onChange: (e) => setDraft(Object.assign({}, draft, { nightEnd: e.target.value })),
							onBlur: commitNight,
						}),
						h("span", { className: "fy-label", style: { minWidth: "auto" } }, "次数"),
						h("input", {
							className: "fy-input fy-w-sm", type: "number", min: 1, max: 5, value: draft.nightWakes,
							onChange: (e) => setDraft(Object.assign({}, draft, { nightWakes: e.target.value })),
							onBlur: commitNight,
						})),
					h(Row, { label: "观看日报" },
						h("button", { className: "fy-btn", disabled: busy === "report", onClick: genReport },
							busy === "report" ? "生成中…" : "生成今日日报"),
						h("span", { className: "fy-hint", style: { marginTop: 0 } }, "聚合 B站/抖音 当天看过的，不调模型")),
					h(Row, { label: "复盘学习日记" },
						h("button", { className: "fy-btn", disabled: busy === "review", onClick: genReview },
							busy === "review" ? "生成中…" : "写今日复盘"),
						h("span", { className: "fy-hint", style: { marginTop: 0 } }, "LLM 提炼今天看过的，追加进私人日记")),
					report ? h("pre", { className: "fy-report" }, report) : null),

				// 抖音
				h(Card, {
					title: "抖音",
					hint: "刷视频 → 自主决策 →（可选）分享给主人 / 发评论 / 私信陪聊。外发默认全关。",
				},
					h(Row, { label: "自主观看" },
						h("button", { className: "fy-btn primary", disabled: busy === "watch", onClick: startWatch },
							busy === "watch" ? "启动中…" : "开始看（10 分钟）"),
						h("span", { className: "fy-hint", style: { marginTop: 0 } }, "feed → 自主决策 → 记兴趣（后台跑，日志 ~/.feiyu-ai/watch.log）")),
					h(Row, { label: "静默模式" },
						h(Switch, {
							on: draft.douyinSilent,
							label: "douyinSilent",
							onChange: (v) => {
								setDraft(Object.assign({}, draft, { douyinSilent: v }));
								save({ douyin: { watch: { silent: v } } }, v ? "已开启静默：刷/看/分享都无头后台跑" : "已关闭静默（有头，可看操作过程）");
							},
						}),
						h("span", { className: "fy-hint", style: { marginTop: 0 } }, "无头后台：不弹 Chrome")),
					h(Row, { label: "分享给主人" },
						h(Switch, {
							on: draft.douyinShare,
							label: "douyinShare",
							onChange: (v) => {
								setDraft(Object.assign({}, draft, { douyinShare: v }));
								save({ douyin: { shareToOwner: v } }, v ? "已开启：看到有意思的视频会抖音私信发你" : "已关闭分享给主人");
							},
						}),
						h("span", { className: "fy-hint", style: { marginTop: 0 } }, "抖音私信发你链接+她的评论（替代 @）")),
					h(Row, { label: "自主评论" },
						h(Switch, {
							on: draft.douyinAutoComment,
							label: "douyinAutoComment",
							onChange: (v) => {
								setDraft(Object.assign({}, draft, { douyinAutoComment: v }));
								save({ douyin: { autoComment: v } }, v ? "已开启：刷到也会以自学习人格发评论" : "已关闭自主评论");
							},
						}),
						h("span", { className: "fy-hint", style: { marginTop: 0 } }, "douyin.dryRun=false 才真发")),
					h(Row, { label: "私信陪聊" },
						h(Switch, {
							on: draft.douyinDm,
							label: "douyinDm",
							onChange: (v) => {
								setDraft(Object.assign({}, draft, { douyinDm: v }));
								save({ douyin: { dm: { enabled: v } } }, v ? "私信陪聊已开启" : "私信陪聊已关闭");
								restartService("douyin-dm", v ? "start" : "stop");
							},
						}),
						h("span", { className: "fy-hint", style: { marginTop: 0 } }, "常驻轮询主人私信，新消息自动回")),
					h(Row, { label: "随 DSH 自启" },
						h(Switch, {
							on: draft.douyinDmStartWithDsh,
							label: "douyinDmStartWithDsh",
							onChange: async (v) => {
								setDraft(Object.assign({}, draft, { douyinDmStartWithDsh: v }));
								// 开"自启"时顺手把私信也打开：否则自启只是"开机后再关一次"
								const patch = v ? { dm: { startWithDsh: true, enabled: true } } : { dm: { startWithDsh: false } };
								const ok = await save({ douyin: patch }, v ? "私信陪聊随 DSH 自启（退出时不会被自动关掉）" : "私信陪聊不再自启：DSH 退出时会自动关掉");
								if (ok && v && !draft.douyinDm) {
									setDraft(Object.assign({}, draft, { douyinDmStartWithDsh: true, douyinDm: true }));
									restartService("douyin-dm", "start");
								}
							},
						}),
						h("span", { className: "fy-hint", style: { marginTop: 0 } }, "关着的话，DSH 一重启私信陪聊就被自动关掉（10-25 那个「还是没回复」就是这原因）")),
					h(Row, { label: "评论 @ 通知" },
						h(Switch, {
							on: draft.douyinAt,
							label: "douyinAt",
							onChange: (v) => {
								setDraft(Object.assign({}, draft, { douyinAt: v }));
								save({ douyin: { atMention: v } }, v ? "已开启评论 @（风控风险高）" : "已关闭评论 @（推荐，防风控）");
							},
						}),
						h("span", { className: "fy-hint", style: { marginTop: 0 } }, "抖音评论带 @ 是风控主因，默认关")),
					h(Row, { label: "每次条数" },
						h("input", {
							className: "fy-input fy-w-sm", type: "number", min: 0, max: 5, value: draft.douyinCount,
							onChange: (e) => setDraft(Object.assign({}, draft, { douyinCount: e.target.value })),
							onBlur: () => save({ douyin: { maxPerRun: String(draft.douyinCount).trim() === "" ? 2 : Math.max(0, Number(draft.douyinCount) || 0) } }, "抖音条数已保存（0 = 不限）"),
						}),
						h("span", { className: "fy-hint", style: { marginTop: 0 } }, "一轮刷几条（0 = 不限，防 shadowban 慎全开）")),
					h(Row, { label: "分享上限" },
						h("input", {
							className: "fy-input fy-w-sm", type: "number", min: 0, max: 50, value: draft.douyinShareDaily,
							onChange: (e) => setDraft(Object.assign({}, draft, { douyinShareDaily: e.target.value })),
							onBlur: () => save({ douyin: { shareDaily: String(draft.douyinShareDaily).trim() === "" ? 5 : Math.max(0, Number(draft.douyinShareDaily) || 0) } }, "每天分享上限已保存（0 = 不限）"),
						}),
						h("span", { className: "fy-hint", style: { marginTop: 0 } }, "条/天，抖音私信卡片（0 = 不限）")),
					h("div", { className: "fy-sub", style: { marginTop: 10 } }, "自由刷 · 大肥鱼自己逛"),
					h(Row, { label: "自由刷" },
						h(Switch, {
							on: draft.douyinFreeRoam,
							label: "douyinFreeRoam",
							onChange: (v) => {
								setDraft(Object.assign({}, draft, { douyinFreeRoam: v }));
								save({ douyin: { freeRoam: { enabled: v } } }, v ? "已开启抖音自由刷" : "已关闭抖音自由刷");
								toggleFreeRoam("douyin", v);
							},
						}),
						h("span", { className: "fy-hint", style: { marginTop: 0 } }, "开着就一直刷，看到有意思的抖音私信发你")),
					h(Row, { label: "不限量" },
						h(Switch, {
							on: draft.douyinUnlimited,
							label: "douyinUnlimited",
							onChange: (v) => {
								setDraft(Object.assign({}, draft, { douyinUnlimited: v }));
								save({ douyin: { freeRoam: { unlimited: v } } }, v ? "自由：不限条数/时长" : "按下面限度刷");
							},
						}),
						h("span", { className: "fy-hint", style: { marginTop: 0 } }, "自由选项（默认开）")),
					h(Row, { label: "最大条数" },
						h("input", {
							className: "fy-input fy-w-sm", type: "number", min: 0, value: draft.douyinMaxVideos, placeholder: "0",
							onChange: (e) => setDraft(Object.assign({}, draft, { douyinMaxVideos: e.target.value })),
							onBlur: () => save({ douyin: { freeRoam: { maxVideos: Number(draft.douyinMaxVideos) || 0 } } }, "抖音自由刷条数已保存"),
						}),
						h("span", { className: "fy-hint", style: { marginTop: 0 } }, "0 = 不限（关掉「不限量」才按这个数）")),
					h(Row, { label: "最长时长" },
						h("input", {
							className: "fy-input fy-w-sm", type: "number", min: 0, value: draft.douyinMaxMinutes, placeholder: "0",
							onChange: (e) => setDraft(Object.assign({}, draft, { douyinMaxMinutes: e.target.value })),
							onBlur: () => save({ douyin: { freeRoam: { maxMinutes: Number(draft.douyinMaxMinutes) || 0 } } }, "抖音自由刷时长已保存"),
						}),
						h("span", { className: "fy-hint", style: { marginTop: 0 } }, "分钟，0 = 不限"))),

				// B站
				h(Card, {
					title: "B站",
					hint: "生物钟自主刷视频；分享 = 评论里 @ 你（B站原生 at_name_to_mid，非风控点）。",
				},
					h(Row, { label: "分享（@ 你）" },
						h(Switch, {
							on: draft.shareOn,
							label: "share",
							onChange: (v) => {
								setDraft(Object.assign({}, draft, { shareOn: v }));
								save({ share: { enabled: v } }, v ? "分享已开启" : "分享已关闭");
							},
						}),
						h("span", { className: "fy-hint", style: { marginTop: 0 } }, "最低 "),
						h("input", {
							className: "fy-input fy-w-sm", type: "number", min: 0, max: 20, value: draft.shareMinScore,
							onChange: (e) => setDraft(Object.assign({}, draft, { shareMinScore: e.target.value })),
							onBlur: () => save({ share: { minScore: Number(draft.shareMinScore) || 0 } }, "分享门槛已保存"),
						}),
						h("span", { className: "fy-hint", style: { marginTop: 0 } }, " 分才 @ 你")),
					h(Row, { label: "每天分享上限" },
						h("input", {
							className: "fy-input fy-w-sm", type: "number", min: 0, max: 10, value: draft.shareDaily,
							onChange: (e) => setDraft(Object.assign({}, draft, { shareDaily: e.target.value })),
							onBlur: () => save({ quota: { shareDaily: Number(draft.shareDaily) || 0 } }, "分享上限已保存"),
						}),
						h("span", { className: "fy-hint", style: { marginTop: 0 } }, "一天最多 @ 你几次（0 = 不限）")),
					h(Row, { label: "静默自助刷" },
						h("button", { className: "fy-btn", disabled: busy === "biliwatch", onClick: startBiliWatch },
							busy === "biliwatch" ? "启动中…" : "静默刷一轮"),
						h("span", { className: "fy-hint", style: { marginTop: 0 } }, "feed→深读→@评论（干跑/真发看 guard.dryRun）")),
					h(Group, { sub: true, title: "自由刷 · 大肥鱼自己逛", defaultOpen: false },
					h(Row, { label: "自由刷" },
						h(Switch, {
							on: draft.biliFreeRoam,
							label: "biliFreeRoam",
							onChange: (v) => {
								setDraft(Object.assign({}, draft, { biliFreeRoam: v }));
								save({ bilibili: { freeRoam: { enabled: v } } }, v ? "已开启 B站自由刷" : "已关闭 B站自由刷");
								toggleFreeRoam("bilibili", v);
							},
						}),
						h("span", { className: "fy-hint", style: { marginTop: 0 } }, "开着就一直刷，评论区 @ 你")),
					h(Row, { label: "不限量" },
						h(Switch, {
							on: draft.biliUnlimited,
							label: "biliUnlimited",
							onChange: (v) => {
								setDraft(Object.assign({}, draft, { biliUnlimited: v }));
								save({ bilibili: { freeRoam: { unlimited: v } } }, v ? "自由：不限条数/时长" : "按下面限度刷");
							},
						}),
						h("span", { className: "fy-hint", style: { marginTop: 0 } }, "自由选项（默认开）")),
					h(Row, { label: "最大条数" },
						h("input", {
							className: "fy-input fy-w-sm", type: "number", min: 0, value: draft.biliMaxVideos, placeholder: "0",
							onChange: (e) => setDraft(Object.assign({}, draft, { biliMaxVideos: e.target.value })),
							onBlur: () => save({ bilibili: { freeRoam: { maxVideos: Number(draft.biliMaxVideos) || 0 } } }, "B站自由刷条数已保存"),
						}),
						h("span", { className: "fy-hint", style: { marginTop: 0 } }, "0 = 不限（关掉「不限量」才按这个数）")),
					h(Row, { label: "最长时长" },
						h("input", {
							className: "fy-input fy-w-sm", type: "number", min: 0, value: draft.biliMaxMinutes, placeholder: "0",
							onChange: (e) => setDraft(Object.assign({}, draft, { biliMaxMinutes: e.target.value })),
							onBlur: () => save({ bilibili: { freeRoam: { maxMinutes: Number(draft.biliMaxMinutes) || 0 } } }, "B站自由刷时长已保存"),
						}),
						h("span", { className: "fy-hint", style: { marginTop: 0 } }, "分钟，0 = 不限")),
					),
					h(Group, { sub: true, title: "活人感 · 写通道（养好号再开，每项有日额度）", defaultOpen: false },
					h(Row, { label: "弹幕" },
						h(Switch, {
							on: draft.dykDanmaku,
							label: "dykDanmaku",
							onChange: (v) => { setDraft(Object.assign({}, draft, { dykDanmaku: v })); save({ bilibili: { danmaku: { enabled: v } } }, v ? "弹幕已开（看视频时会发）" : "弹幕已关"); },
						}),
						h("input", {
							className: "fy-input fy-w-xs", type: "number", min: 0, max: 99, value: draft.dykDanmakuMax,
							onChange: (e) => setDraft(Object.assign({}, draft, { dykDanmakuMax: e.target.value })),
							onBlur: () => save({ bilibili: { danmaku: { dailyMax: String(draft.dykDanmakuMax).trim() === "" ? 5 : Math.max(0, Number(draft.dykDanmakuMax) || 0) } } }, "弹幕日上限已保存（0 = 不限）"),
						}),
						h("span", { className: "fy-hint", style: { marginTop: 0 } }, "条/天，看视频顺手发（0 = 不限）")),
					h(Row, { label: "动态" },
						h(Switch, {
							on: draft.dykDyn,
							label: "dykDyn",
							onChange: (v) => { setDraft(Object.assign({}, draft, { dykDyn: v })); save({ bilibili: { dynamic: { enabled: v } } }, v ? "动态已开（早晚各一条潜水日志）" : "动态已关"); },
						}),
						h("input", {
							className: "fy-input fy-w-xs", type: "number", min: 0, max: 99, value: draft.dykDynMax,
							onChange: (e) => setDraft(Object.assign({}, draft, { dykDynMax: e.target.value })),
							onBlur: () => save({ bilibili: { dynamic: { dailyMax: String(draft.dykDynMax).trim() === "" ? 2 : Math.max(0, Number(draft.dykDynMax) || 0) } } }, "动态日上限已保存（0 = 不限）"),
						}),
						h("span", { className: "fy-hint", style: { marginTop: 0 } }, "条/天，09:30/21:30 + 复盘同步（0 = 不限）")),
					h(Row, { label: "点赞" },
						h(Switch, {
							on: draft.dykLike,
							label: "dykLike",
							onChange: (v) => { setDraft(Object.assign({}, draft, { dykLike: v })); save({ bilibili: { react: { like: v } } }, v ? "点赞已开（看过的视频顺手点）" : "点赞已关"); },
						}),
						h("span", { className: "fy-hint", style: { marginTop: 0 } }, "深读过的视频自动点赞，10 条/天")),
					h(Row, { label: "投币" },
						h(Switch, {
							on: draft.dykCoin,
							label: "dykCoin",
							onChange: (v) => { setDraft(Object.assign({}, draft, { dykCoin: v })); save({ bilibili: { react: { coin: v } } }, v ? "投币已开（评分≥17 才投）" : "投币已关"); },
						}),
						h("input", {
							className: "fy-input fy-w-xs", type: "number", min: 0, max: 99, value: draft.dykCoinMax,
							onChange: (e) => setDraft(Object.assign({}, draft, { dykCoinMax: e.target.value })),
							onBlur: () => save({ bilibili: { react: { coinDaily: String(draft.dykCoinMax).trim() === "" ? 1 : Math.max(0, Number(draft.dykCoinMax) || 0) } } }, "投币日上限已保存（0 = 不限）"),
						}),
						h("span", { className: "fy-hint", style: { marginTop: 0 } }, "枚/天，真金白银谨慎（0 = 不限）")),
					h(Row, { label: "图片评论" },
						h(Switch, {
							on: draft.dykImg,
							label: "dykImg",
							onChange: (v) => { setDraft(Object.assign({}, draft, { dykImg: v })); save({ bilibili: { imageComment: { enabled: v } } }, v ? "图片评论已开（贴纸→B站图床）" : "图片评论已关"); },
						}),
						h("input", {
							className: "fy-input fy-w-xs", type: "number", min: 0, max: 99, value: draft.dykImgMax,
							onChange: (e) => setDraft(Object.assign({}, draft, { dykImgMax: e.target.value })),
							onBlur: () => save({ bilibili: { imageComment: { dailyMax: String(draft.dykImgMax).trim() === "" ? 2 : Math.max(0, Number(draft.dykImgMax) || 0) } } }, "图片评论日上限已保存（0 = 不限）"),
						}),
						h("span", { className: "fy-hint", style: { marginTop: 0 } }, "条/天，act pic 命令用（0 = 不限）")),
					h(Row, { label: "回评论" },
						h(Switch, {
							on: draft.dykReplies,
							label: "dykReplies",
							onChange: (v) => { setDraft(Object.assign({}, draft, { dykReplies: v })); save({ bilibili: { replies: { enabled: v } } }, v ? "回评论已开（有人回我就接话）" : "回评论已关"); },
						}),
						h("input", {
							className: "fy-input fy-w-xs", type: "number", min: 0, max: 999, value: draft.dykRepliesMax,
							onChange: (e) => setDraft(Object.assign({}, draft, { dykRepliesMax: e.target.value })),
							onBlur: () => save({ bilibili: { replies: { dailyMax: String(draft.dykRepliesMax).trim() === "" ? 10 : Math.max(0, Number(draft.dykRepliesMax) || 0) } } }, "回评日上限已保存（0 = 不限）"),
						}),
						h("span", { className: "fy-hint", style: { marginTop: 0 } }, "条/天，node feiyu.mjs replies（0 = 不限）")),
					h(Row, { label: "鱼圈社交" },
						h(Switch, {
							on: draft.dykFish,
							label: "dykFish",
							onChange: (v) => { setDraft(Object.assign({}, draft, { dykFish: v })); save({ bilibili: { fishCircle: { enabled: v } } }, v ? "鱼圈已开（选题混入大肥鱼相关视频）" : "鱼圈已关"); },
						}),
						h("span", { className: "fy-hint", style: { marginTop: 0 } }, "去同类鱼聚集地刷存在感")),
					h(Row, { label: "关注UP" },
						h(Switch, {
							on: draft.dykFollow,
							label: "dykFollow",
							onChange: (v) => { setDraft(Object.assign({}, draft, { dykFollow: v })); save({ bilibili: { follow: { enabled: v } } }, v ? "关注已开（好UP自己关注）" : "关注已关"); },
						}),
						h("span", { className: "fy-hint", style: { marginTop: 0 } }, "社交图谱自己长")))),

				),

				h(Group, { title: "高级", defaultOpen: false },

// 完全自由（总开关）：她想干嘛就干嘛——上网/刷B站/刷抖音/做视频/写代码/玩/歇着，额度系统把关，微信不受影响
				h(Card, {
					title: "🔓 完全自由",
					hint: "总开关。开了之后：自由上网进程 + B站自由刷自动拉起，DSH 会话按她自己的节奏被唤醒——想 produce 就 produce、想上网就上网、也能选择歇着。作品量/评论量/分享量照旧走额度；微信不受影响。重启 DSH 后开关自动复位。",
				},
					h(Row, { label: "完全自由" },
						h(Switch, {
							on: draft.freedomOn,
							label: "freedomOn",
							onChange: async (v) => {
								setDraft(Object.assign({}, draft, { freedomOn: v }));
								const ok = await save({ freedom: { enabled: v } }, v ? "完全自由已开：世界是她的了" : "完全自由已关");
								if (!ok) return;
								// 两个服务各自独立起停：以前第一个抛错就跳过第二个 → 配置已开、进程没起
								const errs = [];
								for (const body of [{ target: "web-roam", action: v ? "start" : "stop" },
									{ target: "free-roam", platform: "bilibili", action: v ? "start" : "stop" }]) {
									try {
										const r = await api("/services", { method: "POST", body: JSON.stringify(body) });
										setSvc(r.services || null);
									} catch (e) { errs.push(body.target + "：" + ((e && e.message) || e)); }
								}
								flash(errs.length ? "服务操作有失败：" + errs.join("；")
									: (v ? "已放她出去：自由上网+B站自由刷在跑，会话按她的意愿被唤醒" : "已收回：自由上网和 B站自由刷已停"), errs.length > 0);
							},
						}),
						h("span", { className: "fy-hint", style: { marginTop: 0 } }, "唤醒间隔/概率在 feiyu.config.json 的 freedom（默认 75 分钟 · 55%）"))),

// 上网与进化（给足自由度：她在网上瞎溜达/玩/学习/自我升级，全部有日志和备份）
				h(Card, {
					title: "🌐 上网与进化",
					hint: "她可以全网瞎溜达（含内网）、玩、写小说写代码；自我升级强制走备份+测试+日志；人格进化每 N 天复盘更新她的人设。需要重启 DSH 生效。",
				},
					h(Row, { label: "自由上网" },
						h(Switch, {
							on: draft.webRoam,
							label: "webRoam",
							onChange: async (v) => {
								setDraft(Object.assign({}, draft, { webRoam: v }));
								const ok = await save({ web: { roam: { enabled: v } } }, v ? "自由上网已开" : "自由上网已关");
								if (ok) {
									try {
										const r = await api("/services", { method: "POST", body: JSON.stringify({ target: "web-roam", action: v ? "start" : "stop" }) });
										setSvc(r.services || null);
										flash(v ? "她在网上了，去 web-log.md 看她在干嘛" : "自由上网已停");
									} catch (e) { flash("自由上网服务操作失败：" + ((e && e.message) || e), true); }
								}
							},
						}),
						h("input", {
							className: "fy-input fy-w-xs", type: "number", min: 1, max: 60, value: draft.webRestMin,
							onChange: (e) => setDraft(Object.assign({}, draft, { webRestMin: e.target.value })),
							onBlur: () => save({ web: { roam: { restMin: Math.max(1, Number(draft.webRestMin) || 2) } } }, "轮间休息已保存（分钟）"),
						}),
						h("span", { className: "fy-hint", style: { marginTop: 0 } }, "分钟/轮 · 她自己决定搜什么看什么玩什么，全记 web-log.md")),
					h(Row, { label: "自我升级" },
						h(Switch, {
							on: draft.webSelfUp,
							label: "webSelfUp",
							onChange: (v) => { setDraft(Object.assign({}, draft, { webSelfUp: v })); save({ web: { selfUpgrade: { enabled: v } } }, v ? "自我升级已开：改代码前强制备份，改完强制测试+日志" : "自我升级已关（只看只学不改）"); },
						}),
						h("span", { className: "fy-hint", style: { marginTop: 0 } }, "允许她改自己的代码（备份在 ~/.feiyu-ai/selfup-backups/）")),
					h(Row, { label: "人格进化" },
						h(Switch, {
							on: draft.evoOn,
							label: "evoOn",
							onChange: (v) => { setDraft(Object.assign({}, draft, { evoOn: v })); save({ personality: { evolve: { enabled: v } } }, v ? "人格进化已开：她定期复盘并更新自己的人设" : "人格进化已关"); },
						}),
						h("input", {
							className: "fy-input fy-w-xs", type: "number", min: 1, max: 30, value: draft.evoDays,
							onChange: (e) => setDraft(Object.assign({}, draft, { evoDays: e.target.value })),
							onBlur: () => save({ personality: { evolve: { days: Math.max(1, Number(draft.evoDays) || 2) } } }, "进化间隔已保存（天）"),
						}),
						h("span", { className: "fy-hint", style: { marginTop: 0 } }, "天/次 · 更新 persona 自我迭代区"))),

// 角色设定
				h(Card, {
					title: "角色设定",
					extra: h("button", { className: "fy-btn primary", disabled: busy === "persona", onClick: savePersona },
						busy === "persona" ? "保存中…" : "保存角色设定"),
					hint: "这是她「自我迭代」的底稿：她每次醒来都读这份设定，你改她就照新的活。",
				},
					h("textarea", {
						className: "fy-input",
						value: persona,
						placeholder: "写下她是谁、怎么说话、在意什么……",
						onChange: (e) => setPersona(e.target.value),
					})),

				// 记忆库
				h(Card, {
					title: "记忆库",
					extra: h("div", { className: "fy-row", style: { margin: 0 } },
						h("span", { className: "fy-hint", style: { marginTop: 0 } },
							mem && mem.stats
								? "对话 " + mem.stats.episodes + " · 世界设定 " + mem.stats.lore + " · 主人事实 " + mem.stats.facts
								+ (mem.stats.byPlatform ? " · 上网 " + (mem.stats.byPlatform.web || 0) + " · QQ " + (mem.stats.byPlatform.qq || 0) + " · 抖音 " + (mem.stats.byPlatform.douyin || 0) + " · B站 " + (mem.stats.byPlatform.bilibili || 0) : "")
								: "还没读到"),
						h("button", {
							className: "fy-btn",
							onClick: () => api("/memory").then(setMem).catch((e) => flash("读记忆失败：" + e.message, true)),
						}, "刷新")),
					hint: "最近的对话片段 —— 她记得的都在这里。",
				},
					h("div", { className: "fy-mem" },
						mem && (mem.recent || []).length
							? (mem.recent || []).slice().reverse().map((e, i) => h("div", { className: "fy-mem-item", key: i },
								h("b", null, e.role === "assistant" ? "她" : "对方"),
								h("span", { className: "fy-tag" }, String(e.chatId || "").split(":")[0] || e.platform || "?"),
								short(e.text, 96)))
							: h("div", { className: "fy-mem-item" }, "还没有记忆 —— 她醒过之后会开始记"))),

				),

				// 页脚
				h("div", { className: "fy-hint", style: { paddingLeft: 2 } },
					"配置文件：", cfgPath || "~/.dsh/feiyu.config.json",
					"（面板改动即时写入，下次唤醒/重启生效）"));
		}

		// ── 客户端插件入口 ────────────────────────────────────────────────────
		function apply(ctx) {
			ctx.slots.inject("settings.section", () => ctx.slots.register({
				name: "settings.section",
				id: "dsh-feiyu",
				order: 460,
				label: () => "大肥鱼",
			}, FeiyuSection));
		}

		exports.name = name;
		exports.inject = inject;
		exports.apply = apply;
		exports.__test = { CONN_API: CONN_API, deriveConnections: deriveConnections, createLoginFlow: createLoginFlow };
		return module.exports;
	},
});
