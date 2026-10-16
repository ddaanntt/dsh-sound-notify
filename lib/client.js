window.__ModuleLoader__.load({
	id: "dsh-sound-notify",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

		const React = require("react");

		/** Cordis plugin name (the host half carries `sound-notify`). */
		const name = "sound-notify-presence";
		/** Hard dependency: the slot service that tells us which sessions are on screen. */
		const inject = ["slots"];

		/** Host endpoint owned by this package's host half. */
		const PRESENCE_PATH = "/sound-notify/presence";
		/** Re-announce cadence, so a missed transition cannot leave stale state. */
		const HEARTBEAT_MS = 5000;
		/** Additive, session-scoped list slot: an invisible probe that knows the open conversations. */
		const DOCK_SLOT = "conversation.input.dock";
		const DOCK_ID = "sound-notify-presence";

		/** Stable identity for this page, so two windows never overwrite each other host-side. */
		const CLIENT_ID = "sn-" + Math.random().toString(36).slice(2) + "-" + Date.now().toString(36);

		/**
		 * Report what this page is showing: whether the window is visible and
		 * focused, and every session whose conversation is mounted. The host
		 * chimes only when no live client is displaying that session.
		 * @param ctx - plugin context with the slots service.
		 */
		function apply(ctx) {
			/** Session ids whose conversation is mounted right now, in mount order. */
			const mounted = [];

			function report() {
				let body;
				try {
					body = JSON.stringify({
						clientId: CLIENT_ID,
						visible: document.visibilityState === "visible",
						focused: typeof document.hasFocus === "function" ? document.hasFocus() : true,
						sessionIds: mounted.slice(),
						// Single-session form kept for a host half from before the
						// set-based upgrade; harmless once the host reads sessionIds.
						sessionId: mounted.length > 0 ? mounted[mounted.length - 1] : null
					});
				} catch (error) {
					return;
				}
				try {
					const pending = fetch(PRESENCE_PATH, {
						method: "POST",
						headers: { "content-type": "application/json" },
						body,
						keepalive: true
					});
					if (pending && typeof pending.catch === "function") pending.catch(() => {});
				} catch (error) {
					// The host may be restarting; the next heartbeat retries.
				}
			}

			/**
			 * Add or remove one displayed conversation and re-report.
			 * @param id - session id string.
			 * @param present - true when its conversation just mounted.
			 */
			function setMounted(id, present) {
				const index = mounted.indexOf(id);
				if (present) {
					if (index < 0) mounted.push(id);
				} else if (index >= 0) {
					mounted.splice(index, 1);
				}
				report();
			}

			ctx.effect(() => {
				const onChange = () => report();
				document.addEventListener("visibilitychange", onChange);
				window.addEventListener("focus", onChange);
				window.addEventListener("blur", onChange);
				window.addEventListener("pageshow", onChange);
				const timer = setInterval(report, HEARTBEAT_MS);
				return () => {
					document.removeEventListener("visibilitychange", onChange);
					window.removeEventListener("focus", onChange);
					window.removeEventListener("blur", onChange);
					window.removeEventListener("pageshow", onChange);
					clearInterval(timer);
				};
			}, "sound-notify: presence listeners");

			const slots = ctx.get("slots");
			if (slots === undefined) {
				ctx.logger.warn("sound-notify: the slots service is unavailable — presence will report no session");
			} else {
				slots.inject(DOCK_SLOT, () => slots.register(
					{ name: DOCK_SLOT, id: DOCK_ID },
					(props) => {
						const raw = props === undefined || props === null
							? undefined
							: props.sessionId !== undefined && props.sessionId !== null
								? props.sessionId
								: props.session && props.session.sessionId;
						const current = raw === undefined || raw === null ? null : String(raw);
						React.useEffect(() => {
							if (current === null) return undefined;
							setMounted(current, true);
							return () => setMounted(current, false);
						}, [current]);
						return null;
					},
				));
			}

			// Announce immediately so the host does not have to wait a heartbeat.
			report();
		}

		exports.apply = apply;
		exports.inject = inject;
		exports.name = name;
		return module.exports;
	}
});
