window.__ModuleLoader__.load({
	id: "@tencent-connect/dsh-qqbot",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		let react = require("react");
		//#region src/shared/bind-protocol.ts
		/**
		* 端内绑定协议 —— 宿主路由与客户端面板的共享契约
		*
		* 类型与路径常量的唯一事实源：宿主（setup/bind-routes.ts）与浏览器
		* （client/bind-page.ts）各自 import，杜绝两端协议漂移。
		* 本模块必须保持纯类型 + 纯常量（零 node 依赖、零副作用）：
		* 客户端 tsdown 构建会将其内联进 bundle。
		*/
		/** 状态查询（绑定页轮询） */
		const BIND_STATE_PATH = "/qqbot/im-qqbot/bind";
		/** 刷新二维码（绑定页按钮） */
		const BIND_REFRESH_PATH = "/qqbot/im-qqbot/bind/refresh";
		/** 手动填写/编辑凭据（绑定页表单） */
		const BIND_MANUAL_PATH = "/qqbot/im-qqbot/bind/manual";
		/** 解绑：移除已保存凭据，回到绑定流程 */
		const BIND_UNBIND_PATH = "/qqbot/im-qqbot/bind/unbind";
		/** 配置读写（设置面板表单） */
		const BIND_CONFIG_PATH = "/qqbot/im-qqbot/config";
		/** 消息存储：统计 / 预览 / 清理 */
		const MESSAGES_STATS_PATH = "/qqbot/im-qqbot/messages/stats";
		const MESSAGES_RECENT_PATH = "/qqbot/im-qqbot/messages/recent";
		const MESSAGES_CLEAR_PATH = "/qqbot/im-qqbot/messages/clear";
		const MESSAGES_SENDERS_PATH = "/qqbot/im-qqbot/messages/senders";
		const SLEEP_STATUS_PATH = "/qqbot/im-qqbot/sleep/status";
		//#endregion
		//#region src/client/bind-page.ts
		/**
		* 端内绑定面板 — 扫码 / 手动填写 / 已绑定编辑
		*
		* 宿主插件注册 /qqbot/im-qqbot/bind 路由（待绑定与已绑定 fiber 均常驻）：
		* - 未绑定：waiting（二维码）/ starting / saving / failed 相位 + manual 提交
		* - 已绑定：bound 相位（回显脱敏 appId，secret 不回传）+ manual 更换 + 解绑
		* 扫码成功或手动保存均写入 profile patch 并经 HMR 重载生效。
		*
		* 样式为注入式 CSS 类（imqb-* 命名空间，随面板挂载注入一次）：
		* hover/过渡/focus 样式无法用 inline style 表达，统一走类；
		* 颜色尽量取 DSW 主题变量（--dsw-alias-*），缺省值兜底。
		*
		* 同一组件复用于两种展示位（侧栏绑定页 / 设置页 QQ Bot 栏目）。
		* 运行时仅依赖 react（dsh 客户端平台种子表提供）；宿主通信走同源 fetch，
		* Desktop 下由壳的 IPC 桥自动附加 Host 认证转发。
		*/
		/** 轮询间隔（毫秒）：活跃轮询 / 失败退避 */
		const ACTIVE_POLL_MS = 2e3;
		const RETRY_POLL_MS = 3e3;
		/** 样式注入标记（幂等） */
		const STYLE_ID$1 = "im-qqbot-bind-panel-styles";
		/**
		* 注入面板样式（一次）。交互态（hover/active/focus）无法用 inline style
		* 表达，统一收敛到类；DSW 主题变量缺失时用中性值兜底。
		*/
		function usePanelStyles() {
			(0, react.useEffect)(() => {
				if (typeof document === "undefined") return;
				if (document.getElementById(STYLE_ID$1) !== null) return;
				const style = document.createElement("style");
				style.id = STYLE_ID$1;
				style.textContent = `
.imqb-panel {
  display: flex; flex-direction: column; align-items: center; justify-content: center;
  gap: 14px; padding: 24px; min-height: 320px; text-align: center; font-size: 14px;
}
.imqb-title { margin: 0; font-size: 16px; font-weight: 600; }
.imqb-hint { margin: 0; opacity: 0.75; line-height: 1.6; }
.imqb-mono { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 13px; }
.imqb-link { font-size: 13px; opacity: 0.85; color: var(--dsw-alias-brand, #4d6bfe); text-decoration: none; }
.imqb-link:hover { text-decoration: underline; }
.imqb-icon { font-size: 32px; line-height: 1; }
.imqb-qr { border-radius: 10px; background: #fff; padding: 10px; max-width: 100%; }
.imqb-row { display: flex; gap: 10px; justify-content: center; flex-wrap: wrap; }
.imqb-btn, .imqb-pill {
  font: inherit; cursor: pointer; color: inherit;
  transition: background-color .15s ease, border-color .15s ease, color .15s ease, opacity .15s ease;
}
.imqb-btn:disabled, .imqb-pill:disabled { opacity: 0.5; cursor: default; }
.imqb-btn {
  padding: 7px 18px; border-radius: 8px; font-size: 13px;
  border: 1px solid var(--dsw-alias-border-l2, rgba(128, 128, 128, 0.4));
  background: transparent;
}
.imqb-btn:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover, rgba(128, 128, 128, 0.12)); }
.imqb-btn--primary {
  border-color: transparent;
  background: var(--dsw-alias-brand, #4d6bfe); color: #fff; font-weight: 500;
}
.imqb-btn--primary:hover:not(:disabled) { background: var(--dsw-alias-brand-strong, #3b5cf0); }
.imqb-btn--danger { color: var(--dsw-alias-danger, #f26d6d); border-color: var(--dsw-alias-danger, rgba(242, 109, 109, 0.5)); }
.imqb-btn--danger:hover:not(:disabled) { background: var(--dsw-alias-danger, rgba(242, 109, 109, 0.12)); }
.imqb-ghost {
  border: none; background: transparent; opacity: 0.65; padding: 4px 8px;
  font: inherit; font-size: 13px; cursor: pointer; color: inherit;
}
.imqb-ghost:hover { opacity: 1; text-decoration: underline; }
.imqb-pill {
  padding: 5px 16px; border-radius: 999px; font-size: 13px;
  border: 1px solid var(--dsw-alias-border-l2, rgba(128, 128, 128, 0.4)); background: transparent;
}
.imqb-pill:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover, rgba(128, 128, 128, 0.12)); }
.imqb-btn:focus-visible, .imqb-pill:focus-visible, .imqb-input:focus-visible, .imqb-ghost:focus-visible {
  outline: 2px solid var(--dsw-alias-brand, #4d6bfe); outline-offset: 1px;
}
.imqb-form { display: flex; flex-direction: column; gap: 12px; width: min(320px, 100%); box-sizing: border-box; }
.imqb-field { display: flex; flex-direction: column; gap: 5px; text-align: left; font-size: 13px; }
.imqb-input {
  padding: 8px 10px; border-radius: 8px; box-sizing: border-box; width: 100%;
  border: 1px solid var(--dsw-alias-border-l2, rgba(128, 128, 128, 0.4));
  background: var(--dsw-alias-bg-input, rgba(128, 128, 128, 0.08));
  color: inherit; font: inherit; font-size: 13px; outline: none;
}
.imqb-input:focus { border-color: var(--dsw-alias-brand, #4d6bfe); }
.imqb-error { margin: 0; font-size: 12px; color: var(--dsw-alias-danger, #f26d6d); }
/* 紧凑状态视图（已绑定 / 过渡态）：设置行风格，无居中大卡留白 */
.imqb-status { display: flex; flex-direction: column; text-align: left; font-size: 14px; }
.imqb-status-row { display: flex; align-items: center; gap: 12px; padding: 12px 0; }
.imqb-status-icon { font-size: 24px; line-height: 1; flex: none; }
.imqb-qqicon {
  flex: none; display: block; border-radius: 8px;
  background: #fff; /* 深色企鹅 logo 需浅底，暗色主题下保持可见 */
}
.imqb-status-meta { display: flex; flex-direction: column; gap: 2px; min-width: 0; flex: 1; }
.imqb-status-title { margin: 0; font-size: 14px; font-weight: 600; line-height: 1.5; }
.imqb-status-sub { margin: 0; font-size: 12px; line-height: 1.5; color: var(--dsw-alias-label-tertiary, inherit); opacity: .85; }
.imqb-status-actions { display: flex; align-items: center; gap: 8px; padding: 4px 0 12px; }
/* 扫码成功后的连接过渡：二维码模糊变暗 + 覆盖层 */
.imqb-scanned { position: relative; display: inline-block; }
.imqb-scanned-qr {
  display: block; border-radius: 10px; background: #fff; padding: 10px;
  filter: blur(6px) saturate(0.6); opacity: 0.55;
}
.imqb-scanned-veil {
  position: absolute; inset: 0; display: flex; flex-direction: column;
  align-items: center; justify-content: center; gap: 6px; text-align: center;
}
.imqb-scanned-title { margin: 0; font-size: 15px; font-weight: 600; }
.imqb-scanned-sub { margin: 0; font-size: 12px; opacity: 0.75; line-height: 1.6; }
    `;
				document.head.appendChild(style);
				return () => {
					style.remove();
				};
			}, []);
		}
		/**
		* 绑定状态轮询 hook。
		*
		* 404 语义分两种：从未拿到过路由 = 插件未启用（终态）；
		* 曾经拿到过 = HMR 重载窗口期（manual/unbind 保存后路由短暂消失），
		* 低频等待恢复而不是判定终态——否则保存成功提示会被
		* 「插件未启用」覆盖且无法自愈。
		*
		* bound 为稳定态：轮询大幅降频（30s）。因此解绑等本地动作后必须
		* 调用 recheck() 立即重置节拍——否则视图最长停留 30s+ 才收敛到
		* 新相位（如解绑后的 waiting 二维码）。
		*
		* @returns 轮询快照与 recheck：state 为宿主相位（null = 加载中），
		*          gone 表示插件未启用（从未注册过路由），recheck 废弃当前
		*          定时器并立即重新轮询（新轮询链取代旧链，不产生双计时器）。
		*/
		function useBindState() {
			const [state, setState] = (0, react.useState)(null);
			const [gone, setGone] = (0, react.useState)(false);
			const recheckRef = (0, react.useRef)(() => {});
			(0, react.useEffect)(() => {
				let stopped = false;
				let sawRoute = false;
				let generation = 0;
				let running = false;
				let restartAfterFlight = false;
				let urgentUntil = 0;
				let timer;
				const schedule = (ms) => {
					timer = setTimeout(() => {
						tick();
					}, ms);
				};
				const intervalFor = (phase) => {
					const base = phase === "saving" ? 500 : phase === "bound" ? 3e4 : ACTIVE_POLL_MS;
					return Date.now() < urgentUntil ? Math.min(base, ACTIVE_POLL_MS) : base;
				};
				const tick = async () => {
					if (stopped || running) return;
					running = true;
					const myGeneration = generation;
					const alive = () => myGeneration === generation && !stopped;
					try {
						const res = await fetch(BIND_STATE_PATH, { cache: "no-store" });
						if (res.status === 404) {
							if (!stopped && !sawRoute) setGone(true);
							else if (alive()) schedule(Date.now() < urgentUntil ? 1e3 : 3e3);
							return;
						}
						if (!res.ok) {
							if (alive()) schedule(RETRY_POLL_MS);
							return;
						}
						sawRoute = true;
						const body = await res.json();
						if (!alive()) return;
						setState(body);
						schedule(intervalFor(body.phase));
						return;
					} catch {} finally {
						running = false;
						if (restartAfterFlight && !stopped) {
							restartAfterFlight = false;
							tick();
						}
					}
					if (alive()) schedule(RETRY_POLL_MS);
				};
				recheckRef.current = () => {
					generation += 1;
					urgentUntil = Date.now() + 15e3;
					if (timer !== void 0) clearTimeout(timer);
					if (running) {
						restartAfterFlight = true;
						return;
					}
					tick();
				};
				tick();
				return () => {
					stopped = true;
					if (timer !== void 0) clearTimeout(timer);
				};
			}, []);
			return {
				state,
				gone,
				recheck: (0, react.useCallback)(() => {
					recheckRef.current();
				}, [])
			};
		}
		/** 手动提交凭据（填写 / 更换共用） */
		async function submitManualCredentials(appId, appSecret) {
			try {
				const res = await fetch(BIND_MANUAL_PATH, {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({
						appId,
						appSecret
					})
				});
				const body = await res.json().catch(() => ({}));
				if (res.ok && body.ok) return {
					ok: true,
					message: body.message
				};
				return {
					ok: false,
					error: body.error ?? `保存失败（HTTP ${res.status}）`
				};
			} catch (err) {
				return {
					ok: false,
					error: err instanceof Error ? err.message : String(err)
				};
			}
		}
		/**
		* 手动凭据表单（填写 / 更换共用）。
		*
		* appSecret 永不回显（占位符提示），提交成功后展示保存结果；
		* 宿主写入 profile patch 并经 HMR 重载，状态轮询随后收敛为 bound。
		*/
		function ManualForm({ initialAppId }) {
			const [appId, setAppId] = (0, react.useState)(initialAppId ?? "");
			const [appSecret, setAppSecret] = (0, react.useState)("");
			const [busy, setBusy] = (0, react.useState)(false);
			const [result, setResult] = (0, react.useState)(null);
			const submit = (0, react.useCallback)((event) => {
				event.preventDefault();
				if (busy) return;
				const trimmedId = appId.trim();
				const trimmedSecret = appSecret.trim();
				if (trimmedId.length === 0 || trimmedSecret.length === 0) {
					setResult({
						ok: false,
						error: "appId 与 appSecret 均为必填"
					});
					return;
				}
				setBusy(true);
				submitManualCredentials(trimmedId, trimmedSecret).then((outcome) => {
					setResult(outcome);
					setBusy(false);
				});
			}, [
				appId,
				appSecret,
				busy
			]);
			if (result !== null && result.ok) return (0, react.createElement)("div", { className: "imqb-status" }, (0, react.createElement)("div", { className: "imqb-status-row" }, (0, react.createElement)("div", { className: "imqb-status-icon" }, "✅"), (0, react.createElement)("div", { className: "imqb-status-meta" }, (0, react.createElement)("p", { className: "imqb-status-title" }, result.message ?? "凭据已保存"), (0, react.createElement)("p", { className: "imqb-status-sub" }, "插件将自动重载；稍后即可开始对话"))));
			return (0, react.createElement)("form", {
				className: "imqb-form",
				onSubmit: submit
			}, (0, react.createElement)("label", { className: "imqb-field" }, "AppID", (0, react.createElement)("input", {
				className: "imqb-input",
				value: appId,
				placeholder: "QQ 机器人 AppID",
				onChange: (event) => {
					setAppId(event.currentTarget.value);
				},
				autoComplete: "off",
				spellCheck: false
			})), (0, react.createElement)("label", { className: "imqb-field" }, "AppSecret", (0, react.createElement)("input", {
				className: "imqb-input",
				type: "password",
				value: appSecret,
				placeholder: initialAppId === void 0 ? "QQ 机器人 AppSecret" : "输入新的 AppSecret（不回显）",
				onChange: (event) => {
					setAppSecret(event.currentTarget.value);
				},
				autoComplete: "new-password"
			})), result !== null && !result.ok ? (0, react.createElement)("p", { className: "imqb-error" }, result.error) : null, (0, react.createElement)("button", {
				className: "imqb-btn imqb-btn--primary",
				type: "submit",
				disabled: busy
			}, busy ? "正在保存…" : "保存"));
		}
		/** QQ 企鹅 logo（256×256 PNG data URI；深色图案配白底圆角，明暗主题下均可见） */
		const QQ_BOT_ICON_PNG = "data:image/png;base64,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";
		/** QQ 机器人图标（logo 图片，白底圆角容器内呈现） */
		function QqBotIcon({ size = 28 }) {
			return (0, react.createElement)("img", {
				src: QQ_BOT_ICON_PNG,
				alt: "QQ",
				width: size,
				height: size,
				className: "imqb-qqicon"
			});
		}
		/** 已绑定视图：回显 appId + 更换凭据 / 解绑入口 */
		function BoundView({ appId, recheck }) {
			const [editing, setEditing] = (0, react.useState)(false);
			const [unbindResult, setUnbindResult] = (0, react.useState)(null);
			const unbind = (0, react.useCallback)(() => {
				if (!window.confirm("确定解绑吗？\n解绑后机器人立即下线，插件将重新进入扫码绑定流程。")) return;
				fetch(BIND_UNBIND_PATH, { method: "POST" }).then(async (res) => {
					const body = await res.json().catch(() => ({}));
					if (res.ok && body.ok === true) {
						setUnbindResult({
							ok: true,
							message: body.message ?? "已解绑，插件将重载并重新进入绑定流程"
						});
						recheck();
						return;
					}
					setUnbindResult({
						ok: false,
						message: body.error ?? `解绑失败（HTTP ${res.status}）`
					});
				}).catch((err) => {
					setUnbindResult({
						ok: false,
						message: err instanceof Error ? err.message : String(err)
					});
				});
			}, [recheck]);
			if (unbindResult !== null) return (0, react.createElement)("div", { className: "imqb-status" }, (0, react.createElement)("div", { className: "imqb-status-row" }, (0, react.createElement)("div", { className: "imqb-status-icon" }, unbindResult.ok ? "👋" : "⚠️"), (0, react.createElement)("div", { className: "imqb-status-meta" }, (0, react.createElement)("p", { className: "imqb-status-title" }, unbindResult.message)), unbindResult.ok ? (0, react.createElement)("button", {
				className: "imqb-ghost",
				onClick: recheck
			}, "刷新状态") : (0, react.createElement)("button", {
				className: "imqb-ghost",
				onClick: () => {
					setUnbindResult(null);
				}
			}, "返回")));
			if (editing) return (0, react.createElement)("div", { className: "imqb-status" }, (0, react.createElement)("div", { className: "imqb-status-row" }, (0, react.createElement)("div", { className: "imqb-status-meta" }, (0, react.createElement)("p", { className: "imqb-status-title" }, "更换凭据")), (0, react.createElement)("button", {
				className: "imqb-ghost",
				onClick: () => {
					setEditing(false);
				}
			}, "返回")), (0, react.createElement)(ManualForm, { initialAppId: appId }));
			return (0, react.createElement)("div", { className: "imqb-status" }, (0, react.createElement)("div", { className: "imqb-status-row" }, (0, react.createElement)(QqBotIcon, { size: 28 }), (0, react.createElement)("div", { className: "imqb-status-meta" }, (0, react.createElement)("p", { className: "imqb-status-title" }, "已绑定"), (0, react.createElement)("p", { className: "imqb-status-sub imqb-mono" }, `AppID ${appId} · 私聊与群聊已接入`))), (0, react.createElement)("div", { className: "imqb-status-actions" }, (0, react.createElement)("button", {
				className: "imqb-btn imqb-btn--primary",
				onClick: () => {
					setEditing(true);
				}
			}, "更换凭据"), (0, react.createElement)("button", {
				className: "imqb-btn imqb-btn--danger",
				onClick: unbind
			}, "解绑")));
		}
		/** 未绑定视图：扫码 / 手动填写切换 */
		function UnboundView({ state }) {
			const [mode, setMode] = (0, react.useState)("qr");
			const refresh = (0, react.useCallback)(() => {
				fetch(BIND_REFRESH_PATH, { method: "POST" }).catch(() => {});
			}, []);
			if (mode === "manual") return (0, react.createElement)("div", { className: "imqb-panel" }, (0, react.createElement)("p", { className: "imqb-title" }, "手动填写凭据"), (0, react.createElement)(ManualForm, {}), (0, react.createElement)("button", {
				className: "imqb-ghost",
				onClick: () => {
					setMode("qr");
				}
			}, "改用扫码绑定"));
			return (0, react.createElement)("div", { className: "imqb-panel" }, state.qrSvg === void 0 ? null : (0, react.createElement)("img", {
				src: state.qrSvg,
				alt: "QQ 扫码二维码",
				width: 220,
				height: 220,
				className: "imqb-qr"
			}), (0, react.createElement)("p", { className: "imqb-title" }, "扫码绑定 QQ 机器人"), (0, react.createElement)("p", { className: "imqb-hint" }, "使用手机 QQ 扫描二维码完成绑定"), (0, react.createElement)("a", {
				href: state.url,
				target: "_blank",
				rel: "noreferrer noopener",
				className: "imqb-link"
			}, "二维码显示异常？在浏览器中打开"), (0, react.createElement)("div", { className: "imqb-row" }, (0, react.createElement)("button", {
				className: "imqb-pill",
				onClick: refresh
			}, "刷新二维码"), (0, react.createElement)("button", {
				className: "imqb-pill",
				onClick: () => {
					setMode("manual");
				}
			}, "手动填写")));
		}
		/** 依据宿主相位渲染面板主体（各展示位共用） */
		function BindPanelBody() {
			usePanelStyles();
			const { state, gone, recheck } = useBindState();
			const [lastQr, setLastQr] = (0, react.useState)(null);
			(0, react.useEffect)(() => {
				if (state === null) return;
				if (state.phase === "waiting") {
					if (state.qrSvg !== void 0) setLastQr(state.qrSvg);
				} else if (state.phase === "bound") setLastQr(null);
			}, [state]);
			if (gone) return (0, react.createElement)("div", { className: "imqb-panel" }, (0, react.createElement)("div", { className: "imqb-icon" }, "❔"), (0, react.createElement)("p", { className: "imqb-hint" }, "插件未启用，或当前版本不支持端内配置"));
			if (state === null || state.phase === "starting") return (0, react.createElement)("div", { className: "imqb-panel" }, (0, react.createElement)("p", { className: "imqb-hint" }, "正在获取绑定状态…"));
			if (state.phase === "saving") {
				if (lastQr !== null) return (0, react.createElement)("div", { className: "imqb-panel" }, (0, react.createElement)("div", { className: "imqb-scanned" }, (0, react.createElement)("img", {
					src: lastQr,
					alt: "QQ 扫码二维码",
					width: 220,
					height: 220,
					className: "imqb-scanned-qr"
				}), (0, react.createElement)("div", { className: "imqb-scanned-veil" }, (0, react.createElement)("p", { className: "imqb-scanned-title" }, "✅ 扫码成功"), (0, react.createElement)("p", { className: "imqb-scanned-sub" }, "正在连接机器人，稍候…"))));
				return (0, react.createElement)("div", { className: "imqb-status" }, (0, react.createElement)("div", { className: "imqb-status-row" }, (0, react.createElement)("div", { className: "imqb-status-icon" }, "🎉"), (0, react.createElement)("div", { className: "imqb-status-meta" }, (0, react.createElement)("p", { className: "imqb-status-title" }, "扫码成功"), (0, react.createElement)("p", { className: "imqb-status-sub" }, "凭据已保存，插件正在重载，稍后即可开始对话"))));
			}
			if (state.phase === "failed") return (0, react.createElement)("div", { className: "imqb-panel" }, (0, react.createElement)("div", { className: "imqb-icon" }, "⚠️"), (0, react.createElement)("p", { className: "imqb-title" }, "绑定失败"), (0, react.createElement)("p", { className: "imqb-hint" }, state.reason), (0, react.createElement)("div", { className: "imqb-row" }, (0, react.createElement)("button", {
				className: "imqb-btn imqb-btn--primary",
				onClick: () => {
					window.location.reload();
				}
			}, "重试")));
			if (state.phase === "bound") return (0, react.createElement)(BoundView, {
				appId: state.appId,
				recheck
			});
			return (0, react.createElement)(UnboundView, { state });
		}
		//#endregion
		//#region src/client/config-panel.ts
		/**
		* QQ 机器人配置面板 — 必要配置的 UI 编辑
		*
		* UI 复刻 DSW 通用设置（settings-form 原语）的视觉风格：
		* 左对齐设置列、0.5px 行分隔、label 13px/500、控件右置；
		* Switch 为 36×20 aria-checked 结构（thumb translateX 动画）；
		* 三值选择用分段控件（滑动指示器按段数/索引的 CSS 变量定位）；
		* 保存按钮为 DSW 反色主按钮（label-primary 底 + bg-layer-3 字）。
		*
		* 数据流：GET /qqbot/im-qqbot/config 回显当前生效配置（appSecret
		* 已由宿主剔除）→ 表单编辑 → dirty diff → POST 仅提交变更键 →
		* 宿主白名单 + Schema 校验 → 最小写入 profile patch → HMR 重载生效。
		*
		* 字段策略：只开放用户必要的配置；cwd 只读展示；超时与性能调优
		* 类字段走 profile patch / 环境变量。
		*/
		/** 样式注入标记（幂等） */
		const STYLE_ID = "im-qqbot-config-panel-styles";
		/** DSW 通用设置风格（settings-form / Switch / SegmentedControl 原语复刻） */
		function useConfigPanelStyles() {
			(0, react.useEffect)(() => {
				if (typeof document === "undefined") return;
				if (document.getElementById(STYLE_ID) !== null) return;
				const style = document.createElement("style");
				style.id = STYLE_ID;
				style.textContent = `
.imqb2-form { display: flex; flex-direction: column; width: 100%; }
.imqb2-group-title {
  padding: 14px 0 2px; font-size: 12px; font-weight: 600; line-height: 18px;
  color: var(--dsw-alias-label-tertiary); text-transform: uppercase; letter-spacing: .04em;
}
.imqb2-field { display: flex; flex-direction: column; gap: 6px; padding: 12px 0; }
.imqb2-field + .imqb2-field { border-top: 0.5px solid var(--dsw-alias-border-l2); }
.imqb2-head { display: flex; align-items: center; gap: 8px; min-height: 28px; }
.imqb2-label {
  flex: 1; min-width: 0; font-size: 13px; font-weight: 500; line-height: 1.5;
  color: var(--dsw-alias-label-primary);
}
.imqb2-help { margin: 0; font-size: 12px; line-height: 1.6; color: var(--dsw-alias-label-secondary); }
.imqb2-hint { margin: 0; font-size: 12px; line-height: 1.5; color: var(--dsw-alias-label-tertiary); }
/* Switch（aria-checked 驱动，视觉态与无障碍态同源） */
.imqb2-switch {
  box-sizing: border-box; position: relative; flex: 0 0 auto;
  width: 36px; height: 20px; padding: 2px; border: 0; border-radius: 999px;
  background: var(--dsw-alias-border-l3); cursor: pointer; font: inherit;
}
.imqb2-switch[aria-checked='true'] { background: var(--dsw-alias-brand-primary); }
.imqb2-switch:disabled { cursor: default; opacity: 0.5; }
.imqb2-switch:focus-visible {
  outline: var(--dsw-focus-ring-width, 2px) solid var(--dsw-focus-ring-color, var(--dsw-alias-state-business-primary));
  outline-offset: 2px;
}
.imqb2-switch-thumb {
  display: block; width: 16px; height: 16px; border-radius: 50%;
  background: var(--dsw-alias-switch-thumb, #ffffff);
  transition: transform 120ms ease;
}
.imqb2-switch[aria-checked='true'] .imqb2-switch-thumb {
  background: var(--dsw-alias-label-primary-foreground, #ffffff);
  transform: translateX(16px);
}
/* 输入（官方 fields.input 复刻） */
.imqb2-input {
  box-sizing: border-box; width: 100%; height: 34px; padding: 0 12px;
  border: 0.5px solid var(--dsw-alias-border-l4); border-radius: var(--dsw-radius-md, 8px);
  background: var(--dsw-alias-bg-layer-3); font: inherit; font-size: 13px; line-height: 1.5;
  color: var(--dsw-alias-label-primary); outline: none;
}
.imqb2-input:focus { outline: none; border-color: var(--dsw-alias-state-business-primary); }
.imqb2-input:disabled { color: var(--dsw-alias-label-tertiary); cursor: default; }
.imqb2-textarea { height: auto; min-height: 68px; padding: 8px 12px; resize: vertical; line-height: 1.5; }
/* 分段控件（官方 SegmentedControl 复刻：指示器按段数/索引定位） */
.imqb2-seg {
  position: relative; display: inline-grid; grid-auto-flow: column; grid-auto-columns: 1fr;
  gap: 2px; padding: 4px; border-radius: var(--dsw-radius-md, 8px);
  background: var(--dsw-alias-interactive-bg-hover);
}
.imqb2-seg-indicator {
  position: absolute; top: 4px; left: 4px;
  width: calc((100% - 8px - 2px * (var(--imqb2-seg-count) - 1)) / var(--imqb2-seg-count));
  height: calc(100% - 8px);
  border: 0; border-radius: var(--dsw-radius-sm, 6px);
  background: var(--dsw-alias-bg-layer-1);
  box-shadow: var(--dsw-elevation-soft, 0 1px 3px rgba(0,0,0,.08));
  transform: translateX(calc(var(--imqb2-seg-index) * (100% + 2px)));
  transition: transform 160ms ease;
  pointer-events: none;
}
.imqb2-seg-tab {
  box-sizing: border-box; position: relative; z-index: 1; height: 28px; padding: 0 16px;
  border: 0; border-radius: var(--dsw-radius-sm, 6px); background: transparent;
  color: var(--dsw-alias-label-secondary); font: inherit; font-size: 13px; line-height: 20px;
  font-weight: 500; white-space: nowrap; cursor: pointer; transition: color 120ms ease;
}
.imqb2-seg-tab:hover, .imqb2-seg-tab[aria-selected='true'] { color: var(--dsw-alias-label-primary); }
.imqb2-seg-tab:focus-visible {
  outline: var(--dsw-focus-ring-width, 2px) solid var(--dsw-focus-ring-color, var(--dsw-alias-state-business-primary));
  outline-offset: -2px;
}
/* 底栏（官方 SettingsForm.footer 复刻） */
.imqb2-footer { display: flex; align-items: center; gap: 8px; padding-top: 16px; }
.imqb2-note { flex: 1; min-width: 0; margin: 0; font-size: 12px; line-height: 1.5; color: var(--dsw-alias-label-tertiary); }
.imqb2-note--error { color: var(--dsw-alias-state-error-primary, var(--dsw-alias-label-error)); }
.imqb2-note--ok { color: var(--dsw-alias-label-secondary); }
.imqb2-save {
  appearance: none; flex: none; border: 1px solid transparent;
  border-radius: var(--dsw-radius-md, 8px); padding: 5px 14px;
  font: inherit; font-size: 13px; line-height: 1.5; cursor: pointer;
  background: var(--dsw-alias-label-primary); color: var(--dsw-alias-bg-layer-3);
}
.imqb2-save:disabled { opacity: 0.4; cursor: default; }
.imqb2-save:focus-visible {
  outline: var(--dsw-focus-ring-width, 2px) solid var(--dsw-focus-ring-color, var(--dsw-alias-state-business-primary));
  outline-offset: 1px;
}
/* cwd 只读行 */
.imqb2-readonly { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; color: var(--dsw-alias-label-secondary); word-break: break-all; margin: 0; }
/* 睡眠：主人选择器 */
.imqb2-mini {
  height: 26px; padding: 0 10px; border-radius: 6px; font-size: 12px; cursor: pointer;
  border: 0.5px solid var(--dsw-alias-border-l2); background: transparent; color: var(--dsw-alias-label-primary);
}
.imqb2-mini:hover { background: var(--dsw-alias-bg-l2, rgba(127,127,127,0.08)); }
.imqb2-sender-list { display: flex; flex-direction: column; gap: 4px; margin-top: 8px; max-height: 240px; overflow-y: auto; }
.imqb2-sender {
  display: flex; flex-direction: column; align-items: flex-start; gap: 2px; text-align: left;
  padding: 6px 10px; border-radius: 6px; cursor: pointer; font: inherit;
  border: 0.5px solid var(--dsw-alias-border-l2); background: transparent; color: var(--dsw-alias-label-primary);
}
.imqb2-sender:hover:not(:disabled) { border-color: var(--dsw-alias-brand-primary); }
.imqb2-sender:disabled { opacity: 0.5; cursor: default; }
.imqb2-sender-meta { font-size: 11px; color: var(--dsw-alias-label-tertiary); }
.imqb2-sender-text { font-size: 12px; color: var(--dsw-alias-label-secondary); word-break: break-all; }
    `;
				document.head.appendChild(style);
				return () => {
					style.remove();
				};
			}, []);
		}
		/** 开关（官方 Switch 原语结构：aria-checked 驱动视觉态） */
		function Switch({ checked, label, onChange }) {
			return (0, react.createElement)("button", {
				type: "button",
				role: "switch",
				"aria-checked": checked,
				"aria-label": label,
				className: "imqb2-switch",
				onClick: () => {
					onChange(!checked);
				}
			}, (0, react.createElement)("span", { className: "imqb2-switch-thumb" }));
		}
		/** 访问模式分段选择（官方 SegmentedControl 结构：CSS 变量定位滑动指示器） */
		function Segmented({ value, options, onChange, label }) {
			const index = Math.max(0, options.findIndex((o) => o.value === value));
			const trackStyle = {
				"--imqb2-seg-count": options.length,
				"--imqb2-seg-index": index
			};
			return (0, react.createElement)("div", {
				className: "imqb2-seg",
				role: "tablist",
				"aria-label": label,
				style: trackStyle
			}, (0, react.createElement)("span", { className: "imqb2-seg-indicator" }), options.map((o) => (0, react.createElement)("button", {
				key: o.value,
				type: "button",
				role: "tab",
				"aria-selected": o.value === value,
				className: "imqb2-seg-tab",
				onClick: () => {
					onChange(o.value);
				}
			}, o.label)));
		}
		/** 开关行（label 左 + Switch 右 + 可选 help） */
		function SwitchRow({ label, help, checked, onChange }) {
			return (0, react.createElement)("div", { className: "imqb2-field" }, (0, react.createElement)("div", { className: "imqb2-head" }, (0, react.createElement)("span", { className: "imqb2-label" }, label), (0, react.createElement)(Switch, {
				checked,
				label,
				onChange
			})), help === void 0 ? null : (0, react.createElement)("p", { className: "imqb2-help" }, help));
		}
		/** 文本行（label 上 + 输入下，与官方 fields 布局一致） */
		function FieldRow({ label, help, value, placeholder, onChange }) {
			return (0, react.createElement)("div", { className: "imqb2-field" }, (0, react.createElement)("span", { className: "imqb2-label" }, label), (0, react.createElement)("input", {
				className: "imqb2-input",
				value,
				placeholder,
				spellCheck: false,
				onChange: (event) => {
					onChange(event.currentTarget.value);
				}
			}), help === void 0 ? null : (0, react.createElement)("p", { className: "imqb2-hint" }, help));
		}
		/** QQ 机器人默认模型：按分组（provider）下拉选择，含 Our Free Model 等插件提供的模型 */
		function ModelPickerField({ provider, model, onChange }) {
			const h = react.createElement;
			const [data, error, load] = usePolling("/qqbot/im-qqbot/models", 6e4);
			const groups = data?.groups ?? [];
			const cur = provider && model ? `${provider}\u0000${model}` : "";
			const known = groups.some((g) => g.provider === provider && g.models.some((m) => m.id === model));
			const hd = data?.hostDefault;
			return h("div", { className: "imqb2-field" }, h("span", { className: "imqb2-label" }, "默认模型"), h("div", { style: { display: "flex", gap: 8, alignItems: "center" } }, h("select", {
				className: "imqb2-input",
				style: { flex: 1 },
				value: cur,
				onChange: (e) => {
					const v = e.currentTarget.value;
					if (!v) onChange("", "");
					else {
						const [p, m] = v.split("\u0000");
						onChange(p, m);
					}
				}
			}, h("option", { value: "" }, `跟随宿主默认${hd?.provider ? `（${hd.provider}/${hd.model}）` : ""}`), cur && !known ? h("option", { value: cur }, `${provider}/${model}（当前不在可用列表）`) : null, groups.map((g) => h("optgroup", { key: g.provider, label: `${g.label}${g.label !== g.provider ? ` · ${g.provider}` : ""}（${g.models.filter((m) => !m.bad).length} 可用）` }, g.models.map((m) => h("option", { key: m.id, value: `${g.provider}\u0000${m.id}`, disabled: m.bad && !(g.provider === provider && m.id === model) }, `${m.name ?? m.id}${m.name && m.name !== m.id ? `  ·  ${m.id}` : ""}${m.bad ? "（暂不可用）" : ""}`))))), h("button", { type: "button", className: "imqb3-btn imqb3-btn--ghost", onClick: () => fetch("/qqbot/im-qqbot/models?refresh=1", { cache: "no-store" }).then(load) }, "刷新")), h("p", { className: "imqb2-hint" }, error ? `模型列表获取失败：${error}` : "按分组列出当前可用模型（包括 Our Free Model 等插件提供的免费模型）。各群 / 私聊可在聊天里用 /model 单独切换，优先级更高。当前模型不可用时只在同一分组里自动找替补，同组全不可用就直接报错，不会自动跨分组（避免产生费用）。"));
		}
		const DEFAULT_RATE_REPLIES_UI = [
			"说得我口干舌燥了喵…让小喵喝口水，{cd}后再聊嘛 (｡•́︿•̀｡)",
			"呜…大家问得太快啦，小喵的爪爪打字打不过来了喵，歇一分钟再来～",
			"脑袋要冒烟了喵 (×﹏×) 让我缓一缓，一会儿接着聊！",
			"喵呜——今天的嘴巴营业额超标了，小喵先去舔舔毛，马上回来～"
		];
		/** 每群回复额度：默认 分/时/天 上限 + 超限提示 */
		function GroupRateFields({ value, onChange }) {
			const h = react.createElement;
			const v = value ?? {};
			const [f, setF] = (0, react.useState)(() => ({ perMinute: String(v.perMinute ?? 10), perHour: String(v.perHour ?? 100), perDay: String(v.perDay ?? 200), replies: (v.replies ?? []).join("\n"), hourReply: v.hourReply ?? "", dayReply: v.dayReply ?? "" }));
			const num = (x, max) => Math.min(max, Math.max(0, Math.floor(Number(x)) || 0));
			const upd = (patch) => {
				const n = { ...f, ...patch };
				setF(n);
				onChange({ perMinute: num(n.perMinute, 600), perHour: num(n.perHour, 1e5), perDay: num(n.perDay, 1e5), replies: n.replies.split("\n").map((x) => x.trim()).filter(Boolean).slice(0, 30), hourReply: n.hourReply.trim(), dayReply: n.dayReply.trim() });
			};
			const numRow = (key, label, ph, help) => h(FieldRow, { label, value: f[key], placeholder: ph, help, onChange: (t) => upd({ [key]: t.replace(/\D/g, "") }) });
			return h(react.Fragment, null, numRow("perMinute", "每群每分钟最多回复（默认）", "10", "60 秒滑动窗口。超出就进入 CD、回一句提示，不调用模型（省 token；主人不受限）。0 = 不限。各群可在「群聊管理」里单独设置"), numRow("perHour", "每群每小时最多回复（默认）", "100", "最近 60 分钟内的回复数，水群主动插话也算。0 = 不限"), numRow("perDay", "每群每天最多回复（默认）", "200", "自然日计数，每天 0 点重置。0 = 不限"), h(AreaRow, { label: "每分钟超限提示（每行一句，随机挑）", rows: 3, value: f.replies, help: `{cd} 会替换成剩余冷却时间。留空用内置台词，例如「${DEFAULT_RATE_REPLIES_UI[0]}」`, onChange: (t) => upd({ replies: t }) }), h(FieldRow, { label: "每小时超限提示", value: f.hourReply, placeholder: "小喵这个小时已经回了 {used} 条啦…还剩{cd}，稍后再问我吧", help: "可用 {cd} 剩余冷却、{used} 已回复数、{limit} 上限。留空用内置", onChange: (t) => upd({ hourReply: t }) }), h(FieldRow, { label: "每天超限提示", value: f.dayReply, placeholder: "今天额度用光光了喵…还剩{cd}重置，明天再来找我玩吧", help: "同上，CD 到次日 0 点", onChange: (t) => upd({ dayReply: t }) }));
		}
		/** 回复后追加表情包的概率（百分比） */
		function StickerChanceField({ value, onChange }) {
			const v = value ?? {};
			const [text, setText] = (0, react.useState)(String(Math.round((v.stickerChance ?? 0.2) * 100)));
			return (0, react.createElement)(FieldRow, {
				label: "回复附带表情包概率（%）",
				value: text,
				placeholder: "20",
				help: "每次回复（群聊和私聊）按这个概率让小喵再补发一张表情包，作为单独一条消息，表情按回复的情绪挑。0 = 不额外发。表情包库为空时不生效",
				onChange: (t) => {
					const clean = t.replace(/\D/g, "").slice(0, 3);
					setText(clean);
					onChange({ ...v, stickerChance: Math.min(100, Number(clean || 0)) / 100 });
				}
			});
		}
		/** 唤起前缀（空格分隔，如 "# ＃ 小喵"） */
		function TriggerPrefixField({ value, disabled, onChange }) {
			const [text, setText] = (0, react.useState)(() => (Array.isArray(value) ? value : ["#", "＃"]).join(" "));
			return (0, react.createElement)(FieldRow, {
				label: "唤起前缀",
				value: text,
				placeholder: "#",
				help: disabled ? "群消息以这些前缀开头时视同 @ 必定回复（空格分隔多个，如「# ＃」）。⚠️ 当前只接收 @ 消息，需开启上方「接收所有群消息」才生效" : "群消息以这些前缀开头时视同 @，必定回复，前缀本身会被去掉（如「#今天吃啥」）。空格分隔多个，如「# ＃」；留空则不启用",
				onChange: (v) => {
					setText(v);
					onChange([...new Set(v.split(/\s+/).map((s) => s.trim()).filter(Boolean))].slice(0, 10));
				}
			});
		}
		/** 多行文本行 */
		function AreaRow({ label, help, value, rows, onChange }) {
			return (0, react.createElement)("div", { className: "imqb2-field" }, (0, react.createElement)("span", { className: "imqb2-label" }, label), (0, react.createElement)("textarea", {
				className: "imqb2-input imqb2-textarea",
				value,
				rows: rows ?? 3,
				onChange: (event) => {
					onChange(event.currentTarget.value);
				}
			}), help === void 0 ? null : (0, react.createElement)("p", { className: "imqb2-hint" }, help));
		}
		/** 访问模式分段选择行 */
		function SegmentedRow({ label, help, value, options, onChange }) {
			return (0, react.createElement)("div", { className: "imqb2-field" }, (0, react.createElement)("div", { className: "imqb2-head" }, (0, react.createElement)("span", { className: "imqb2-label" }, label), (0, react.createElement)(Segmented, {
				value,
				options,
				onChange,
				label
			})), help === void 0 ? null : (0, react.createElement)("p", { className: "imqb2-hint" }, help));
		}
		const MODE_OPTIONS = [
			{
				value: "open",
				label: "开放"
			},
			{
				value: "allowlist",
				label: "白名单"
			},
			{
				value: "disabled",
				label: "停用"
			}
		];
		const ENGAGE_MODE_OPTIONS = [{
			value: "smart",
			label: "@必回 + 自动水群"
		}, {
			value: "all",
			label: "每条都回"
		}];
		const DEFAULT_ENGAGE = {
			mode: "smart",
			minIntervalSec: 60,
			maxIntervalSec: 120,
			keywords: []
		};
		/** 群聊主动参与配置（接收所有消息开启时显示） */
		function GroupEngageFields({ value, onChange }) {
			const engage = {
				...DEFAULT_ENGAGE,
				...value ?? {}
			};
			const set = (key, v) => {
				onChange({
					...engage,
					[key]: v
				});
			};
			const toSec = (s) => {
				const n = Math.round(Number(s));
				return Number.isFinite(n) && n >= 0 ? Math.min(n, 86400) : 0;
			};
			return (0, react.createElement)(react.Fragment, null, (0, react.createElement)(SegmentedRow, {
				label: "回复策略",
				value: engage.mode,
				options: ENGAGE_MODE_OPTIONS,
				help: engage.mode === "smart" ? "@机器人 必定回复；未 @ 时由水群引擎在聊天停顿时用便宜模型判断要不要插话 / 丢表情包 / 跟着复读。活跃度每个群自动调节（默认安静，被 @ 和被接话越多越活跃），详见「水群」「表情包」分页" : "群里每条消息都会触发回复（消耗大，易刷屏）",
				onChange: (v) => {
					set("mode", v);
				}
						}));
		}
		const DEFAULT_SLEEP = {
			enabled: true,
			start: "00:00",
			end: "08:00",
			wakeMinutes: 30,
			ownerIds: [],
			sleepReply: "呼…小喵在睡觉喵 zzZ，明早 8 点再来找我吧～",
			sleepReplyCooldownMin: 30
		};
		function fmtClock(ms) {
			const d = new Date(ms);
			return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
		}
		/** 当前睡眠状态（10s 轮询） */
		function SleepStatus() {
			const [st, setSt] = (0, react.useState)(null);
			(0, react.useEffect)(() => {
				let stopped = false;
				const load = () => fetch(SLEEP_STATUS_PATH, { cache: "no-store" }).then((r) => r.json()).then((j) => {
					if (!stopped) setSt(j);
				}).catch(() => {});
				load();
				const t = setInterval(load, 1e4);
				return () => {
					stopped = true;
					clearInterval(t);
				};
			}, []);
			if (st === null || !st.active) return (0, react.createElement)("p", { className: "imqb2-hint" }, "机器人未运行，暂无睡眠状态");
			const text = !st.enabled ? "☀️ 睡眠未启用" : st.asleep ? `😴 正在睡觉（${st.start}–${st.end}）` : st.wakeUntil ? `🥱 被主人叫醒，${fmtClock(st.wakeUntil)} 后继续睡` : `☀️ 清醒中（${st.start} 入睡，${st.end} 起床）`;
			return (0, react.createElement)("p", { className: "imqb2-help" }, text, st.enabled && st.ownerCount === 0 ? " · ⚠️ 尚未登记主人，睡眠期间没人能叫醒" : "");
		}
		/** 最近发言人选择器：点击把 openid 加入主人列表 */
		function SenderPicker({ onPick, picked }) {
			const [open, setOpen] = (0, react.useState)(false);
			const [list, setList] = (0, react.useState)(null);
			const [err, setErr] = (0, react.useState)(null);
			const toggle = () => {
				const next = !open;
				setOpen(next);
				if (next) fetch(MESSAGES_SENDERS_PATH, { cache: "no-store" }).then((r) => r.json()).then((j) => {
					if (j.ok) setList(j.senders);
					else setErr(j.error ?? "加载失败");
				}).catch((e) => setErr(String(e)));
			};
			return (0, react.createElement)("div", null, (0, react.createElement)("button", {
				type: "button",
				className: "imqb2-mini",
				onClick: toggle
			}, open ? "收起最近发言人" : "从最近发言人中选择…"), open ? (0, react.createElement)("div", { className: "imqb2-sender-list" }, err !== null ? (0, react.createElement)("p", { className: "imqb2-hint" }, err) : list === null ? (0, react.createElement)("p", { className: "imqb2-hint" }, "加载中…") : list.length === 0 ? (0, react.createElement)("p", { className: "imqb2-hint" }, "暂无消息记录：先在群里 @机器人 或私聊发一条消息") : list.map((s) => (0, react.createElement)("button", {
				type: "button",
				key: s.userOpenid,
				className: "imqb2-sender",
				disabled: picked.includes(s.userOpenid),
				title: s.userOpenid,
				onClick: () => onPick(s.userOpenid)
			}, (0, react.createElement)("span", { className: "imqb2-sender-meta" }, `${s.scene === "group" ? "群" : "私聊"} · ${fmtClock(s.lastAt)} · ${s.userOpenid.slice(0, 10)}…${picked.includes(s.userOpenid) ? " · 已是主人" : ""}`), (0, react.createElement)("span", { className: "imqb2-sender-text" }, (s.content ?? "").slice(0, 60) || "（无文本）")))) : null);
		}
		/** 睡眠配置 */
		function SleepFields({ value, onChange }) {
			const sleep = {
				...DEFAULT_SLEEP,
				...value ?? {}
			};
			const set = (key, v) => {
				onChange({
					...sleep,
					[key]: v
				});
			};
			const [ownerText, setOwnerText] = (0, react.useState)(() => sleep.ownerIds.join("\n"));
			const setOwners = (text) => {
				setOwnerText(text);
				set("ownerIds", text.split("\n").map((s) => s.trim()).filter(Boolean));
			};
			const hm = /^\d{1,2}:\d{2}$/;
			const num = (s, max) => {
				const n = Math.round(Number(s));
				return Number.isFinite(n) && n >= 0 ? Math.min(n, max) : 0;
			};
			return (0, react.createElement)(react.Fragment, null, (0, react.createElement)("div", { className: "imqb2-field" }, (0, react.createElement)(SleepStatus, null)), (0, react.createElement)(SwitchRow, {
				label: "夜间睡眠",
				checked: sleep.enabled,
				help: "睡眠时段内不再随机挑消息回复，普通用户 @ 只回一句固定提示（不调用模型）；主人 @ 或私聊会把机器人叫醒一段时间，之后自动继续睡。所有消息照常落库",
				onChange: (v) => {
					set("enabled", v);
				}
			}), sleep.enabled ? (0, react.createElement)(react.Fragment, null, (0, react.createElement)(FieldRow, {
				label: "入睡时间",
				value: sleep.start,
				placeholder: "00:00",
				help: hm.test(sleep.start) ? void 0 : "⚠️ 格式应为 HH:mm",
				onChange: (v) => {
					set("start", v.trim());
				}
			}), (0, react.createElement)(FieldRow, {
				label: "起床时间",
				value: sleep.end,
				placeholder: "08:00",
				help: hm.test(sleep.end) ? "按运行机器人的电脑本地时间计算，可跨零点" : "⚠️ 格式应为 HH:mm",
				onChange: (v) => {
					set("end", v.trim());
				}
			}), (0, react.createElement)(FieldRow, {
				label: "叫醒后清醒时长（分钟）",
				value: String(sleep.wakeMinutes),
				placeholder: "30",
				help: "清醒期间主人再次互动会重新计时",
				onChange: (v) => {
					set("wakeMinutes", Math.max(1, num(v, 720)));
				}
			}), (0, react.createElement)("div", { className: "imqb2-field" }, (0, react.createElement)("span", { className: "imqb2-label" }, "主人 openid"), (0, react.createElement)("textarea", {
				className: "imqb2-input imqb2-textarea",
				rows: 3,
				value: ownerText,
				placeholder: "每行一个 openid",
				spellCheck: false,
				onChange: (e) => {
					setOwners(e.currentTarget.value);
				}
			}), (0, react.createElement)("p", { className: "imqb2-hint" }, "QQ 机器人拿不到 QQ 号，只能用 openid 识别主人（同一个人在群聊和私聊中的 openid 相同，登记一次即可）。先用你的 QQ 私聊机器人或在群里 @ 它发一条消息，再点下面选择。"), (0, react.createElement)(SenderPicker, {
				picked: sleep.ownerIds,
				onPick: (id) => {
					setOwners([...sleep.ownerIds, id].join("\n"));
				}
			})), (0, react.createElement)(AreaRow, {
				label: "睡眠中的固定回复",
				rows: 2,
				value: sleep.sleepReply,
				help: "普通用户在睡眠时段 @机器人 或私聊时发送，留空则完全不回复",
				onChange: (v) => {
					set("sleepReply", v);
				}
			}), (0, react.createElement)(FieldRow, {
				label: "固定回复最短间隔（分钟）",
				value: String(sleep.sleepReplyCooldownMin),
				placeholder: "30",
				help: "同一个群 / 私聊在此间隔内只提示一次，避免刷屏",
				onChange: (v) => {
					set("sleepReplyCooldownMin", num(v, 1440));
				}
			})) : null);
		}
		/** 深比较（表单值与初始回显值的 dirty 判断） */
		function shallowEqual(a, b) {
			return JSON.stringify(a) === JSON.stringify(b);
		}
		/**
		* 配置面板主体。
		*
		* 保存仅提交变更键（服务端按白名单合并），保存成功后提示
		* HMR 重载语义（进行中的机器人会话将重置）。
		*/
		function ConfigPanel() {
			useConfigPanelStyles();
			const [initial, setInitial] = (0, react.useState)(null);
			const [form, setForm] = (0, react.useState)(null);
			const [busy, setBusy] = (0, react.useState)(false);
			const [result, setResult] = (0, react.useState)(null);
			const [loadError, setLoadError] = (0, react.useState)(null);
			(0, react.useEffect)(() => {
				let stopped = false;
				fetch(BIND_CONFIG_PATH, { cache: "no-store" }).then(async (res) => {
					if (!res.ok) throw new Error(`HTTP ${res.status}`);
					const body = await res.json();
					if (stopped) return;
					setInitial(body.config);
					setForm(body.config);
				}).catch((err) => {
					if (!stopped) setLoadError(err instanceof Error ? err.message : String(err));
				});
				return () => {
					stopped = true;
				};
			}, []);
			const patch = (0, react.useCallback)((key, value) => {
				setForm((current) => current === null ? current : {
					...current,
					[key]: value
				});
				setResult(null);
			}, []);
			const submit = (0, react.useCallback)((event) => {
				event.preventDefault();
				if (busy || initial === null || form === null) return;
				const changed = {};
				for (const key of Object.keys(form)) if (!shallowEqual(form[key], initial[key])) changed[key] = form[key];
				if (Object.keys(changed).length === 0) return;
				setBusy(true);
				fetch(BIND_CONFIG_PATH, {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify(changed)
				}).then(async (res) => {
					const body = await res.json().catch(() => ({}));
					if (res.ok && body.ok === true) {
						setResult({
							ok: true,
							message: body.message ?? "配置已保存，插件将自动重载"
						});
						setInitial(form);
						return;
					}
					setResult({
						ok: false,
						message: body.error ?? `保存失败（HTTP ${res.status}）`
					});
				}).catch((err) => {
					setResult({
						ok: false,
						message: err instanceof Error ? err.message : String(err)
					});
				}).finally(() => {
					setBusy(false);
				});
			}, [
				busy,
				form,
				initial
			]);
			if (loadError !== null) return (0, react.createElement)("p", {
				className: "imqb2-hint",
				style: { padding: "12px 0" }
			}, `配置加载失败：${loadError}`);
			if (initial === null || form === null) return (0, react.createElement)("p", {
				className: "imqb2-hint",
				style: { padding: "12px 0" }
			}, "正在加载配置…");
			const dirty = Object.keys(form).some((key) => !shallowEqual(form[key], initial[key]));
			const access = form.access ?? {
				c2cMode: "open",
				c2cAllow: [],
				groupMode: "open",
				groupAllow: []
			};
			return (0, react.createElement)("form", {
				className: "imqb2-form",
				onSubmit: submit
			}, (0, react.createElement)("div", { className: "imqb2-group-title" }, "访问控制"), (0, react.createElement)(SegmentedRow, {
				label: "私聊",
				value: access.c2cMode,
				options: MODE_OPTIONS,
				onChange: (v) => {
					patch("access", {
						...access,
						c2cMode: v
					});
				}
			}), access.c2cMode === "allowlist" ? (0, react.createElement)(AreaRow, {
				label: "私聊白名单",
				help: "每行一个 openid",
				rows: 3,
				value: access.c2cAllow.join("\n"),
				onChange: (v) => {
					patch("access", {
						...access,
						c2cAllow: v.split("\n").map((s) => s.trim()).filter(Boolean)
					});
				}
			}) : null, (0, react.createElement)(SegmentedRow, {
				label: "群聊",
				value: access.groupMode,
				options: MODE_OPTIONS,
				onChange: (v) => {
					patch("access", {
						...access,
						groupMode: v
					});
				}
			}), access.groupMode === "allowlist" ? (0, react.createElement)(AreaRow, {
				label: "群聊白名单",
				help: "每行一个群 openid",
				rows: 3,
				value: access.groupAllow.join("\n"),
				onChange: (v) => {
					patch("access", {
						...access,
						groupAllow: v.split("\n").map((s) => s.trim()).filter(Boolean)
					});
				}
			}) : null, (0, react.createElement)("div", { className: "imqb2-group-title" }, "群聊"), (0, react.createElement)(SwitchRow, {
				label: "接收所有群消息",
				checked: !(form.requireMention ?? true),
				help: "关闭：只处理 @机器人 的消息。开启：群里每条消息都会落库并作为上下文，回复方式见下方「回复策略」。需同时在 QQ 开放平台为机器人开启「接收所有消息」（GROUP_MESSAGE_CREATE）",
				onChange: (v) => {
					patch("requireMention", !v);
				}
			}), (0, react.createElement)(TriggerPrefixField, {
				value: form.triggerPrefixes,
				disabled: form.requireMention ?? true,
				onChange: (v) => {
					patch("triggerPrefixes", v);
				}
			}), (0, react.createElement)(GroupRateFields, {
				value: form.groupRateLimit,
				onChange: (v) => {
					patch("groupRateLimit", v);
				}
			}), (0, react.createElement)(StickerChanceField, {
				value: form.pulse,
				onChange: (v) => {
					patch("pulse", v);
				}
			}), !(form.requireMention ?? true) ? (0, react.createElement)(GroupEngageFields, {
				value: form.groupEngage,
				onChange: (v) => {
					patch("groupEngage", v);
				}
			}) : null, (0, react.createElement)("div", { className: "imqb2-group-title" }, "睡眠（省 token）"), (0, react.createElement)(SleepFields, {
				value: form.sleep,
				onChange: (v) => {
					patch("sleep", v);
				}
			}), (0, react.createElement)("div", { className: "imqb2-group-title" }, "基本"), (0, react.createElement)(SwitchRow, {
				label: "流式输出",
				checked: form.streaming ?? true,
				help: "回复内容分段实时推送到聊天",
				onChange: (v) => {
					patch("streaming", v);
				}
			}), (0, react.createElement)(SwitchRow, {
				label: "显示工具调用结果",
				checked: form.showToolResults ?? false,
				help: "在聊天中展示 agent 工具调用的结构化结果",
				onChange: (v) => {
					patch("showToolResults", v);
				}
			}), (0, react.createElement)("div", { className: "imqb2-group-title" }, "模型"), (0, react.createElement)(ModelPickerField, {
				provider: form.provider ?? "",
				model: form.model ?? "",
				onChange: (p, m) => {
					patch("provider", p);
					patch("model", m);
				}
			}), (0, react.createElement)(FieldRow, {
				label: "Preset",
				value: form.preset ?? "",
				placeholder: "Agent preset id",
				onChange: (v) => {
					patch("preset", v);
				}
			}), (0, react.createElement)(SegmentedRow, {
				label: "聊天中切换模型",
				value: form.modelSwitch ?? "owner",
				options: [{
					value: "owner",
					label: "仅主人"
				}, {
					value: "anyone",
					label: "所有人"
				}],
				help: "在 QQ 里说一句「本群换成 sonnet」「所有群都用 haiku」「XX群（群名/群号）用回默认」「各群都用什么模型」，机器人会自动切换（保留上下文）。优先级：单个群/私聊 > 所有群/所有私聊 > 上方 Provider/Model > 宿主默认。「所有人」只放开切换当前会话，跨群/全局仍仅主人；群名/群号需先在对应群里告诉机器人登记",
				onChange: (v) => {
					patch("modelSwitch", v);
				}
			}), (0, react.createElement)("div", { className: "imqb2-group-title" }, "补充指令"), (0, react.createElement)(SwitchRow, {
				label: "移除 Harness 默认提示词",
				checked: form.replaceHarnessPrompt ?? true,
				help: "QQ 会话中去掉 DeepSeek Harness 桌面端的身份 / 界面 / 文件卡片等提示词，改为「你在和 QQ 用户对话」，并要求提问一律以 QQ 按钮消息发出（工具使用规范保留）",
				onChange: (v) => {
					patch("replaceHarnessPrompt", v);
				}
			}), (0, react.createElement)(AreaRow, {
				label: "群聊额外 system prompt",
				value: form.groupPrompt ?? "",
				onChange: (v) => {
					patch("groupPrompt", v);
				}
			}), (0, react.createElement)(AreaRow, {
				label: "私聊额外 system prompt",
				value: form.directPrompt ?? "",
				onChange: (v) => {
					patch("directPrompt", v);
				}
			}), form.cwd !== void 0 ? (0, react.createElement)("div", { className: "imqb2-field" }, (0, react.createElement)("div", { className: "imqb2-head" }, (0, react.createElement)("span", { className: "imqb2-label" }, "Agent 工作目录"), (0, react.createElement)("span", { className: "imqb2-hint" }, "只读")), (0, react.createElement)("p", { className: "imqb2-readonly" }, form.cwd)) : null, (0, react.createElement)("div", { className: "imqb2-footer" }, result !== null ? (0, react.createElement)("p", { className: `imqb2-note${result.ok ? " imqb2-note--ok" : " imqb2-note--error"}` }, (result.ok ? "" : "⚠️ ") + result.message) : dirty ? (0, react.createElement)("p", { className: "imqb2-note" }, "保存后插件将重载，进行中的机器人会话将重置") : (0, react.createElement)("p", { className: "imqb2-note" }), (0, react.createElement)("button", {
				className: "imqb2-save",
				type: "submit",
				disabled: busy || !dirty
			}, busy ? "正在保存…" : "保存")));
		}
		//#endregion
		//#region src/client/message-store-panel.ts
		/**
		* 消息存储面板 — 每个群/私聊的已存消息数、最近消息预览、清理操作
		*
		* 数据源：宿主 SQLite（~/.dsh-qqbot/messages.db），经同源路由读写。
		*/
		const STYLE_ID_MSG = "im-qqbot-message-store-styles";
		function useMessageStoreStyles() {
			(0, react.useEffect)(() => {
				if (typeof document === "undefined") return;
				if (document.getElementById(STYLE_ID_MSG) !== null) return;
				const style = document.createElement("style");
				style.id = STYLE_ID_MSG;
				style.textContent = `
.imqb3-tabs { display: flex; gap: 2px; border-bottom: 0.5px solid var(--dsw-alias-border-l2, rgba(128,128,128,.3)); margin-bottom: 4px; }
.imqb3-tab {
  appearance: none; border: 0; background: transparent; cursor: pointer; font: inherit;
  font-size: 13px; font-weight: 500; line-height: 20px; padding: 8px 12px; margin-bottom: -0.5px;
  color: var(--dsw-alias-label-secondary); border-bottom: 2px solid transparent;
  transition: color 120ms ease, border-color 120ms ease;
}
.imqb3-tab:hover { color: var(--dsw-alias-label-primary); }
.imqb3-tab[aria-selected='true'] { color: var(--dsw-alias-label-primary); border-bottom-color: var(--dsw-alias-label-primary); }
.imqb3-tab:focus-visible { outline: 2px solid var(--dsw-alias-state-business-primary, #4d6bfe); outline-offset: -2px; }
.imqb3 { display: flex; flex-direction: column; gap: 4px; font-size: 13px; color: var(--dsw-alias-label-primary); }
.imqb3-summary { display: grid; grid-template-columns: repeat(auto-fit, minmax(96px, 1fr)); gap: 8px; padding: 12px 0 4px; }
.imqb3-stat { display: flex; flex-direction: column; gap: 2px; padding: 10px 12px; border-radius: var(--dsw-radius-md, 8px); background: var(--dsw-alias-interactive-bg-hover, rgba(128,128,128,.08)); }
.imqb3-stat-value { font-size: 18px; font-weight: 600; line-height: 1.3; font-variant-numeric: tabular-nums; }
.imqb3-stat-label { font-size: 12px; color: var(--dsw-alias-label-tertiary); }
.imqb3-path { margin: 0; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 11px; color: var(--dsw-alias-label-tertiary); word-break: break-all; }
.imqb3-toolbar { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; padding: 8px 0; }
.imqb3-spacer { flex: 1; }
.imqb3-btn {
  appearance: none; font: inherit; font-size: 12px; line-height: 18px; cursor: pointer;
  padding: 4px 10px; border-radius: var(--dsw-radius-sm, 6px); color: var(--dsw-alias-label-primary);
  border: 0.5px solid var(--dsw-alias-border-l4, rgba(128,128,128,.4)); background: var(--dsw-alias-bg-layer-3, transparent);
}
.imqb3-btn:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover, rgba(128,128,128,.12)); }
.imqb3-btn:disabled { opacity: .45; cursor: default; }
.imqb3-btn--danger { color: var(--dsw-alias-state-error-primary, #e5484d); }
.imqb3-btn--ghost { border-color: transparent; background: transparent; }
.imqb3-select {
  font: inherit; font-size: 12px; height: 28px; padding: 0 6px; border-radius: var(--dsw-radius-sm, 6px);
  border: 0.5px solid var(--dsw-alias-border-l4, rgba(128,128,128,.4)); background: var(--dsw-alias-bg-layer-3, transparent);
  color: var(--dsw-alias-label-primary);
}
.imqb3-section-title {
  display: flex; align-items: center; gap: 8px; padding: 14px 0 4px; font-size: 12px; font-weight: 600;
  color: var(--dsw-alias-label-tertiary); text-transform: uppercase; letter-spacing: .04em;
}
.imqb3-list { display: flex; flex-direction: column; }
.imqb3-row { display: flex; align-items: center; gap: 10px; padding: 9px 0; border-top: 0.5px solid var(--dsw-alias-border-l2, rgba(128,128,128,.25)); }
.imqb3-row:first-child { border-top: 0; }
.imqb3-row-main { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 2px; }
.imqb3-id { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.imqb3-meta { font-size: 12px; color: var(--dsw-alias-label-tertiary); }
.imqb3-count { font-variant-numeric: tabular-nums; font-weight: 600; min-width: 44px; text-align: right; }
.imqb3-bar { height: 3px; border-radius: 2px; background: var(--dsw-alias-border-l2, rgba(128,128,128,.2)); overflow: hidden; margin-top: 3px; }
.imqb3-bar > span { display: block; height: 100%; background: var(--dsw-alias-brand-primary, #4d6bfe); border-radius: 2px; }
.imqb3-actions { display: flex; gap: 4px; flex: none; }
.imqb3-preview { margin: 0 0 8px; padding: 8px 10px; border-radius: var(--dsw-radius-md, 8px); background: var(--dsw-alias-interactive-bg-hover, rgba(128,128,128,.08)); display: flex; flex-direction: column; gap: 6px; max-height: 280px; overflow: auto; }
.imqb3-msg { display: flex; flex-direction: column; gap: 1px; }
.imqb3-msg-head { font-size: 11px; color: var(--dsw-alias-label-tertiary); font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
.imqb3-msg-body { font-size: 12px; line-height: 1.5; white-space: pre-wrap; word-break: break-word; }
.imqb3-empty { margin: 0; padding: 12px 0; font-size: 12px; color: var(--dsw-alias-label-tertiary); }
.imqb3-note { margin: 0; font-size: 12px; color: var(--dsw-alias-label-secondary); }
.imqb3-note--error { color: var(--dsw-alias-state-error-primary, #e5484d); }
    `;
				document.head.appendChild(style);
				return () => {
					style.remove();
				};
			}, []);
		}
		function formatBytes(n) {
			if (!Number.isFinite(n) || n <= 0) return "0 B";
			const units = ["B", "KB", "MB", "GB"];
			let i = 0;
			let v = n;
			while (v >= 1024 && i < units.length - 1) {
				v /= 1024;
				i += 1;
			}
			return `${v >= 100 || i === 0 ? Math.round(v) : v.toFixed(1)} ${units[i]}`;
		}
		function formatTime(ts) {
			if (!ts) return "—";
			const d = new Date(ts);
			const pad = (x) => String(x).padStart(2, "0");
			const now = new Date();
			const sameDay = d.toDateString() === now.toDateString();
			const hm = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
			return sameDay ? `今天 ${hm}` : `${d.getFullYear() === now.getFullYear() ? "" : d.getFullYear() + "-"}${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${hm}`;
		}
		function shortId(id) {
			return id.length > 16 ? `${id.slice(0, 8)}…${id.slice(-6)}` : id;
		}
		async function postJson(path, body) {
			const res = await fetch(path, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify(body)
			});
			const data = await res.json().catch(() => ({}));
			if (!res.ok || data.ok !== true) throw new Error(data.error ?? `HTTP ${res.status}`);
			return data;
		}
		/** 单个会话的最近消息预览 */
		function RecentPreview({ scene, id }) {
			const [messages, setMessages] = (0, react.useState)(null);
			const [error, setError] = (0, react.useState)(null);
			(0, react.useEffect)(() => {
				let stopped = false;
				postJson(MESSAGES_RECENT_PATH, {
					scene,
					id,
					limit: 20
				}).then((data) => {
					if (!stopped) setMessages(data.messages ?? []);
				}).catch((err) => {
					if (!stopped) setError(err instanceof Error ? err.message : String(err));
				});
				return () => {
					stopped = true;
				};
			}, [scene, id]);
			if (error !== null) return (0, react.createElement)("div", { className: "imqb3-preview" }, (0, react.createElement)("p", { className: "imqb3-note imqb3-note--error" }, `加载失败：${error}`));
			if (messages === null) return (0, react.createElement)("div", { className: "imqb3-preview" }, (0, react.createElement)("p", { className: "imqb3-note" }, "正在加载…"));
			if (messages.length === 0) return (0, react.createElement)("div", { className: "imqb3-preview" }, (0, react.createElement)("p", { className: "imqb3-note" }, "暂无消息"));
			return (0, react.createElement)("div", { className: "imqb3-preview" }, messages.map((m) => (0, react.createElement)("div", {
				key: m.msgId,
				className: "imqb3-msg"
			}, (0, react.createElement)("span", {
				className: "imqb3-msg-head",
				title: m.userOpenid
			}, `${formatTime(m.receivedAt)} · ${shortId(m.userOpenid)}`), (0, react.createElement)("span", { className: "imqb3-msg-body" }, m.content || "（非文本消息）"))));
		}
		/** 会话行：openid + 计数条 + 查看 / 清理 */
		function ConversationRow({ scene, id, count, users, lastAt, max, busy, onClear, label }) {
			const [open, setOpen] = (0, react.useState)(false);
			const pct = max > 0 ? Math.max(2, Math.round(count / max * 100)) : 0;
			const meta = scene === "group" ? `${label ? `${label} · ` : "未登记群名 · "}${users} 人发言 · 最近 ${formatTime(lastAt)}` : `最近 ${formatTime(lastAt)}`;
			return (0, react.createElement)(react.Fragment, null, (0, react.createElement)("div", { className: "imqb3-row" }, (0, react.createElement)("div", { className: "imqb3-row-main" }, (0, react.createElement)("span", {
				className: "imqb3-id",
				title: id
			}, id), (0, react.createElement)("span", { className: "imqb3-meta" }, meta), (0, react.createElement)("div", { className: "imqb3-bar" }, (0, react.createElement)("span", { style: { width: `${pct}%` } }))), (0, react.createElement)("span", { className: "imqb3-count" }, count.toLocaleString()), (0, react.createElement)("div", { className: "imqb3-actions" }, (0, react.createElement)("button", {
				type: "button",
				className: "imqb3-btn imqb3-btn--ghost",
				"aria-expanded": open,
				onClick: () => {
					setOpen((v) => !v);
				}
			}, open ? "收起" : "查看"), (0, react.createElement)("button", {
				type: "button",
				className: "imqb3-btn imqb3-btn--danger",
				disabled: busy,
				onClick: onClear
			}, "清理"))), open ? (0, react.createElement)(RecentPreview, {
				scene,
				id
			}) : null);
		}
		const OLDER_OPTIONS = [
			7,
			30,
			90,
			180
		];
		function MessageStorePanel({ privateOnly = false } = {}) {
			useMessageStoreStyles();
			const [stats, setStats] = (0, react.useState)(null);
			const [loadError, setLoadError] = (0, react.useState)(null);
			const [busy, setBusy] = (0, react.useState)(false);
			const [note, setNote] = (0, react.useState)(null);
			const [olderDays, setOlderDays] = (0, react.useState)(30);
			const load = (0, react.useCallback)(() => {
				return fetch(MESSAGES_STATS_PATH, { cache: "no-store" }).then(async (res) => {
					if (res.status === 404) throw new Error("当前插件版本未提供消息存储接口");
					if (!res.ok) throw new Error(`HTTP ${res.status}`);
					setStats(await res.json());
					setLoadError(null);
				}).catch((err) => {
					setLoadError(err instanceof Error ? err.message : String(err));
				});
			}, []);
			(0, react.useEffect)(() => {
				load();
				const timer = setInterval(() => {
					if (typeof document === "undefined" || document.visibilityState !== "hidden") load();
				}, 15e3);
				return () => {
					clearInterval(timer);
				};
			}, [load]);
			const clear = (0, react.useCallback)((target, confirmText) => {
				if (busy) return;
				if (!window.confirm(confirmText)) return;
				setBusy(true);
				setNote(null);
				postJson(MESSAGES_CLEAR_PATH, target).then((data) => {
					setNote({
						ok: true,
						text: `已清理 ${data.deleted} 条消息`
					});
				}).catch((err) => {
					setNote({
						ok: false,
						text: `清理失败：${err instanceof Error ? err.message : String(err)}`
					});
				}).finally(() => {
					setBusy(false);
					load();
				});
			}, [busy, load]);
			if (loadError !== null && stats === null) return (0, react.createElement)("div", { className: "imqb3" }, (0, react.createElement)("p", { className: "imqb3-empty" }, `消息存储加载失败：${loadError}`), (0, react.createElement)("div", null, (0, react.createElement)("button", {
				type: "button",
				className: "imqb3-btn",
				onClick: load
			}, "重试")));
			if (stats === null) return (0, react.createElement)("div", { className: "imqb3" }, (0, react.createElement)("p", { className: "imqb3-empty" }, "正在加载消息存储…"));
			if (!stats.enabled) return (0, react.createElement)("div", { className: "imqb3" }, (0, react.createElement)("p", { className: "imqb3-empty" }, stats.openError ? `消息存储打开失败：${stats.openError}` : "消息存储未启用（配置 messageStore.enabled: false）"));
			if (stats.error) return (0, react.createElement)("div", { className: "imqb3" }, (0, react.createElement)("p", { className: "imqb3-empty imqb3-note--error" }, `读取失败：${stats.error}`));
			const groups = stats.groups ?? [];
			const c2c = stats.c2c ?? [];
			const maxGroup = groups.reduce((m, g) => Math.max(m, g.count), 0);
			const maxC2c = c2c.reduce((m, u) => Math.max(m, u.count), 0);
			return (0, react.createElement)("div", { className: "imqb3" }, (0, react.createElement)("div", { className: "imqb3-summary" }, (0, react.createElement)("div", { className: "imqb3-stat" }, (0, react.createElement)("span", { className: "imqb3-stat-value" }, stats.total.toLocaleString()), (0, react.createElement)("span", { className: "imqb3-stat-label" }, "消息总数")), (0, react.createElement)("div", { className: "imqb3-stat" }, (0, react.createElement)("span", { className: "imqb3-stat-value" }, groups.length), (0, react.createElement)("span", { className: "imqb3-stat-label" }, "群")), (0, react.createElement)("div", { className: "imqb3-stat" }, (0, react.createElement)("span", { className: "imqb3-stat-value" }, c2c.length), (0, react.createElement)("span", { className: "imqb3-stat-label" }, "私聊用户")), (0, react.createElement)("div", { className: "imqb3-stat" }, (0, react.createElement)("span", { className: "imqb3-stat-value" }, formatBytes(stats.sizeBytes)), (0, react.createElement)("span", { className: "imqb3-stat-label" }, "占用空间"))), (0, react.createElement)("p", {
				className: "imqb3-path",
				title: stats.path
			}, `${stats.path}${stats.retentionDays > 0 ? ` · 自动保留 ${stats.retentionDays} 天` : " · 永久保留"}${stats.firstAt ? ` · 最早 ${formatTime(stats.firstAt)}` : ""}`), (0, react.createElement)("div", { className: "imqb3-toolbar" }, (0, react.createElement)("select", {
				className: "imqb3-select",
				value: olderDays,
				"aria-label": "清理时间范围",
				onChange: (event) => {
					setOlderDays(Number(event.currentTarget.value));
				}
			}, OLDER_OPTIONS.map((d) => (0, react.createElement)("option", {
				key: d,
				value: d
			}, `${d} 天前`))), (0, react.createElement)("button", {
				type: "button",
				className: "imqb3-btn",
				disabled: busy || stats.total === 0,
				onClick: () => {
					clear({
						kind: "older",
						days: olderDays
					}, `确定删除 ${olderDays} 天前的全部消息吗？此操作不可撤销。`);
				}
			}, "清理旧消息"), (0, react.createElement)("button", {
				type: "button",
				className: "imqb3-btn imqb3-btn--danger",
				disabled: busy || stats.total === 0,
				onClick: () => {
					clear({ kind: "all" }, `确定清空全部 ${stats.total} 条消息吗？此操作不可撤销。`);
				}
			}, "一键清空"), (0, react.createElement)("span", { className: "imqb3-spacer" }), (0, react.createElement)("button", {
				type: "button",
				className: "imqb3-btn imqb3-btn--ghost",
				disabled: busy,
				onClick: load
			}, "刷新")), note !== null ? (0, react.createElement)("p", { className: `imqb3-note${note.ok ? "" : " imqb3-note--error"}` }, note.text) : null, privateOnly ? null : (0, react.createElement)("div", { className: "imqb3-section-title" }, `群聊（${groups.length}）`), privateOnly ? null : groups.length === 0 ? (0, react.createElement)("p", { className: "imqb3-empty" }, "还没有存储任何群消息") : (0, react.createElement)("div", { className: "imqb3-list" }, groups.map((g) => (0, react.createElement)(ConversationRow, {
				key: g.groupOpenid,
				scene: "group",
				id: g.groupOpenid,
				label: g.label,
				count: g.count,
				users: g.users,
				lastAt: g.lastAt,
				max: maxGroup,
				busy,
				onClear: () => {
					clear({
						kind: "group",
						id: g.groupOpenid
					}, `确定清理该群的 ${g.count} 条消息吗？\n${g.groupOpenid}`);
				}
			}))), (0, react.createElement)("div", { className: "imqb3-section-title" }, `私聊（${c2c.length}）`), c2c.length === 0 ? (0, react.createElement)("p", { className: "imqb3-empty" }, "还没有存储任何私聊消息") : (0, react.createElement)("div", { className: "imqb3-list" }, c2c.map((u) => (0, react.createElement)(ConversationRow, {
				key: u.userOpenid,
				scene: "c2c",
				id: u.userOpenid,
				count: u.count,
				lastAt: u.lastAt,
				max: maxC2c,
				busy,
				onClear: () => {
					clear({
						kind: "c2c",
						id: u.userOpenid
					}, `确定清理与该用户的 ${u.count} 条私聊消息吗？\n${u.userOpenid}`);
				}
			}))), (0, react.createElement)("p", {
				className: "imqb3-path",
				style: { paddingTop: 12 }
			}, "注：ID 为 QQ 开放平台 openid（每个机器人独立），不是 QQ 号。"));
		}
		/**
		* 水群面板 + 表情包面板
		*/
		const PULSE_STATUS_PATH = "/qqbot/im-qqbot/pulse/status";
		const PULSE_ACTION_PATH = "/qqbot/im-qqbot/pulse/action";
		const STICKERS_LIST_PATH = "/qqbot/im-qqbot/stickers/list";
		const STICKERS_FILE_PATH = "/qqbot/im-qqbot/stickers/file";
		const STICKERS_UPDATE_PATH = "/qqbot/im-qqbot/stickers/update";
		const STYLE_ID_PULSE = "im-qqbot-pulse-styles";
		function usePulseStyles() {
			(0, react.useEffect)(() => {
				if (typeof document === "undefined" || document.getElementById(STYLE_ID_PULSE) !== null) return;
				const style = document.createElement("style");
				style.id = STYLE_ID_PULSE;
				style.textContent = `
.imqbp-meter { height: 6px; border-radius: 3px; background: var(--dsw-alias-interactive-bg-hover, rgba(128,128,128,.15)); overflow: hidden; }
.imqbp-meter > span { display: block; height: 100%; background: var(--dsw-alias-state-business-primary, #4d6bfe); }
.imqbp-card { padding: 10px 0; border-top: 0.5px solid var(--dsw-alias-border-l2, rgba(128,128,128,.25)); display: flex; flex-direction: column; gap: 6px; }
.imqbp-kv { display: flex; flex-wrap: wrap; gap: 4px 12px; font-size: 12px; color: var(--dsw-alias-label-secondary); }
.imqbp-log { margin: 0; padding: 0; list-style: none; font-size: 12px; max-height: 260px; overflow: auto; }
.imqbp-log li { padding: 3px 0; display: flex; gap: 8px; color: var(--dsw-alias-label-secondary); }
.imqbp-log time { flex: none; color: var(--dsw-alias-label-tertiary); font-variant-numeric: tabular-nums; }
.imqbp-log .k-act, .imqbp-log .k-repeat { color: var(--dsw-alias-label-primary); font-weight: 500; }
.imqbp-log .k-error { color: var(--dsw-alias-state-error-primary, #e5484d); }
.imqbp-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(118px, 1fr)); gap: 8px; padding: 8px 0; }
.imqbp-st { display: flex; flex-direction: column; gap: 4px; padding: 6px; border-radius: var(--dsw-radius-md, 8px); background: var(--dsw-alias-interactive-bg-hover, rgba(128,128,128,.06)); font-size: 11px; }
.imqbp-st[data-off='true'] { opacity: .45; }
.imqbp-st img { width: 100%; aspect-ratio: 1; object-fit: contain; border-radius: 6px; background: rgba(128,128,128,.08); }
.imqbp-st .ph { width: 100%; aspect-ratio: 1; display: flex; align-items: center; justify-content: center; color: var(--dsw-alias-label-tertiary); }
.imqbp-tags { color: var(--dsw-alias-label-tertiary); overflow: hidden; text-overflow: ellipsis; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; }
.imqbp-st-actions { display: flex; gap: 4px; }
.imqbp-st-actions button { flex: 1; padding: 2px 0; font-size: 11px; }
.imqbp-input { font: inherit; font-size: 12px; height: 26px; padding: 0 8px; border-radius: var(--dsw-radius-sm, 6px); border: 0.5px solid var(--dsw-alias-border-l4, rgba(128,128,128,.4)); background: transparent; color: var(--dsw-alias-label-primary); }
`;
				document.head.appendChild(style);
			}, []);
		}
		function fmtClock(ms) {
			if (!ms) return "—";
			const d = new Date(ms);
			const same = d.toDateString() === (/* @__PURE__ */ new Date()).toDateString();
			const hm = d.toTimeString().slice(0, 5);
			return same ? hm : `${d.getMonth() + 1}/${d.getDate()} ${hm}`;
		}
		function usePolling(path, intervalMs) {
			const [data, setData] = (0, react.useState)(null);
			const [error, setError] = (0, react.useState)(null);
			const load = (0, react.useCallback)(() => fetch(path, { cache: "no-store" }).then(async (res) => {
				if (res.status === 404) throw new Error("当前插件版本未提供该接口（请重载插件）");
				if (!res.ok) throw new Error(`HTTP ${res.status}`);
				setData(await res.json());
				setError(null);
			}).catch((err) => setError(err instanceof Error ? err.message : String(err))), [path]);
			(0, react.useEffect)(() => {
				load();
				const t = setInterval(() => {
					if (typeof document === "undefined" || document.visibilityState !== "hidden") load();
				}, intervalMs);
				return () => clearInterval(t);
			}, [load, intervalMs]);
			return [data, error, load];
		}
		const KIND_LABEL = { act: "出手", repeat: "复读", pass: "不插", skip: "跳过", feedback: "反馈", level: "活跃度", error: "错误" };
		function PulseGroupCard({ g, onAction, busy }) {
			const h = react.createElement;
			const [showLog, setShowLog] = (0, react.useState)(false);
			const s = g.stats ?? {};
			return h("div", { className: "imqbp-card" }, h("div", { className: "imqb3-row-main" }, h("span", { style: { fontWeight: 600 } }, g.label || g.groupOpenid), h("span", { className: "imqb3-path" }, g.groupOpenid)), h("div", { style: { display: "flex", alignItems: "center", gap: 8 } }, h("span", { style: { width: 44, fontSize: 12 } }, g.level), h("div", { className: "imqbp-meter", style: { flex: 1 } }, h("span", { style: { width: `${Math.round(g.activity * 100)}%` } })), h("span", { style: { fontSize: 12, fontVariantNumeric: "tabular-nums" } }, g.activity.toFixed(2))), h("div", { className: "imqbp-kv" }, h("span", null, `今日主动 ${g.todayCount}/${g.params.perDay}`), h("span", null, `本小时 ${g.hourCount}/${g.params.perHour}`), h("span", null, `最小间隔 ${g.params.minGapMin} 分钟`), h("span", null, `判断门槛 ${g.params.threshold}`), h("span", null, `复读概率 ${Math.round(g.params.repeatProb * 100)}%`), h("span", null, `上次主动 ${fmtClock(g.lastProactiveAt)}`)), h("div", { className: "imqbp-kv" }, h("span", null, `累计判断 ${s.judged ?? 0}`), h("span", null, `插话 ${s.texts ?? 0}`), h("span", null, `表情包 ${s.stickers ?? 0}`), h("span", null, `复读 ${s.repeats ?? 0}`), h("span", null, `被接话 ${s.positive ?? 0}`), h("span", null, `没人理 ${s.ignored ?? 0}`)), g.profile ? h("div", { className: "imqbp-kv", style: { color: "var(--dsw-alias-label-primary)" } }, h("span", null, `群档案：${g.profile.summary}`), (g.profile.memes ?? []).length ? h("span", null, `群梗：${g.profile.memes.join("、")}`) : null) : null, h("div", { className: "imqb3-toolbar", style: { padding: 0 } }, h("button", { type: "button", className: "imqb3-btn imqb3-btn--ghost", onClick: () => setShowLog((v) => !v) }, showLog ? "收起决策日志" : `决策日志（${g.log.length}）`), h("span", { className: "imqb3-spacer" }), h("button", { type: "button", className: "imqb3-btn", disabled: busy, onClick: () => onAction({ action: "profile", groupOpenid: g.groupOpenid }) }, "生成群档案"), h("button", { type: "button", className: "imqb3-btn", disabled: busy, onClick: () => onAction({ action: "reset", groupOpenid: g.groupOpenid }) }, "重置为安静")), showLog ? h("ul", { className: "imqbp-log" }, g.log.length === 0 ? h("li", null, "暂无记录") : g.log.map((l, i) => h("li", { key: i }, h("time", null, fmtClock(l.at)), h("span", { className: `k-${l.kind}`, style: { flex: "none", width: 40 } }, KIND_LABEL[l.kind] ?? l.kind), h("span", null, l.text + (l.times > 1 ? ` ×${l.times}` : ""))))) : null);
		}
		function PulsePanel() {
			usePulseStyles();
			const h = react.createElement;
			const [data, error, load] = usePolling(PULSE_STATUS_PATH, 1e4);
			const [busy, setBusy] = (0, react.useState)(false);
			const [note, setNote] = (0, react.useState)(null);
			const act = (0, react.useCallback)((body) => {
				setBusy(true);
				postJson(PULSE_ACTION_PATH, body).then((r) => setNote({ ok: true, text: r.started === false ? "已有同类任务在运行" : "已执行" })).catch((err) => setNote({ ok: false, text: err instanceof Error ? err.message : String(err) })).finally(() => {
					setBusy(false);
					load();
				});
			}, [load]);
			if (data === null) return h("div", { className: "imqb3" }, h("p", { className: "imqb3-empty" }, error ? `加载失败：${error}` : "正在加载…"));
			if (!data.available) return h("div", { className: "imqb3" }, h("p", { className: "imqb3-empty" }, "水群引擎未启用"));
			return h("div", { className: "imqb3" }, h("p", { className: "imqb3-path", style: { paddingTop: 10, fontFamily: "inherit", fontSize: 12 } }, "默认安静；群友越常 @ 小喵、越常接她的话，这个群就越活跃；主动发言没人理会自动回退。每个群独立，无需手动设置。"), h("div", { className: "imqb3-summary" }, h("div", { className: "imqb3-stat" }, h("span", { className: "imqb3-stat-value" }, data.enabled ? (data.asleep ? "睡觉" : "运行") : "停用"), h("span", { className: "imqb3-stat-label" }, "状态")), h("div", { className: "imqb3-stat" }, h("span", { className: "imqb3-stat-value" }, (data.groups ?? []).length), h("span", { className: "imqb3-stat-label" }, "群")), h("div", { className: "imqb3-stat" }, h("span", { className: "imqb3-stat-value" }, data.stickers?.usable ?? 0), h("span", { className: "imqb3-stat-label" }, "可用表情包"))), !data.enabled && data.reason ? h("p", { className: "imqb3-note imqb3-note--error" }, data.reason) : null, h("div", { className: "imqbp-kv" }, h("span", null, `判断模型：${data.judgeRoute ? `${data.judgeRoute.provider}/${data.judgeRoute.model}` : "首次判断时自动选择"}`), h("span", null, `夜间维护：${data.lastNightly || "尚未运行"}`), (data.running ?? []).length ? h("span", null, `运行中：${data.running.join("、")}`) : null), note ? h("p", { className: note.ok ? "imqb3-note" : "imqb3-note imqb3-note--error" }, note.text) : null, (data.groups ?? []).length === 0 ? h("p", { className: "imqb3-empty" }, "还没有群消息") : data.groups.map((g) => h(PulseGroupCard, { key: g.groupOpenid, g, onAction: act, busy })));
		}
		function StickerPanel() {
			usePulseStyles();
			const h = react.createElement;
			const [data, error, load] = usePolling(STICKERS_LIST_PATH, 3e4);
			const [filter, setFilter] = (0, react.useState)("all");
			const [query, setQuery] = (0, react.useState)("");
			const [harvestQ, setHarvestQ] = (0, react.useState)("");
			const [note, setNote] = (0, react.useState)(null);
			const [busy, setBusy] = (0, react.useState)(false);
			const update = (0, react.useCallback)((id, action) => {
				if (action === "delete" && !window.confirm("删除这张表情包？")) return;
				postJson(STICKERS_UPDATE_PATH, { id, action }).catch((err) => setNote({ ok: false, text: err instanceof Error ? err.message : String(err) })).finally(load);
			}, [load]);
			const run = (0, react.useCallback)((body, text) => {
				setBusy(true);
				postJson(PULSE_ACTION_PATH, body).then((r) => setNote({ ok: true, text: r.started === false ? "已有同类任务在运行" : text })).catch((err) => setNote({ ok: false, text: err instanceof Error ? err.message : String(err) })).finally(() => {
					setBusy(false);
					setTimeout(load, 3e3);
				});
			}, [load]);
			if (data === null) return h("div", { className: "imqb3" }, h("p", { className: "imqb3-empty" }, error ? `加载失败：${error}` : "正在加载…"));
			const st = data.stats ?? {};
			const q = query.trim();
			const list = (data.stickers ?? []).filter((e) => {
				if (filter === "usable" && !(e.enabled && e.tagged && e.isSticker !== false && e.hasFile)) return false;
				if (filter === "untagged" && e.tagged) return false;
				if (filter === "disabled" && e.enabled) return false;
				if (filter === "web" && e.source !== "web") return false;
				if (filter === "group" && e.source !== "group") return false;
				if (q && ![e.emotion, e.desc, e.text, ...(e.tags ?? [])].some((x) => x && String(x).includes(q))) return false;
				return true;
			});
			const shown = list.slice(0, 240);
			return h("div", { className: "imqb3" }, h("div", { className: "imqb3-summary" }, [["总数", st.max ? `${st.total} / ${st.max}` : st.total], ["可用", st.usable], ["待打标签", st.untagged], ["群友收集", st.group], ["网上搜集", st.web], ["已发送", st.sent]].map(([k, v]) => h("div", { key: k, className: "imqb3-stat" }, h("span", { className: "imqb3-stat-value" }, v ?? 0), h("span", { className: "imqb3-stat-label" }, k)))), h("p", { className: "imqb3-path", style: { fontFamily: "inherit", fontSize: 12 } }, "群友发的表情包会自动收集（库满就不再收）。为省 token，打标签统一放在每晚睡觉时做；每两周按「最近最少使用」踢掉一批旧图、再去网上搜新的补上。未打标签和已停用的不会被小喵使用。"), h("div", { className: "imqb3-toolbar" }, h("select", { className: "imqb3-select", value: filter, onChange: (e) => setFilter(e.target.value) }, [["all", "全部"], ["usable", "可用"], ["untagged", "待打标签"], ["disabled", "已停用"], ["group", "群友收集"], ["web", "网上搜集"]].map(([v, l]) => h("option", { key: v, value: v }, l))), h("input", { className: "imqbp-input", placeholder: "按情绪/标签筛选", value: query, onChange: (e) => setQuery(e.target.value), style: { width: 130 } }), h("span", { className: "imqb3-spacer" }), h("button", { type: "button", className: "imqb3-btn", disabled: busy, onClick: () => run({ action: "tag" }, "已开始打标签，稍后刷新") }, "立即打标签")), h("div", { className: "imqb3-toolbar", style: { paddingTop: 0 } }, h("input", { className: "imqbp-input", placeholder: "网上搜集关键词，如 甘城猫猫表情包", value: harvestQ, onChange: (e) => setHarvestQ(e.target.value), style: { flex: 1 } }), h("button", { type: "button", className: "imqb3-btn", disabled: busy, onClick: () => run({ action: "harvest", query: harvestQ }, "已开始网上搜集（约 1~3 分钟），完成后自动出现在下方") }, "去网上搜一批")), note ? h("p", { className: note.ok ? "imqb3-note" : "imqb3-note imqb3-note--error" }, note.text) : null, error ? h("p", { className: "imqb3-note imqb3-note--error" }, error) : null, list.length === 0 ? h("p", { className: "imqb3-empty" }, "还没有表情包——群友发表情包后会自动出现在这里") : h("div", { className: "imqbp-grid" }, shown.map((e) => h("div", { key: e.id, className: "imqbp-st", "data-off": String(!e.enabled || e.isSticker === false), title: `${e.desc ?? ""}${e.text ? `\n文字：${e.text}` : ""}\n来源：${e.source === "web" ? `网上（${e.keyword ?? ""}）` : `群友 ${(e.senders ?? []).join("、")}`}\n出现 ${e.seenCount} 次 · 发送 ${e.sentCount} 次${e.tagError ? `\n打标签失败：${e.tagError}` : ""}` }, e.hasFile ? h("img", { src: `${STICKERS_FILE_PATH}?id=${e.id}`, loading: "lazy", alt: e.desc ?? "" }) : h("div", { className: "ph" }, "下载中"), h("div", null, h("b", null, e.tagged ? (e.isSticker === false ? "非表情包" : e.emotion) : "待打标签"), h("span", { style: { color: "var(--dsw-alias-label-tertiary)" } }, ` · ${e.source === "web" ? "网" : "群"}${e.seenCount > 1 ? ` ×${e.seenCount}` : ""}`)), h("div", { className: "imqbp-tags" }, (e.tags ?? []).join(" / ") || e.desc || ""), h("div", { className: "imqbp-st-actions" }, h("button", { type: "button", className: "imqb3-btn", onClick: () => update(e.id, e.enabled ? "disable" : "enable") }, e.enabled ? "停用" : "启用"), h("button", { type: "button", className: "imqb3-btn", onClick: () => update(e.id, "retag") }, "重标"), h("button", { type: "button", className: "imqb3-btn imqb3-btn--danger", onClick: () => update(e.id, "delete") }, "删"))))), list.length > shown.length ? h("p", { className: "imqb3-path" }, `仅显示前 ${shown.length} 张，共 ${list.length} 张`) : null);
		}
		const GROUPS_PATH = "/qqbot/im-qqbot/groups";
		const GROUP_PROMPT_TEMPLATES = [
			["技术答疑", "你在这个群主要负责技术答疑：群友问编程/AI/工具问题时认真、准确地回答，给出可执行的步骤或代码；闲聊时少说话，不主动水群。"],
			["闲聊水群", "这是个闲聊群，你就是普通群友：轻松、俏皮，多接梗、多用表情包，不要说教，回答尽量简短。"],
			["群管助手", "你在这个群当群管助手：提醒群规、回答新人关于本群的问题、整理群公告；语气友好但正式一些，少开玩笑。"]
		];
		const STYLE_ID_GM = "im-qqbot-groupmgr-styles";
		function useGroupMgrStyles() {
			(0, react.useEffect)(() => {
				if (typeof document === "undefined" || document.getElementById(STYLE_ID_GM) !== null) return;
				const style = document.createElement("style");
				style.id = STYLE_ID_GM;
				style.textContent = `
.imqbg-card { padding: 12px 0; border-top: 0.5px solid var(--dsw-alias-border-l2, rgba(128,128,128,.25)); display: flex; flex-direction: column; gap: 8px; }
.imqbg-head { display: flex; align-items: baseline; gap: 8px; flex-wrap: wrap; }
.imqbg-title { font-weight: 600; font-size: 14px; }
.imqbg-sub { font-size: 11px; color: var(--dsw-alias-label-tertiary); font-family: var(--dsw-font-mono, ui-monospace, monospace); word-break: break-all; }
.imqbg-chip { font-size: 11px; padding: 1px 6px; border-radius: 4px; background: var(--dsw-alias-interactive-bg-hover, rgba(128,128,128,.15)); color: var(--dsw-alias-label-secondary); }
.imqbg-chip--warn { color: var(--dsw-alias-state-error-primary, #e5484d); }
.imqbg-stats { display: grid; grid-template-columns: repeat(auto-fill, minmax(84px, 1fr)); gap: 6px; }
.imqbg-stat { display: flex; flex-direction: column; padding: 6px 8px; border-radius: var(--dsw-radius-md, 8px); background: var(--dsw-alias-interactive-bg-hover, rgba(128,128,128,.06)); }
.imqbg-stat b { font-size: 15px; font-variant-numeric: tabular-nums; }
.imqbg-stat span { font-size: 11px; color: var(--dsw-alias-label-tertiary); }
.imqbg-spark { display: flex; align-items: flex-end; gap: 3px; height: 34px; }
.imqbg-spark i { flex: 1; min-height: 2px; border-radius: 2px 2px 0 0; background: var(--dsw-alias-state-business-primary, #4d6bfe); opacity: .75; }
.imqbg-spark i[data-today='true'] { opacity: 1; }
.imqbg-kv { display: flex; flex-wrap: wrap; gap: 4px 12px; font-size: 12px; color: var(--dsw-alias-label-secondary); }
.imqbg-sec { display: flex; flex-direction: column; gap: 6px; padding: 8px 10px; border-radius: var(--dsw-radius-md, 8px); border: 0.5px solid var(--dsw-alias-border-l2, rgba(128,128,128,.25)); }
.imqbg-sec-title { font-size: 12px; font-weight: 600; display: flex; align-items: center; gap: 8px; }
.imqbg-hint { font-size: 11px; color: var(--dsw-alias-label-tertiary); margin: 0; }
.imqbg-row { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
.imqbg-mem { display: flex; gap: 8px; align-items: flex-start; font-size: 12px; padding: 3px 0; }
.imqbg-mem p { flex: 1; margin: 0; line-height: 1.5; word-break: break-word; }
.imqbg-mem small { color: var(--dsw-alias-label-tertiary); flex: none; }
.imqbg-textarea { height: auto !important; min-height: 90px; padding: 8px !important; resize: vertical; line-height: 1.5; width: 100%; box-sizing: border-box; }
.imqbg-summary { display: grid; grid-template-columns: repeat(auto-fill, minmax(100px, 1fr)); gap: 8px; padding: 10px 0; }
`;
				document.head.appendChild(style);
			}, []);
		}
		const fmtNum = (n) => Number(n || 0).toLocaleString();
		function GroupMemorySection({ g, max, send, busy }) {
			const h = react.createElement;
			const [text, setText] = (0, react.useState)("");
			const [editId, setEditId] = (0, react.useState)(null);
			const [editText, setEditText] = (0, react.useState)("");
			const mems = g.memories ?? [];
			const BY = { owner: "主人", panel: "面板", member: "群友" };
			return h("div", { className: "imqbg-sec" }, h("div", { className: "imqbg-sec-title" }, `群记忆（${mems.length}/${max}）`, h("span", { className: "imqb3-spacer" }), mems.length ? h("button", { type: "button", className: "imqb3-btn imqb3-btn--ghost imqb3-btn--danger", disabled: busy, onClick: () => {
				if (window.confirm(`清空这个群的 ${mems.length} 条记忆？`)) send({ memory: { op: "clear" } }, "已清空群记忆");
			} }, "清空") : null), h("p", { className: "imqbg-hint" }, "小喵会把群规、约定、群友的称呼和偏好、有人让她「记住」的事记在这里，每轮都会看到。你也可以手动增删改。"), mems.length === 0 ? h("p", { className: "imqbg-hint" }, "（还没有记忆）") : mems.map((m) => editId === m.id ? h("div", { key: m.id, className: "imqbg-row" }, h("input", { className: "imqbp-input", style: { flex: 1 }, value: editText, maxLength: 300, onChange: (e) => setEditText(e.target.value) }), h("button", { type: "button", className: "imqb3-btn", disabled: busy || !editText.trim(), onClick: () => {
				send({ memory: { op: "update", id: m.id, text: editText } }, "已修改");
				setEditId(null);
			} }, "保存"), h("button", { type: "button", className: "imqb3-btn imqb3-btn--ghost", onClick: () => setEditId(null) }, "取消")) : h("div", { key: m.id, className: "imqbg-mem" }, h("p", null, m.text), h("small", null, `${BY[m.by] ?? m.by} · ${fmtClock(m.at)}`), h("button", { type: "button", className: "imqb3-btn imqb3-btn--ghost", disabled: busy, onClick: () => {
				setEditId(m.id);
				setEditText(m.text);
			} }, "改"), h("button", { type: "button", className: "imqb3-btn imqb3-btn--ghost imqb3-btn--danger", disabled: busy, onClick: () => send({ memory: { op: "remove", id: m.id } }, "已删除") }, "删"))), h("div", { className: "imqbg-row" }, h("input", { className: "imqbp-input", style: { flex: 1 }, maxLength: 300, placeholder: "新增一条记忆，例如：群主是阿杰，大家叫他杰哥", value: text, onChange: (e) => setText(e.target.value), onKeyDown: (e) => {
				if (e.key === "Enter" && text.trim()) {
					send({ memory: { op: "add", text } }, "已记住");
					setText("");
				}
			} }), h("button", { type: "button", className: "imqb3-btn", disabled: busy || !text.trim(), onClick: () => {
				send({ memory: { op: "add", text } }, "已记住");
				setText("");
			} }, "添加")));
		}
		const routeText = (r) => r?.provider && r?.model ? `${r.provider}/${r.model}` : "";
		const modelLabel = (models, r) => {
			if (!r?.provider) return "";
			const grp = (models?.groups ?? []).find((x) => x.provider === r.provider);
			const m = grp?.models?.find((x) => x.id === r.model);
			return m?.name && m.name !== m.id ? m.name : r.model;
		};
		/** 模型下拉：按分组列出；value 为 route 或 null（跟随上一级默认） */
		function ModelSelect({ models, value, defaultText, disabled, onChange, style }) {
			const h = react.createElement;
			const groups = models?.groups ?? [];
			const cur = value?.provider && value?.model ? `${value.provider}\u0000${value.model}` : "";
			const known = !cur || groups.some((g) => g.provider === value.provider && g.models.some((m) => m.id === value.model));
			return h("select", {
				className: "imqbp-input",
				style: { flex: 1, minWidth: 220, ...(style ?? {}) },
				value: cur,
				disabled,
				onChange: (e) => {
					const v = e.currentTarget.value;
					if (!v) onChange(null);
					else {
						const [provider, model] = v.split("\u0000");
						onChange({ provider, model });
					}
				}
			}, h("option", { value: "" }, defaultText), known ? null : h("option", { value: cur }, `${routeText(value)}（当前不在可用列表）`), groups.map((g) => h("optgroup", { key: g.provider, label: `${g.label}${g.label !== g.provider ? ` · ${g.provider}` : ""}（${g.models.filter((m) => !m.bad).length}/${g.models.length} 可用）` }, g.models.map((m) => h("option", { key: m.id, value: `${g.provider}\u0000${m.id}` }, `${m.name ?? m.id}${m.name && m.name !== m.id ? `  ·  ${m.id}` : ""}${m.vision ? "  [看图]" : ""}${m.bad ? "（暂时限流 / 不可用）" : ""}`)))));
		}
		function GroupManageCard({ g, meta, onSaved, models }) {
			const h = react.createElement;
			const [open, setOpen] = (0, react.useState)(false);
			const [name, setName] = (0, react.useState)(g.name || g.official?.name || "");
			const [number, setNumber] = (0, react.useState)(g.number);
			const [prompt, setPrompt] = (0, react.useState)(g.prompt);
			const LV = [["minute", "rateLimit", "每分钟", meta.rateMax], ["hour", "rateHour", "每小时", 1e5], ["day", "rateDay", "每天", 1e5]];
			const [rates, setRates] = (0, react.useState)(() => Object.fromEntries(LV.map(([k]) => [k, { custom: g.rate?.customs?.[k] === true, text: String(g.rate?.limits?.[k] ?? meta.defaultLimits[k]) }])));
			const setRateLv = (k, patch) => setRates((o) => ({ ...o, [k]: { ...o[k], ...patch } }));
			const [busy, setBusy] = (0, react.useState)(false);
			const [note, setNote] = (0, react.useState)(null);
			const send = (body, okText) => {
				setBusy(true);
				setNote(null);
				return postJson(GROUPS_PATH, { groupOpenid: g.groupOpenid, ...body }).then(() => {
					setNote({ ok: true, text: okText });
					onSaved();
				}).catch((err) => setNote({ ok: false, text: err instanceof Error ? err.message : String(err) })).finally(() => setBusy(false));
			};
			const rateDiff = {};
			let rateValid = true;
			for (const [k, key, , max] of LV) {
				const st = rates[k];
				const n = Number(st.text);
				if (st.custom && !(/^\d+$/.test(st.text.trim()) && n <= max)) rateValid = false;
				const orig = g.rate?.customs?.[k] ? g.rate.limits[k] : null;
				const nv = st.custom ? n : null;
				if (nv !== orig) rateDiff[key] = nv;
			}
			const dirty = name !== g.name || number !== g.number || prompt !== g.prompt || Object.keys(rateDiff).length > 0;
			const save = () => {
				const body = {};
				if (name !== g.name) body.name = name;
				if (number !== g.number) body.number = number;
				if (prompt !== g.prompt) body.prompt = prompt;
				Object.assign(body, rateDiff);
				send(body, body.prompt !== undefined ? "已保存。旧对话里的说话习惯可能会带偏新人设，建议点上面的「清空上下文」重来" : "已保存，下一条消息起生效（无需重载）");
			};
			const ctl = g.controls ?? {};
			const PRO = [["normal", "正常"], ["less", "少说"], ["more", "多说"], ["off", "关闭"]];
			const quietLeft = ctl.quietUntil ? Math.max(1, Math.round((ctl.quietUntil - Date.now()) / 6e4)) : 0;
			const daily = g.daily ?? [];
			const peak = Math.max(1, ...daily);
			const s = g.bot?.stats ?? {};
			const lim = g.rate?.limits ?? meta.defaultLimits;
			const used = g.rate?.used ?? { minute: 0, hour: 0, day: 0 };
			const cd = g.rate?.cooldown;
			const cdLeft = cd ? Math.max(1, Math.ceil((cd.until - Date.now()) / 6e4)) : 0;
			const cdText = cd ? `CD 中：${({ minute: "每分钟", hour: "每小时", day: "今日" })[cd.level]}额度已满，${cdLeft >= 60 ? `${Math.floor(cdLeft / 60)} 小时 ${cdLeft % 60} 分` : `${cdLeft} 分钟`}后恢复` : "";
			const quotaBar = (k, label) => {
				const L = lim[k];
				const u = used[k] ?? 0;
				const pct = L ? Math.min(100, Math.round(u / L * 100)) : 0;
				const color = !L ? "var(--dsw-alias-label-tertiary)" : pct >= 100 ? "var(--dsw-alias-state-danger-primary, #e5484d)" : pct >= 80 ? "var(--dsw-alias-state-warning-primary, #f5a524)" : "var(--dsw-alias-state-success-primary, #30a46c)";
				return h("div", { key: k, style: { flex: 1, minWidth: 120, display: "flex", flexDirection: "column", gap: 3 } }, h("div", { style: { display: "flex", justifyContent: "space-between", fontSize: 12 } }, h("span", { style: { color: "var(--dsw-alias-label-secondary)" } }, label), h("b", { style: { fontVariantNumeric: "tabular-nums" } }, `${u} / ${L ? L : "不限"}`)), h("div", { style: { height: 6, borderRadius: 3, background: "var(--dsw-alias-fill-l2, rgba(128,128,128,.18))", overflow: "hidden" } }, h("div", { style: { width: `${L ? Math.max(pct, u ? 3 : 0) : 0}%`, height: "100%", background: color, transition: "width .3s" } })));
			};
			const mi = g.model ?? {};
			const inherit = meta.allGroupsModel ?? meta.fallbackModel;
			const usingFallback = mi.active && mi.route && routeText(mi.active) !== routeText(mi.route);
			const modelBlock = h("div", { className: "imqbg-sec", style: { gap: 4 } }, h("div", { className: "imqbg-row" }, h("span", { style: { fontSize: 12, color: "var(--dsw-alias-label-secondary)", minWidth: 36 } }, "模型"), h(ModelSelect, {
				models,
				value: mi.override,
				disabled: busy || !models,
				defaultText: `跟随所有群默认${inherit ? `（${modelLabel(models, inherit)}）` : ""}`,
				onChange: (route) => send({ model: route }, route ? `已切换到 ${modelLabel(models, route)}，对话历史保留` : "已恢复为跟随所有群默认")
			}), h("button", {
				type: "button",
				className: "imqb3-btn imqb3-btn--ghost imqb3-btn--danger",
				disabled: busy,
				title: "丢掉本群的对话历史，下一条消息开新会话（群记忆、群档案、群人设都保留）",
				onClick: () => window.confirm("清空本群的对话上下文？下一条消息开始从头聊（群记忆和群人设不受影响）") && send({ reset: true }, "已清空上下文，下一条消息起按当前人设重新开始")
			}, "清空上下文")), h("span", { className: "imqbg-hint" }, mi.source === "peer" ? "本群单独设置" : mi.source === "scope" ? "跟随所有群默认" : "跟随插件 / 宿主默认", usingFallback ? ` · 原模型暂不可用，当前临时用同组替补 ${modelLabel(models, mi.active)}` : "", !models ? " · 模型列表加载中…" : ""));
			const quotaBlock = h("div", { className: "imqbg-sec", style: { gap: 6 } }, h("div", { className: "imqbg-row", style: { gap: 12 } }, quotaBar("minute", "本分钟回复"), quotaBar("hour", "近 1 小时"), quotaBar("day", "今日回复")), cd ? h("span", { className: "imqbg-chip imqbg-chip--warn", style: { alignSelf: "flex-start" } }, cdText) : null);
			return h("div", { className: "imqbg-card" }, h("div", { className: "imqbg-head" }, g.registered ? h(react.Fragment, null, h("span", { className: "imqbg-title" }, g.name || "（未填群名）"), g.number ? h("span", { className: "imqbg-chip" }, `群号 ${g.number}`) : null, g.official ? h("span", { className: "imqbg-chip" }, `${g.official.members} 人`) : null) : h("span", { className: "imqbg-title imqbg-sub", style: { fontSize: 13, color: "var(--dsw-alias-label-primary)" } }, g.groupOpenid), g.prompt ? h("span", { className: "imqbg-chip" }, "专属职责") : null, (g.memories ?? []).length ? h("span", { className: "imqbg-chip" }, `记忆 ${g.memories.length}`) : null, h("span", { className: "imqbg-chip", title: "每分钟 / 每小时 / 每天 回复上限" }, `额度 ${[lim.minute, lim.hour, lim.day].map((x) => x || "∞").join(" / ")}${Object.values(g.rate?.customs ?? {}).some(Boolean) ? "" : "（默认）"}`), cd ? h("span", { className: "imqbg-chip imqbg-chip--warn" }, `CD ${cdLeft} 分`) : null, g.rate?.limitedToday ? h("span", { className: "imqbg-chip imqbg-chip--warn" }, `今日被限 ${g.rate.limitedToday} 次`) : null, ctl.proactive && ctl.proactive !== "normal" ? h("span", { className: "imqbg-chip" }, `主动插话：${({ less: "少说", more: "多说", off: "关闭" })[ctl.proactive]}`) : null, quietLeft ? h("span", { className: "imqbg-chip" }, `安静中 ${quietLeft} 分钟`) : null, g.botRole ? h("span", { className: "imqbg-chip" }, `机器人：${ROLE_TEXT[g.botRole] ?? g.botRole}`) : null, mi.route ? h("span", { className: usingFallback ? "imqbg-chip imqbg-chip--warn" : "imqbg-chip", title: routeText(mi.active ?? mi.route) }, `模型 ${modelLabel(models, mi.active ?? mi.route)}${mi.source === "peer" ? "" : "（默认）"}`) : null, h("span", { className: "imqb3-spacer" }), h("button", { type: "button", className: "imqb3-btn", onClick: () => setOpen((v) => !v) }, open ? "收起" : "管理")), g.registered ? h("span", { className: "imqbg-sub" }, g.groupOpenid) : h("span", { className: "imqbg-hint" }, g.official ? `未登记 · QQ 官方群名「${g.official.name}」（${g.official.members} 人）——点「管理」填写群昵称和群号` : "未登记：点「管理」填写群名和群号后，这里会显示群名"), h("div", { className: "imqbg-stats" }, h("div", { className: "imqbg-stat" }, h("b", null, fmtNum(g.count)), h("span", null, "总消息")), h("div", { className: "imqbg-stat" }, h("b", null, fmtNum(g.today)), h("span", null, "今日")), h("div", { className: "imqbg-stat" }, h("b", null, fmtNum(g.week)), h("span", null, "近 7 天")), h("div", { className: "imqbg-stat" }, h("b", null, fmtNum(g.users)), h("span", null, "发言人数")), h("div", { className: "imqbg-stat" }, h("b", null, fmtNum(used.day ?? 0)), h("span", null, "今日小喵回复")), h("div", { className: "imqbg-stat" }, h("b", null, fmtClock(g.lastAt)), h("span", null, "最后活跃"))), modelBlock, quotaBlock, h("div", { className: "imqbg-kv" }, (g.topSenders ?? []).length ? h("span", null, `话痨榜：${g.topSenders.map((u) => `${u.name} ${u.count}`).join("、")}`) : null, g.bot ? h("span", null, `活跃度 ${g.bot.level}（${Number(g.bot.activity).toFixed(2)}）`) : null, g.bot ? h("span", null, `小喵今日主动 ${g.bot.todayProactive} · 累计插话 ${s.texts ?? 0} · 表情包 ${s.stickers ?? 0}`) : null, g.rate?.limitedTotal ? h("span", null, `启动以来被限 ${g.rate.limitedTotal} 次`) : null), open ? h(react.Fragment, null, h("div", { className: "imqbg-sec" }, h("div", { className: "imqbg-sec-title" }, "登记"), h("div", { className: "imqbg-row" }, h("input", { className: "imqbp-input", style: { flex: 1, minWidth: 140 }, placeholder: "群昵称", value: name, onChange: (e) => setName(e.target.value) }), h("input", { className: "imqbp-input", style: { width: 140 }, placeholder: "群号", value: number, onChange: (e) => setNumber(e.target.value.replace(/\D/g, "")) }))), h("div", { className: "imqbg-sec" }, h("div", { className: "imqbg-sec-title" }, "回复额度"), LV.map(([k, , label]) => h("div", { key: k, className: "imqbg-row" }, h("label", { className: "imqbg-row", style: { gap: 4, fontSize: 12, minWidth: 190 } }, h("input", { type: "checkbox", checked: !rates[k].custom, onChange: (e) => setRateLv(k, { custom: !e.target.checked }) }), `${label}跟随默认（${meta.defaultLimits[k] === 0 ? "不限" : `${meta.defaultLimits[k]} 次`}）`), rates[k].custom ? h(react.Fragment, null, h("input", { className: "imqbp-input", style: { width: 90 }, inputMode: "numeric", value: rates[k].text, onChange: (e) => setRateLv(k, { text: e.target.value.replace(/\D/g, "") }) }), h("span", { style: { fontSize: 12 } }, `次 / ${label.slice(1)}（0 = 不限）`)) : null)), h("p", { className: "imqbg-hint" }, "被 @ / 唤起和水群主动插话都计数。任一档用完就进入 CD：小喵不再调用模型，只回一句带剩余时间的提示（同一档 CD 内只提示一次），省 token。主人发的消息不受限、也不占额度；私聊不限。每天的额度 0 点重置。提示语在「绑定与配置」里改。")), h("div", { className: "imqbg-sec" }, h("div", { className: "imqbg-sec-title" }, "主动插话"), h("div", { className: "imqbg-row" }, PRO.map(([v, label]) => h("button", { key: v, type: "button", className: (ctl.proactive ?? "normal") === v ? "imqb3-btn" : "imqb3-btn imqb3-btn--ghost", disabled: busy, onClick: () => send({ proactive: v }, `主动插话：${label}`) }, label)), h("span", { className: "imqb3-spacer" }), quietLeft ? h("button", { type: "button", className: "imqb3-btn imqb3-btn--ghost", disabled: busy, onClick: () => send({ quietMinutes: 0 }, "已结束安静模式") }, `结束安静（剩 ${quietLeft} 分）`) : [30, 120, 480].map((m) => h("button", { key: m, type: "button", className: "imqb3-btn imqb3-btn--ghost", disabled: busy, onClick: () => send({ quietMinutes: m }, `安静 ${m} 分钟`) }, `安静 ${m >= 60 ? `${m / 60} 小时` : `${m} 分钟`}`))), h("p", { className: "imqbg-hint" }, "只影响水群时的主动插话频率（少说 = 频率减半、多说 = 加倍、关闭 = 不主动说话）；被 @ 或用唤起前缀时照常回复。群友也可以直接说「小喵安静一会儿」。")), h("div", { className: "imqbg-sec" }, h("div", { className: "imqbg-sec-title" }, "专属职责（群 prompt）", h("span", { className: "imqb3-spacer" }), h("span", { className: "imqbg-hint" }, `${prompt.length}/${meta.max}`)), h("textarea", { className: "imqbp-input imqbg-textarea", maxLength: meta.max, placeholder: "小喵在这个群的职责 / 角色 / 语气。例如：你在这个群负责技术答疑，回答要准确，少水群。", value: prompt, onChange: (e) => setPrompt(e.target.value) }), h("div", { className: "imqbg-row" }, h("span", { className: "imqbg-hint" }, "模板："), GROUP_PROMPT_TEMPLATES.map(([label, text]) => h("button", { key: label, type: "button", className: "imqb3-btn imqb3-btn--ghost", onClick: () => setPrompt(prompt ? `${prompt}\n${text}` : text) }, label)))), h("div", { className: "imqb3-toolbar", style: { padding: 0 } }, note ? h("p", { className: note.ok ? "imqb3-note" : "imqb3-note imqb3-note--error" }, note.text) : null, h("span", { className: "imqb3-spacer" }), h("button", { type: "button", className: "imqb3-btn", disabled: busy || !dirty || !rateValid, onClick: save }, busy ? "保存中…" : "保存登记 / 额度 / 职责")), h(GroupMemorySection, { g, max: meta.memoryMax, send, busy }), h("div", { className: "imqb3-toolbar", style: { padding: 0 } }, h("span", { className: "imqb3-spacer" }), h("button", { type: "button", className: "imqb3-btn imqb3-btn--danger", disabled: busy || !g.count, onClick: () => {
				if (!window.confirm(`确定删除这个群存储的 ${g.count} 条消息记录吗？（不影响群设定和记忆）`)) return;
				setBusy(true);
				postJson(MESSAGES_CLEAR_PATH, { kind: "group", id: g.groupOpenid }).then((d) => {
					setNote({ ok: true, text: `已清理 ${d.deleted} 条消息` });
					onSaved();
				}).catch((err) => setNote({ ok: false, text: err instanceof Error ? err.message : String(err) })).finally(() => setBusy(false));
			} }, "清理本群消息记录"))) : note ? h("p", { className: note.ok ? "imqb3-note" : "imqb3-note imqb3-note--error" }, note.text) : null);
		}
		function GroupManagePanel() {
			usePulseStyles();
			useGroupMgrStyles();
			const h = react.createElement;
			const [data, error, load] = usePolling(GROUPS_PATH, 1e4);
			const [models, modelsError, loadModels] = usePolling("/qqbot/im-qqbot/models", 6e4);
			const [allBusy, setAllBusy] = (0, react.useState)(false);
			const [allNote, setAllNote] = (0, react.useState)(null);
			if (data === null) return h("div", { className: "imqb3" }, h("p", { className: "imqb3-empty" }, error ? `加载失败：${error}` : "正在加载…"));
			const groups = data.groups ?? [];
			const sm = data.summary ?? {};
			const meta = { max: data.max ?? 4e3, memoryMax: data.memoryMax ?? 60, rateMax: data.rateMax ?? 600, defaultRate: data.defaultRate ?? 10, defaultLimits: data.defaultLimits ?? { minute: data.defaultRate ?? 10, hour: 100, day: 200 }, allGroupsModel: data.allGroupsModel ?? null, fallbackModel: data.fallbackModel ?? null };
			const peerCount = groups.filter((g) => g.model?.source === "peer").length;
			const setAll = (route, clearPeers) => {
				setAllBusy(true);
				setAllNote(null);
				postJson(GROUPS_PATH, { allGroupsModel: route, clearPeers }).then(() => {
					setAllNote({ ok: true, text: route ? `所有群默认已切到 ${modelLabel(models, route)}${clearPeers ? "，并清除了各群单独设置" : ""}` : "已清除所有群默认，回落到插件 / 宿主默认" });
					load();
				}).catch((err) => setAllNote({ ok: false, text: err instanceof Error ? err.message : String(err) })).finally(() => setAllBusy(false));
			};
			const modelsBar = h("div", { className: "imqbg-sec", style: { gap: 4, marginBottom: 8 } }, h("div", { className: "imqbg-sec-title" }, "所有群默认模型"), h("div", { className: "imqbg-row" }, h(ModelSelect, {
				models,
				value: meta.allGroupsModel,
				disabled: allBusy || !models,
				defaultText: `跟随插件 / 宿主默认${meta.fallbackModel ? `（${modelLabel(models, meta.fallbackModel)}）` : ""}`,
				onChange: (route) => setAll(route, false)
			}), peerCount ? h("button", { type: "button", className: "imqb3-btn imqb3-btn--ghost", disabled: allBusy || !meta.allGroupsModel, title: "清掉各群单独选的模型，全部跟随这里", onClick: () => window.confirm(`把 ${peerCount} 个单独设置过模型的群也改回跟随默认？`) && setAll(meta.allGroupsModel, true) }, `统一所有群（${peerCount} 个单独设置）`) : null, h("button", { type: "button", className: "imqb3-btn imqb3-btn--ghost", onClick: () => fetch("/qqbot/im-qqbot/models?refresh=1", { cache: "no-store" }).then(loadModels) }, "刷新列表")), allNote ? h("p", { className: allNote.ok ? "imqb3-note" : "imqb3-note imqb3-note--error" }, allNote.text) : null, h("p", { className: "imqbg-hint" }, modelsError ? `模型列表获取失败：${modelsError}` : "下面每个群也可以单独选模型（优先于这里）。切换保留对话历史；正在回复的群会等这轮说完再换。标「暂时限流 / 不可用」的模型仍可选，但可能会被自动换成同组替补。"));
			const stat = (v, label) => h("div", { className: "imqbg-stat" }, h("b", null, v), h("span", null, label));
			return h("div", { className: "imqb3" }, h("div", { className: "imqbg-summary" }, stat(fmtNum(sm.groups), "群"), stat(fmtNum(sm.groupMessages), "群消息总数"), stat(fmtNum(sm.today), "今日群消息"), stat(fmtNum(sm.week), "近 7 天"), stat(fmtNum(sm.repliesToday ?? 0), "今日小喵回复"), stat(fmtNum(sm.limitedToday), "今日被限频"), data.store ? stat(formatBytes(data.store.sizeBytes), "数据库占用") : null), h("p", { className: "imqb3-path", style: { fontFamily: "inherit", fontSize: 12 } }, "每个群独立的统计、登记、回复额度（每分钟 / 每小时 / 每天）、专属职责和群记忆。修改即时生效，不重载插件、不重置会话。未登记的群显示 openid（QQ 接口不提供群名），填写群昵称和群号后改为显示群名；主人也可以在群里直接告诉小喵。"), modelsBar, groups.length === 0 ? h("p", { className: "imqb3-empty" }, "还没有见过任何群——机器人收到群消息后会出现在这里") : groups.map((g) => h(GroupManageCard, { key: `${g.groupOpenid}:${g.name}:${g.number}:${g.prompt.length}:${JSON.stringify(g.rate?.customs)}:${JSON.stringify(g.rate?.limits)}`, g, meta, models, onSaved: load })), h("div", { className: "imqb3-section-title", style: { marginTop: 16 } }, "私聊与存储维护"), h(MessageStorePanel, { privateOnly: true }));
		}
		const CAPABILITIES_PATH = "/qqbot/im-qqbot/capabilities";
		const ROLE_TEXT = { owner: "群主", admin: "管理员", member: "普通成员" };
		/** 「能力」页：官方 + 插件能力总表、群管权限、按群探测机器人身份 */
		function CapabilitiesPanel() {
			usePulseStyles();
			useGroupMgrStyles();
			const h = react.createElement;
			const [data, error, load] = usePolling(CAPABILITIES_PATH, 6e4);
			const [groups] = usePolling(GROUPS_PATH, 6e4);
			const [gid, setGid] = (0, react.useState)("");
			const [probe, setProbe] = (0, react.useState)(null);
			const [busy, setBusy] = (0, react.useState)(false);
			const [note, setNote] = (0, react.useState)(null);
			if (data === null) return h("div", { className: "imqb3" }, h("p", { className: "imqb3-empty" }, error ? `加载失败：${error}` : "正在加载…"));
			const caps = data.capabilities ?? [];
			const glist = groups?.groups ?? [];
			const runProbe = () => {
				if (!gid) return;
				setBusy(true);
				setProbe(null);
				fetch(`${CAPABILITIES_PATH}?group=${encodeURIComponent(gid)}`, { cache: "no-store" }).then((r) => r.json()).then((d) => setProbe(d.probe ?? null)).catch((err) => setProbe({ error: String(err) })).finally(() => setBusy(false));
			};
			const setPermission = (permission) => {
				setBusy(true);
				setNote(null);
				postJson(BIND_CONFIG_PATH, { groupAdmin: { permission } }).then(() => {
					setNote({ ok: true, text: "已保存（插件已重载）" });
					setTimeout(load, 1500);
				}).catch((err) => setNote({ ok: false, text: err instanceof Error ? err.message : String(err) })).finally(() => setBusy(false));
			};
			const section = (title, list) => h("div", { className: "imqbg-sec" }, h("div", { className: "imqbg-sec-title" }, title), h("table", { style: { width: "100%", fontSize: 12, borderCollapse: "collapse" } }, h("thead", null, h("tr", { style: { textAlign: "left", color: "var(--dsw-alias-label-tertiary)" } }, h("th", { style: { padding: "4px 6px" } }, "分类"), h("th", { style: { padding: "4px 6px" } }, "能力"), h("th", { style: { padding: "4px 6px" } }, "调用方式"), h("th", { style: { padding: "4px 6px" } }, "条件 / 权限"), h("th", { style: { padding: "4px 6px" } }, "说明"))), h("tbody", null, list.map((c) => h("tr", { key: c.id, style: { borderTop: "0.5px solid var(--dsw-alias-border-l2, rgba(128,128,128,.2))", verticalAlign: "top" } }, h("td", { style: { padding: "4px 6px", whiteSpace: "nowrap" } }, c.category), h("td", { style: { padding: "4px 6px" } }, c.name), h("td", { style: { padding: "4px 6px", fontFamily: "var(--dsw-font-mono, ui-monospace, monospace)", fontSize: 11 } }, c.how), h("td", { style: { padding: "4px 6px" } }, c.requires), h("td", { style: { padding: "4px 6px", color: "var(--dsw-alias-label-secondary)" } }, c.note))))));
			const probeLine = (label, p, okText) => p ? h("div", { className: "imqbg-kv" }, h("span", { style: { minWidth: 72 } }, label), p.ok ? h("span", { style: { color: "var(--dsw-alias-state-success-primary, #30a46c)" } }, okText(p)) : h("span", { className: "imqbg-chip--warn" }, p.error)) : null;
			return h("div", { className: "imqb3" }, h("p", { className: "imqb3-path", style: { fontFamily: "inherit", fontSize: 12 } }, "小喵在 QQ 里能做的事。官方能力来自 QQ 开放平台接口（多数群管能力要求机器人是群管理员，部分接口官方仍在内邀，未开通会报 11253）；插件能力由本插件实现。机器人通过 qqbot-capabilities 技能了解这些能力。"), h("div", { className: "imqbg-sec" }, h("div", { className: "imqbg-sec-title" }, "群管操作权限"), h("div", { className: "imqbg-row" }, h("label", { className: "imqbg-row", style: { gap: 4, fontSize: 12 } }, h("input", { type: "radio", name: "imqb-perm", checked: data.permission !== "model", disabled: busy, onChange: () => setPermission("owner") }), "仅主人（主人发话时才执行禁言 / 撤回 / 踢人 / 审批 / 调频）"), h("label", { className: "imqbg-row", style: { gap: 4, fontSize: 12 } }, h("input", { type: "radio", name: "imqb-perm", checked: data.permission === "model", disabled: busy, onChange: () => setPermission("model") }), "允许小喵按本群职责自行判断（如自动禁言刷屏）")), h("p", { className: "imqbg-hint" }, "查询类操作和「安静一会儿」任何人都能让小喵做；任何情况下都不会对主人禁言、移除或拉黑。"), note ? h("p", { className: note.ok ? "imqb3-note" : "imqb3-note imqb3-note--error" }, note.text) : null), h("div", { className: "imqbg-sec" }, h("div", { className: "imqbg-sec-title" }, "检测机器人在群里的权限"), h("div", { className: "imqbg-row" }, h("select", { className: "imqbp-input", style: { flex: 1, minWidth: 200 }, value: gid, onChange: (e) => setGid(e.target.value) }, h("option", { value: "" }, "选择一个群…"), glist.map((g) => h("option", { key: g.groupOpenid, value: g.groupOpenid }, g.registered ? g.label : g.groupOpenid))), h("button", { type: "button", className: "imqb3-btn", disabled: busy || !gid, onClick: runProbe }, busy ? "检测中…" : "检测")), probe ? h("div", { style: { display: "flex", flexDirection: "column", gap: 4 } }, probe.error ? h("p", { className: "imqb3-note imqb3-note--error" }, probe.error) : null, probeLine("机器人身份", probe.botState, (p) => p.text), probeLine("群信息", probe.info, (p) => `${p.name} · ${p.members} 人`), probeLine("禁言管理", probe.mute, () => "可用（机器人是管理员）")) : h("p", { className: "imqbg-hint" }, "会实际调用 QQ 接口：查询机器人身份、群信息、禁言状态，看哪些能力在这个群可用。")), section("官方能力（QQ 开放平台）", caps.filter((c) => c.source === "official")), section("插件能力", caps.filter((c) => c.source === "plugin")));
		}
		/** 面板分页：tabs = [{ id, label, render }] */
		function TabbedPanel({ tabs }) {
			useMessageStoreStyles();
			const [active, setActive] = (0, react.useState)(tabs[0].id);
			const current = tabs.find((t) => t.id === active) ?? tabs[0];
			return (0, react.createElement)("div", null, (0, react.createElement)("div", {
				className: "imqb3-tabs",
				role: "tablist"
			}, tabs.map((t) => (0, react.createElement)("button", {
				key: t.id,
				type: "button",
				role: "tab",
				"aria-selected": t.id === current.id,
				className: "imqb3-tab",
				onClick: () => {
					setActive(t.id);
				}
			}, t.label))), (0, react.createElement)("div", { role: "tabpanel" }, current.render()));
		}
		//#endregion
		//#region src/client/index.ts
		const name = "im-qqbot-client";
		const inject = [
			"slots",
			"sidebarRight",
			"sidebarRightTabs"
		];
		/** 侧栏 Tab 类型（ui-sidebar-right 契约的局部投影） */
		const TAB_KIND = "qqbot-bind";
		/** 席位注册 key（Tab 类型 id，席位按其分发；只需全局唯一，与包名解耦） */
		const TAB_ID = "im-qqbot/bind";
		/** 绑定入口图标（QQ 机器人，跟随主题图标色变量） */
		function BindGuideIcon() {
			return (0, react.createElement)("svg", {
				width: 24,
				height: 24,
				viewBox: "0 0 24 24",
				fill: "none",
				"aria-hidden": true
			}, (0, react.createElement)("path", {
				d: "M9.50039 11.1504C9.96983 11.1504 10.3504 11.5309 10.3504 12.0004V14.0004C10.3504 14.4698 9.96983 14.8504 9.50039 14.8504C9.03095 14.8504 8.65039 14.4698 8.65039 14.0004V12.0004C8.65039 11.5309 9.03095 11.1504 9.50039 11.1504Z",
				fill: "var(------icon_primary, #1A1A1A)"
			}), (0, react.createElement)("path", {
				d: "M14.5004 11.1504C14.9698 11.1504 15.3504 11.5309 15.3504 12.0004V14.0004C15.3504 14.4698 14.9698 14.8504 14.5004 14.8504C14.0309 14.8504 13.6504 14.4698 13.6504 14.0004V12.0004C13.6504 11.5309 14.0309 11.1504 14.5004 11.1504Z",
				fill: "var(------icon_primary, #1A1A1A)"
			}), (0, react.createElement)("path", {
				fillRule: "evenodd",
				clipRule: "evenodd",
				d: "M12.8504 5.3109C13.5299 4.99138 14.0004 4.30063 14.0004 3.5C14.0004 2.39543 13.1049 1.5 12.0004 1.5C10.8958 1.5 10.0004 2.39543 10.0004 3.5C10.0004 4.30065 10.4708 4.99141 11.1504 5.31092V6.18851C6.38487 6.61795 2.65039 10.6231 2.65039 15.5004V17.0004C2.65039 19.679 4.82181 21.8504 7.50039 21.8504H16.5004C19.179 21.8504 21.3504 19.679 21.3504 17.0004V15.5004C21.3504 10.6231 17.6159 6.61795 12.8504 6.18851V5.3109ZM12.0004 7.85039C7.77541 7.85039 4.35039 11.2754 4.35039 15.5004V17.0004C4.35039 18.7401 5.76069 20.1504 7.50039 20.1504H16.5004C18.2401 20.1504 19.6504 18.7401 19.6504 17.0004V15.5004C19.6504 11.2754 16.2254 7.85039 12.0004 7.85039Z",
				fill: "var(------icon_primary, #1A1A1A)"
			}));
		}
		/** 设置页「QQ Bot」栏目：面板常驻展示绑定状态 */
		function QQBotSettingsSection() {
			return (0, react.createElement)(TabbedPanel, { tabs: [{
				id: "config",
				label: "绑定与配置",
				render: () => (0, react.createElement)("div", null, (0, react.createElement)(BindPanelBody), (0, react.createElement)(ConfigPanel))
			}, {
				id: "groups",
				label: "群聊管理",
				render: () => (0, react.createElement)(GroupManagePanel)
			}, {
				id: "caps",
				label: "能力",
				render: () => (0, react.createElement)(CapabilitiesPanel)
			}, {
				id: "pulse",
				label: "水群",
				render: () => (0, react.createElement)(PulsePanel)
			}, {
				id: "stickers",
				label: "表情包",
				render: () => (0, react.createElement)(StickerPanel)
			}] });
		}
		/** 侧栏 QQ 机器人页：绑定 / 消息存储分页 */
		function QQBotSidebarPane() {
			return (0, react.createElement)("div", { style: { padding: "0 16px" } }, (0, react.createElement)(TabbedPanel, { tabs: [{
				id: "bind",
				label: "绑定",
				render: () => (0, react.createElement)(BindPanelBody)
			}, {
				id: "groups",
				label: "群聊管理",
				render: () => (0, react.createElement)(GroupManagePanel)
			}, {
				id: "caps",
				label: "能力",
				render: () => (0, react.createElement)(CapabilitiesPanel)
			}, {
				id: "pulse",
				label: "水群",
				render: () => (0, react.createElement)(PulsePanel)
			}, {
				id: "stickers",
				label: "表情包",
				render: () => (0, react.createElement)(StickerPanel)
			}] }));
		}
		function apply(ctx) {
			const tabs = ctx.sidebarRightTabs;
			const right = ctx.sidebarRight;
			const slots = ctx.slots;
			const disposers = [];
			if (slots !== void 0) disposers.push(slots.inject("settings.section", () => slots.register({
				name: "settings.section",
				id: "qqbot",
				order: 7,
				label: "QQ 机器人"
			}, QQBotSettingsSection)));
			if (tabs !== void 0 && slots !== void 0) {
				disposers.push(tabs.register({
					id: TAB_ID,
					kind: TAB_KIND,
					title: () => "QQ 机器人",
					guide: [{
						id: "bind",
						order: 90,
						title: () => "QQ 机器人绑定",
						description: () => "扫码或手动填写，绑定 QQ 机器人",
						icon: BindGuideIcon
					}]
				}));
				disposers.push(slots.inject("sidebar.right.pane.tab", () => slots.register({
					name: "sidebar.right.pane.tab",
					key: TAB_ID
				}, QQBotSidebarPane)));
				disposers.push(watchAndPrompt(right));
			}
			ctx.effect(() => () => {
				for (const dispose of disposers.reverse()) dispose();
			}, "im-qqbot-client.binding");
		}
		/**
		* 轮询绑定状态：待绑定时自动打开绑定页。
		*
		* - 页面隐藏时降频轮询（可见时立即恢复节拍）
		* - 404（已绑定/未安装）时退避到 30s，保持低成本常驻探测
		* - 每次页面加载至多打开一次（用户手动关闭后不打扰）；
		*   打开失败（如启动早期 Session surface 尚未挂载）不消费机会，
		*   由下一轮轮询（3s）自动重试
		*/
		function watchAndPrompt(right) {
			let stopped = false;
			let opened = right === void 0;
			let timer;
			const schedule = (ms) => {
				timer = setTimeout(() => {
					tick();
				}, ms);
			};
			const tick = async () => {
				if (stopped) return;
				if (typeof document !== "undefined" && document.visibilityState === "hidden") {
					schedule(5e3);
					return;
				}
				try {
					const res = await fetch(BIND_STATE_PATH, { cache: "no-store" });
					if (res.ok) {
						if ((await res.json()).phase === "waiting" && !opened && right !== void 0) try {
							right.openTab(TAB_KIND);
							opened = true;
						} catch (err) {
							console.error("[im-qqbot] 打开绑定页失败，稍后重试", err);
						}
						schedule(3e3);
						return;
					}
					schedule(3e4);
					return;
				} catch {}
				schedule(1e4);
			};
			tick();
			return () => {
				stopped = true;
				if (timer !== void 0) clearTimeout(timer);
			};
		}
		//#endregion
		exports.apply = apply;
		exports.inject = inject;
		exports.name = name;
		return module.exports;
	}
});

