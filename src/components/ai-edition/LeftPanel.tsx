import { Loader2 } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { toast } from "sonner";
import { Tooltip } from "@/components/ui/tooltip";
import { useScopedT } from "@/contexts/I18nContext";
import {
	applyAgentDocumentIfCurrent,
	runAgentTurn,
} from "@/lib/ai-edition/store/agentDocumentApply";
import { useProjectStore } from "@/lib/ai-edition/store/projectStore";
import { useChatPromptBus } from "@/lib/ai-edition/store/useChatPromptBus";
import { nativeBridgeClient } from "@/native/client";
import type { AiEditionChatEvent, AiEditionToolCallSummary } from "@/native/contracts";
import { ChatWelcome } from "./ChatWelcome";
import { adoptStoredUserMessage } from "./chatTranscript";
import { ChatHistoryModal } from "./Modals";
import styles from "./NewEditorShell.module.css";

type ClaudeStatus = Awaited<ReturnType<typeof window.electronAPI.claudeStatus>>;

interface ChatDisplayMessage {
	id?: string;
	role: string;
	content: string;
	/** ISO timestamp, as the main process stores it; formatted only where it is drawn (#1134). */
	time?: string;
	toolCalls?: AiEditionToolCallSummary[];
	// ponytail: axcut parity — non-null on user messages that have a
	// rewind-able document snapshot, so the per-message ↩ button shows.
	checkpointId?: string | null;
	// ponytail: when an assistant message carries the model's reasoning trace
	// (Anthropic/MiniMax thinking), the chat renders it as a collapsible block
	// above the answer. Ephemeral — only present for the turn that streamed it;
	// reloading a session won't show past traces.
	thinking?: string;
}

/** "addZoom" as "add zoom". */
function humanToolName(name: string): string {
	return name.replace(/[A-Z]/g, (letter) => ` ${letter.toLowerCase()}`);
}

/** A message's clock time; a stored value that is no date is shown as stored. */
function formatMessageTime(time: string): string {
	const date = new Date(time);
	return Number.isNaN(date.getTime()) ? time : date.toLocaleTimeString();
}

const THINKING_PREVIEW_TAIL_CHARS = 240;
function ThinkingBlock({
	text,
	expanded,
	onToggle,
	label,
}: {
	text: string;
	expanded: boolean;
	onToggle: () => void;
	label: string;
}) {
	const preview =
		text.length > THINKING_PREVIEW_TAIL_CHARS
			? `…${text.slice(-THINKING_PREVIEW_TAIL_CHARS)}`
			: text;
	return (
		<button
			type="button"
			onClick={onToggle}
			aria-expanded={expanded}
			style={{
				display: "block",
				width: "100%",
				textAlign: "left",
				background: "transparent",
				border: "1px solid var(--border-soft)",
				borderRadius: "var(--r-sm)",
				padding: "6px 8px",
				marginBottom: 4,
				color: expanded ? "var(--fg-2)" : "var(--muted)",
				font: "400 12px/1.5 var(--font-body)",
				cursor: "pointer",
			}}
		>
			<div
				style={{
					display: "flex",
					alignItems: "center",
					gap: 4,
					marginBottom: expanded ? 4 : 0,
					color: "var(--muted)",
					font: "600 12px/1.3 var(--font-body)",
				}}
			>
				<svg
					width={10}
					height={10}
					viewBox="0 0 24 24"
					fill="none"
					stroke="currentColor"
					strokeWidth="2"
					strokeLinecap="round"
					strokeLinejoin="round"
					style={{
						transform: expanded ? "rotate(90deg)" : "rotate(0deg)",
						transition: "transform 120ms ease",
						flex: "0 0 auto",
					}}
					aria-hidden="true"
				>
					<polyline points="9 6 15 12 9 18" />
				</svg>
				<span>{label}</span>
			</div>
			{expanded ? (
				<div
					style={{
						maxHeight: 220,
						overflow: "auto",
						whiteSpace: "pre-wrap",
						wordBreak: "break-word",
						font: "400 12px/1.5 var(--font-body)",
					}}
				>
					{text}
				</div>
			) : (
				<div
					style={{
						display: "-webkit-box",
						WebkitLineClamp: 2,
						WebkitBoxOrient: "vertical",
						overflow: "hidden",
						whiteSpace: "pre-wrap",
						wordBreak: "break-word",
					}}
				>
					{preview}
				</div>
			)}
		</button>
	);
}

export function ChatStripPanel() {
	const t = useScopedT("editor");
	const tc = useScopedT("common");
	// The Auto-enhance confirmation is timeline-owned copy, fired from here —
	// see the prompt-bus effect below.
	const tTimeline = useScopedT("timeline");
	const projectId = useProjectStore((s) => s.projectId);
	const [messages, setMessages] = useState<ChatDisplayMessage[]>([]);
	const [input, setInput] = useState("");
	const [busy, setBusy] = useState(false);
	// Null until the first answer: unknown, not "no". Asked again when the window comes back, so
	// signing in in the browser is picked up with no restart.
	const [claude, setClaude] = useState<ClaudeStatus | null>(null);
	const canChat = claude === null || claude.signedIn;
	const refreshClaude = useCallback(async () => {
		setClaude((await window.electronAPI.claudeStatus?.()) ?? null);
	}, []);
	useEffect(() => {
		void refreshClaude();
		window.addEventListener("focus", refreshClaude);
		return () => window.removeEventListener("focus", refreshClaude);
	}, [refreshClaude]);
	const [chatsOpen, setChatsOpen] = useState(false);
	const [sessions, setSessions] = useState<
		Array<{ id: string; title: string; messageCount: number; createdAt: string }>
	>([]);
	const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
	// Mirror in a ref so refreshSessions can read the current selection without
	// listing activeSessionId in its deps — otherwise refreshSessions is recreated
	// on every selection change, which re-runs the project effect below (with
	// preferFirst=true) and forces the selection back to list[0]. That feedback
	// loop is what made "new conversation" jump to the oldest chat instead of the
	// freshly-created empty one.
	const activeSessionIdRef = useRef<string | null>(activeSessionId);
	activeSessionIdRef.current = activeSessionId;
	const scrollRef = useRef<HTMLDivElement | null>(null);
	// ponytail: live reasoning trace for the in-flight turn. Reset at send()
	// start; deltas append through the chat-event subscription; once the run
	// resolves we copy it onto the assistant message and clear it.
	const [thinkingText, setThinkingText] = useState("");
	// The tool Claude is on right now, so a long turn is not a silent spinner.
	const [activity, setActivity] = useState<string | null>(null);
	const [thinkingExpanded, setThinkingExpanded] = useState(false);
	// sessionId of the in-flight run — late events for prior runs (or for
	// other windows) are ignored so a stale stream can't pollute the new turn.
	const thinkingRunSessionRef = useRef<string | null>(null);
	// Per-message expand state for completed turns. Using a Set keeps the
	// default-collapsed preview lightweight and the click-to-expand obvious.
	const [thinkingExpandedIds, setThinkingExpandedIds] = useState<Set<string>>(() => new Set());
	const sendDisabled = busy || !input.trim() || !canChat;
	const refreshSessions = useCallback(async (pid: string, preferFirst = false) => {
		try {
			const list = await nativeBridgeClient.aiEdition.chatListSessions(pid);
			setSessions(list);
			if (list.length === 0) {
				setActiveSessionId(null);
				setMessages([]);
				return;
			}
			if (preferFirst || !list.some((s) => s.id === activeSessionIdRef.current)) {
				setActiveSessionId(list[0].id);
			}
		} catch {
			// ponytail: silent — shim mode or missing project
		}
	}, []);

	// ponytail: subscribe to streamed chat events so the reasoning trace (and
	// any future streaming text deltas) lands live instead of arriving all at
	// once when chatRun resolves. We only act on `thinking` here — text deltas
	// are ignored in the renderer today because the chat already renders the
	// final assistant text on chatRun resolve, and a parallel live stream
	// would race the final message. Add `text` handling when that flow lands.
	useEffect(() => {
		const unsubChatEvent = window.electronAPI.onAiEditionChatEvent((event: AiEditionChatEvent) => {
			if (event.sessionId !== thinkingRunSessionRef.current) return;
			if (event.kind === "thinking") setThinkingText((prev) => prev + event.delta);
			if (event.kind === "toolStart") setActivity(event.name);
		});
		return unsubChatEvent;
	}, []);

	useEffect(() => {
		if (!projectId) {
			setSessions([]);
			setActiveSessionId(null);
			setMessages([]);
			return;
		}
		void refreshSessions(projectId, true);
	}, [projectId, refreshSessions]);

	useEffect(() => {
		if (!projectId || !activeSessionId) {
			setMessages([]);
			return;
		}
		void (async () => {
			try {
				const session = await nativeBridgeClient.aiEdition.chatSelectSession(
					projectId,
					activeSessionId,
				);
				if (session) {
					setMessages(
						session.messages.map((m) => ({
							id: m.id,
							role: m.role,
							content: m.content,
							time: m.createdAt,
							toolCalls: m.toolCalls,
							checkpointId: m.checkpointId ?? null,
						})),
					);
				} else {
					setMessages([]);
				}
			} catch {
				// ponytail: silent — shim mode
			}
		})();
	}, [projectId, activeSessionId]);

	useEffect(() => {
		scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
	});

	const send = async (overrideText?: string) => {
		const text = (overrideText ?? input).trim();
		if (!projectId || !text || busy) return;
		// The composer is disabled in this state too, but Auto-enhance calls send() directly and
		// Enter can slip through.
		if (!canChat) {
			toast.error(t("chat.signInFirst"));
			return;
		}
		setInput("");
		setBusy(true);
		// ponytail: prepare the live reasoning-trace accumulator. Late events
		// from a previous run (or from another panel/window) won't match this
		// sessionId and are dropped by the subscription above.
		setThinkingText("");
		setThinkingExpanded(false);
		thinkingRunSessionRef.current = null;
		// ponytail: pre-seed the user message so the rewind ↩ button is
		// available before the server confirms. Mirrors axcut's
		// `before-message` checkpoint that runChat records in chat-service.
		const optimisticUserId = `local_${Date.now()}_u`;
		setMessages((prev) => [
			...prev,
			{
				id: optimisticUserId,
				role: "user",
				content: text,
				time: new Date().toISOString(),
				checkpointId: optimisticUserId,
			},
		]);
		try {
			// Mirror axcut's `getOrCreateSession`: the composer works with zero
			// setup, so the first message on a project with no sessions yet
			// silently starts one instead of no-op'ing.
			let sessionId = activeSessionId;
			if (!sessionId) {
				const created = await nativeBridgeClient.aiEdition.chatCreateSession(projectId);
				sessionId = created.id;
				setSessions((prev) => [...prev, created]);
				setActiveSessionId(sessionId);
			}
			// ponytail: start collecting the live reasoning trace for THIS run —
			// the subscription only appends deltas whose sessionId matches.
			thinkingRunSessionRef.current = sessionId;
			// Send the current document snapshot so the agent can run edit tools
			// against it (P1). Falls back to text-only chat when no doc is open.
			// `runAgentTurn` reads the document AND the revision it is at from one snapshot
			// before the turn starts, so a manual edit landing while the agent works is
			// detectable when its answer comes back.
			const { result, applyDocument } = await runAgentTurn((documentSnapshot) =>
				nativeBridgeClient.aiEdition.chatRun(projectId, sessionId, text, documentSnapshot),
			);
			setMessages((prev) => adoptStoredUserMessage(prev, optimisticUserId, result));
			// A rewind confirmation opened during the turn names the message too. Stored without a
			// checkpoint, the message has nothing to rewind to and the confirmation closes.
			const storedId = result.userMessageId;
			if (storedId) {
				setRewindFor((open) =>
					open?.messageId !== optimisticUserId
						? open
						: result.userMessageCheckpointId
							? { ...open, messageId: storedId }
							: null,
				);
			}
			const assistant = result.assistantMessage;
			if (result.success && assistant) {
				if (result.document) {
					const applyEdits = async (options?: { ignoreConflict?: boolean }) => {
						try {
							return await applyDocument(options);
						} catch (err) {
							// Only `ensureDocument` still throws here -- the agent handed back
							// something that is not a document. A failed WRITE does not reach this:
							// the store reports it itself and `applyDocument` answers "save-failed".
							toast.error(t("chat.applyEditsFailed"), {
								description: err instanceof Error ? err.message : String(err),
							});
							return "malformed" as const;
						}
					};
					const applyResult = await applyEdits();
					if (applyResult === "save-failed") {
						// The store has already said WHY the write failed, with the native error.
						// This says what it COST, without a description so the two do not repeat
						// each other: the assistant's "done, I removed 14 silences" renders either
						// way, so a bare save error next to it leaves the two unconnected.
						toast.error(t("chat.applyEditsFailed"));
					} else if (applyResult === "conflict") {
						// The turn is not lost, it is just not automatically applied: the document
						// is still in hand and the assistant's reply is about to be rendered as if
						// the edits had landed. The thing that usually moves `revision` here is a
						// background transcription finishing, not the user -- so dropping the whole
						// turn on the floor and blaming "the project changed" costs them a minute
						// of waiting and their tokens for something they never did. Let them take
						// it. No auto-dismiss: it is the only way back to this document.
						toast.warning(t("chat.agentEditConflict"), {
							duration: Number.POSITIVE_INFINITY,
							action: {
								label: t("chat.applyAnyway"),
								onClick: () => void applyEdits({ ignoreConflict: true }),
							},
						});
					}
				}
				setMessages((prev) => [
					...prev,
					{
						role: "assistant",
						content: assistant.content,
						time: new Date().toISOString(),
						toolCalls: assistant.toolCalls,
						// ponytail: snapshot the live reasoning trace onto the
						// finished message so it can be revisited (collapsed by
						// default, click-to-expand) instead of vanishing. The
						// live accumulator is cleared in `finally`.
						thinking: thinkingText || undefined,
					},
				]);
				void refreshSessions(projectId);
			} else {
				toast.error(result.error ?? t("chat.chatFailed"));
			}
		} catch (err) {
			toast.error(t("chat.chatFailed"), {
				description: err instanceof Error ? err.message : String(err),
			});
		} finally {
			setBusy(false);
			// ponytail: stop accepting thinking deltas and drop the in-flight
			// preview — the snapshot was either attached to the assistant
			// message above, or there's no message to attach it to (failure).
			thinkingRunSessionRef.current = null;
			setThinkingText("");
			setThinkingExpanded(false);
			setActivity(null);
		}
	};

	// Auto-send a prompt handed over by another part of the UI (e.g. the
	// timeline's Auto-enhance → "Smart zooms + cuts with AI"). Routes through
	// the normal send() so sessions/checkpoints/rewind all keep working; the
	// message shows in the composer's history exactly as if typed.
	// The confirmation toast lives here because only this side knows the prompt
	// was taken — send() bounces it to the settings modal with no provider.
	// ponytail: one producer today, so the toast copy is assumed to be its own.
	// A second producer needs the bus to carry its confirmation string.
	const pendingPrompt = useChatPromptBus((s) => s.pending);
	const consumePrompt = useChatPromptBus((s) => s.consume);
	// biome-ignore lint/correctness/useExhaustiveDependencies: send() is intentionally not a dep (recreated each render); consume() clears `pending` so this fires once per queued prompt.
	useEffect(() => {
		if (!pendingPrompt || !projectId || busy) return;
		consumePrompt();
		if (canChat) toast.success(tTimeline("toolbar.aiEnhanceRequested"));
		void send(pendingPrompt);
	}, [pendingPrompt, projectId, busy, consumePrompt, canChat, tTimeline]);

	// ponytail: per-user-message rewind. Pops a confirmation popover, then
	// asks the main process to roll the session + document back to the
	// snapshot taken right before the user hit Send. axcut parity.
	const [rewindFor, setRewindFor] = useState<{
		messageId: string;
		anchor: { left: number; bottom: number } | null;
	} | null>(null);
	const confirmRewind = useCallback(
		async (messageId: string) => {
			if (!projectId || !activeSessionId) return;
			try {
				const result = await nativeBridgeClient.aiEdition.chatRewind(
					projectId,
					activeSessionId,
					messageId,
				);
				if (!result.success) {
					toast.error(result.error ?? t("chat.rewindFailed"));
					setRewindFor(null);
					return;
				}
				const doc = (result as { document?: unknown }).document;
				// No `expectedRevision`: a rewind REPLACES whatever is live, which is what the
				// confirmation dialog now says out loud -- including any manual edit made since.
				if (doc) await applyAgentDocumentIfCurrent(doc);
				setMessages(
					result.messages.map((m) => ({
						id: m.id,
						role: m.role,
						content: m.content,
						time: m.createdAt,
						toolCalls: m.toolCalls,
						checkpointId: m.checkpointId ?? null,
					})),
				);
				setInput(result.prompt);
				toast.success(t("chat.rewoundSuccess"));
			} catch (err) {
				toast.error(t("chat.rewindFailed"), {
					description: err instanceof Error ? err.message : String(err),
				});
			} finally {
				setRewindFor(null);
			}
		},
		[projectId, activeSessionId, t],
	);

	useEffect(() => {
		if (!rewindFor) return;
		const handlePointerDown = (event: PointerEvent) => {
			const target = event.target instanceof Element ? event.target : null;
			if (target?.closest("[data-rewind-confirmation], [data-rewind-trigger]")) {
				return;
			}
			setRewindFor(null);
		};
		const handleKeyDown = (event: KeyboardEvent) => {
			if (event.key === "Escape") setRewindFor(null);
		};
		globalThis.document.addEventListener("pointerdown", handlePointerDown);
		globalThis.document.addEventListener("keydown", handleKeyDown);
		return () => {
			globalThis.document.removeEventListener("pointerdown", handlePointerDown);
			globalThis.document.removeEventListener("keydown", handleKeyDown);
		};
	}, [rewindFor]);

	const newChat = useCallback(async () => {
		if (!projectId) return;
		try {
			const created = await nativeBridgeClient.aiEdition.chatCreateSession(projectId);
			setSessions((prev) => [...prev, created]);
			setActiveSessionId(created.id);
			setMessages([]);
		} catch (err) {
			toast.error(t("chat.createSessionFailed"), {
				description: err instanceof Error ? err.message : String(err),
			});
		}
	}, [projectId, t]);

	const selectSession = useCallback((id: string) => {
		setActiveSessionId(id);
	}, []);

	const handleDelete = useCallback(
		async (id: string) => {
			if (!projectId) return;
			try {
				const res = await nativeBridgeClient.aiEdition.chatDeleteSession(projectId, id);
				if (!res.success) return;
				setSessions((prev) => prev.filter((s) => s.id !== id));
				if (activeSessionId === id) {
					setActiveSessionId(null);
					setMessages([]);
				}
			} catch (err) {
				toast.error(t("chat.deleteSessionFailed"), {
					description: err instanceof Error ? err.message : String(err),
				});
			}
		},
		[projectId, activeSessionId, t],
	);

	const handleRename = useCallback(
		async (id: string, title: string) => {
			if (!projectId) return;
			const trimmed = title.trim();
			if (!trimmed) return;
			try {
				const updated = await nativeBridgeClient.aiEdition.chatRenameSession(
					projectId,
					id,
					trimmed,
				);
				if (updated) {
					setSessions((prev) => prev.map((s) => (s.id === id ? updated : s)));
				}
			} catch (err) {
				toast.error(t("chat.renameSessionFailed"), {
					description: err instanceof Error ? err.message : String(err),
				});
			}
		},
		[projectId, t],
	);

	// ponytail: inline session rename. Click the title to edit, Enter saves,
	// Escape cancels, blur saves when the value is non-empty (axcut parity).
	const [editingSessionId, setEditingSessionId] = useState<string | null>(null);
	const [editingTitle, setEditingTitle] = useState("");
	const editingInputRef = useRef<HTMLInputElement | null>(null);
	const beginEditTitle = useCallback((id: string, currentTitle: string) => {
		setEditingSessionId(id);
		setEditingTitle(currentTitle);
	}, []);
	const cancelEditTitle = useCallback(() => {
		setEditingSessionId(null);
		setEditingTitle("");
	}, []);
	const commitEditTitle = useCallback(
		async (id: string) => {
			const next = editingTitle.trim();
			if (!next) {
				cancelEditTitle();
				return;
			}
			setEditingSessionId(null);
			await handleRename(id, next);
		},
		[editingTitle, handleRename, cancelEditTitle],
	);

	return (
		<aside className={styles.panel}>
			<div className={styles.panelHeader}>
				<div className={styles.chatStrip}>
					<div className={styles.chatStripRow}>
						<span className={styles.ctxPill}>
							<span className={styles.d} aria-hidden />
							{claude?.signedIn && claude.plan
								? t("chat.onPlan", { plan: claude.plan[0].toUpperCase() + claude.plan.slice(1) })
								: t("chat.claude")}
						</span>
						<span className={styles.stripActions}>
							<Tooltip content={t("chat.history")}>
								<button
									type="button"
									aria-label={t("chat.history")}
									onClick={() => setChatsOpen(true)}
								>
									<svg
										width={14}
										height={14}
										viewBox="0 0 24 24"
										fill="none"
										stroke="currentColor"
										strokeWidth="2"
										strokeLinecap="round"
										strokeLinejoin="round"
									>
										<path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" />
										<path d="M3 3v5h5" />
										<path d="M12 7v5l4 2" />
									</svg>
								</button>
							</Tooltip>
							<Tooltip content={t("chat.newConversation")}>
								<button type="button" aria-label={t("chat.newConversation")} onClick={newChat}>
									<svg
										width={14}
										height={14}
										viewBox="0 0 24 24"
										fill="none"
										stroke="currentColor"
										strokeWidth="2"
										strokeLinecap="round"
										strokeLinejoin="round"
									>
										<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
										<path d="M12 7v6" />
										<path d="M9 10h6" />
									</svg>
								</button>
							</Tooltip>
						</span>
					</div>
				</div>

				{activeSessionId ? (
					<div
						style={{
							display: "flex",
							alignItems: "center",
							justifyContent: "space-between",
							gap: 8,
							padding: "6px var(--sp-3)",
							borderTop: "1px solid var(--border-soft)",
							background: "var(--surface-warm)",
						}}
					>
						{editingSessionId === activeSessionId ? (
							<input
								ref={editingInputRef}
								type="text"
								autoFocus
								value={editingTitle}
								onChange={(event) => setEditingTitle(event.target.value)}
								onFocus={(event) => event.currentTarget.select()}
								onBlur={() => {
									if (editingSessionId) void commitEditTitle(editingSessionId);
								}}
								onKeyDown={(event) => {
									if (event.key === "Enter") {
										event.preventDefault();
										if (editingSessionId) void commitEditTitle(editingSessionId);
									} else if (event.key === "Escape") {
										event.preventDefault();
										cancelEditTitle();
									}
								}}
								style={{
									font: "500 12px/1.3 var(--font-body)",
									color: "var(--fg)",
									background: "var(--surface)",
									border: "1px solid var(--accent)",
									borderRadius: "var(--r-sm)",
									padding: "2px 6px",
									flex: 1,
									minWidth: 0,
								}}
							/>
						) : (
							<span
								style={{
									font: "500 12px/1.3 var(--font-body)",
									color: "var(--fg-2)",
									overflow: "hidden",
									textOverflow: "ellipsis",
									whiteSpace: "nowrap",
									flex: 1,
									cursor: "text",
								}}
								title={t("chat.clickToRename")}
								onClick={() => {
									const current = sessions.find((s) => s.id === activeSessionId);
									if (current) beginEditTitle(activeSessionId, current.title);
								}}
							>
								{sessions.find((s) => s.id === activeSessionId)?.title ??
									t("chat.untitledConversation")}
							</span>
						)}
						<Tooltip content={t("chat.renameConversation")}>
							<button
								type="button"
								aria-label={t("chat.renameConversation")}
								aria-disabled={editingSessionId === activeSessionId || undefined}
								onClick={() => {
									if (editingSessionId === activeSessionId) return;
									const current = sessions.find((s) => s.id === activeSessionId);
									if (current) beginEditTitle(activeSessionId, current.title);
								}}
								className={styles.iconBtn}
							>
								<svg
									width={14}
									height={14}
									viewBox="0 0 24 24"
									fill="none"
									stroke="currentColor"
									strokeWidth="2"
									strokeLinecap="round"
									strokeLinejoin="round"
								>
									<path d="M12 20h9" />
									<path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4z" />
								</svg>
							</button>
						</Tooltip>
						<Tooltip content={t("chat.deleteConversation")}>
							<button
								type="button"
								aria-label={t("chat.deleteConversation")}
								onClick={() => {
									const current = sessions.find((s) => s.id === activeSessionId);
									if (!current) return;
									if (
										window.confirm(t("chat.confirmDeleteConversation", { title: current.title }))
									) {
										void handleDelete(activeSessionId);
									}
								}}
								className={styles.iconBtn}
							>
								<svg
									width={14}
									height={14}
									viewBox="0 0 24 24"
									fill="none"
									stroke="currentColor"
									strokeWidth="2"
									strokeLinecap="round"
									strokeLinejoin="round"
								>
									<polyline points="3 6 5 6 21 6" />
									<path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
									<path d="M10 11v6" />
									<path d="M14 11v6" />
									<path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2" />
								</svg>
							</button>
						</Tooltip>
					</div>
				) : null}
			</div>

			<div className={styles.panelBody} ref={scrollRef}>
				{!canChat && messages.length === 0 ? (
					<ChatWelcome installed={claude?.installed !== false} />
				) : messages.length === 0 ? (
					<p
						style={{
							font: "400 12px var(--font-body)",
							color: "var(--muted)",
							padding: "24px var(--sp-4)",
							textAlign: "center",
							lineHeight: 1.5,
						}}
					>
						{t("chat.emptyState")}
					</p>
				) : (
					<>
						{messages.map((m, i) => (
							<div className={styles.msg} key={i}>
								<div className={styles.msgHead}>
									<span className={styles.msgAuthor}>
										{m.role === "user" ? t("chat.authorUser") : t("chat.authorAssistant")}
									</span>
									{m.time ? (
										<span
											className="right"
											style={{
												font: "500 11px/1 var(--font-body)",
												fontVariantNumeric: "tabular-nums",
												color: "var(--muted)",
											}}
										>
											{formatMessageTime(m.time)}
										</span>
									) : null}
								</div>
								{m.thinking && m.role !== "user" ? (
									<ThinkingBlock
										text={m.thinking}
										expanded={m.id !== undefined && thinkingExpandedIds.has(m.id)}
										onToggle={() => {
											if (!m.id) return;
											setThinkingExpandedIds((prev) => {
												const next = new Set(prev);
												if (next.has(m.id!)) {
													next.delete(m.id!);
												} else {
													next.add(m.id!);
												}
												return next;
											});
										}}
										label={t("chat.thinking")}
									/>
								) : null}
								<div
									className={
										m.role === "user"
											? `${styles.msgBubble} ${styles.msgBubbleUser}`
											: styles.msgBubble
									}
								>
									{m.content}
								</div>
								<div
									style={{
										display: "flex",
										alignItems: "center",
										gap: 4,
										marginTop: 4,
										justifyContent: "flex-end",
									}}
								>
									{m.role === "user" && m.checkpointId ? (
										// The name stays "Rewind to this message"; the tip adds what it does, which
										// only the confirmation dialog said before.
										<Tooltip content={t("chat.rewindTip")}>
											<button
												type="button"
												data-rewind-trigger="true"
												aria-label={t("chat.rewindToMessage")}
												aria-expanded={rewindFor?.messageId === m.id}
												onClick={(event) => {
													const rect = event.currentTarget.getBoundingClientRect();
													setRewindFor({
														messageId: m.id ?? "",
														anchor: {
															left: rect.left + rect.width / 2,
															bottom: window.innerHeight - rect.top + 6,
														},
													});
												}}
												className={styles.iconBtn}
											>
												<svg
													width={14}
													height={14}
													viewBox="0 0 24 24"
													fill="none"
													stroke="currentColor"
													strokeWidth="2"
													strokeLinecap="round"
													strokeLinejoin="round"
												>
													<path d="M3 7v6h6" />
													<path d="M21 17a9 9 0 0 0-15-6.7L3 13" />
												</svg>
											</button>
										</Tooltip>
									) : null}
									<Tooltip content={t("chat.copyMessage")}>
										<button
											type="button"
											aria-label={t("chat.copyMessage")}
											onClick={() => {
												// Electron denies the renderer's navigator clipboard write
												// (issue #738), so the write crosses to main when the
												// bridge offers it; the navigator path remains for
												// shim/web contexts without the bridge.
												const bridge = window.electronAPI?.copyToClipboard;
												const write = bridge
													? bridge(m.content)
													: navigator.clipboard.writeText(m.content);
												void write.then(
													() => toast.success(t("chat.copiedToClipboard")),
													() => toast.error(t("chat.copyFailed")),
												);
											}}
											className={styles.iconBtn}
										>
											<svg
												width={14}
												height={14}
												viewBox="0 0 24 24"
												fill="none"
												stroke="currentColor"
												strokeWidth="2"
												strokeLinecap="round"
												strokeLinejoin="round"
											>
												<rect x="9" y="9" width="13" height="13" rx="2" />
												<path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
											</svg>
										</button>
									</Tooltip>
								</div>
								{m.toolCalls?.length ? (
									<div style={{ marginTop: 4, display: "flex", flexDirection: "column", gap: 2 }}>
										{m.toolCalls.map((call, j) => (
											<div
												key={j}
												style={{
													font: "500 12px/1.5 var(--font-body)",
													color: "var(--success)",
												}}
											>
												{t("chat.appliedPrefix")} {call.summary}
											</div>
										))}
									</div>
								) : null}
							</div>
						))}
						{busy ? (
							<div className={styles.msg} aria-live="polite">
								<div className={styles.msgHead}>
									<span className={styles.msgAuthor}>{t("chat.authorAssistant")}</span>
								</div>
								{thinkingText ? (
									<div
										style={{
											display: "flex",
											alignItems: "flex-start",
											gap: 6,
										}}
									>
										<Loader2
											size={12}
											className="animate-spin"
											style={{
												marginTop: 10,
												flex: "0 0 auto",
												color: "var(--muted)",
											}}
										/>
										<div style={{ flex: 1, minWidth: 0 }}>
											<ThinkingBlock
												text={thinkingText}
												expanded={thinkingExpanded}
												onToggle={() => setThinkingExpanded((v) => !v)}
												label={t("chat.thinking")}
											/>
										</div>
									</div>
								) : (
									<div
										className={styles.msgBubble}
										style={{ color: "var(--muted)", fontStyle: "italic" }}
									>
										<Loader2
											size={12}
											className="animate-spin"
											style={{ marginRight: 6, verticalAlign: "middle" }}
										/>
										{activity ? t("chat.working", { tool: humanToolName(activity) }) : t("chat.thinking")}
									</div>
								)}
							</div>
						) : null}
					</>
				)}
			</div>

			<div className={styles.chatInput}>
				<textarea
					placeholder={
						canChat ? t("chat.composerPlaceholder") : t("chat.signInFirst")
					}
					value={input}
					disabled={!canChat}
					onChange={(e) => setInput(e.target.value)}
					onKeyDown={(e) => {
						if (e.key === "Enter" && !e.shiftKey) {
							e.preventDefault();
							void send();
						}
					}}
				/>
				<div className={styles.actions}>
					<span style={{ flex: 1 }} />
					{/* `aria-disabled`, not `disabled`: this is where "Sign in" is said, and a
					    natively disabled button takes no pointer events, so nothing could show it. */}
					<Tooltip
						content={canChat ? t("chat.send") : t("chat.signInFirst")}
						shortcut={canChat ? "Enter" : undefined}
					>
						<button
							type="button"
							className={styles.sendBtn}
							aria-label={t("chat.send")}
							aria-disabled={sendDisabled || undefined}
							onClick={sendDisabled ? undefined : () => void send()}
						>
							<svg
								width={14}
								height={14}
								viewBox="0 0 24 24"
								fill="none"
								stroke="currentColor"
								strokeWidth="2"
								strokeLinecap="round"
								strokeLinejoin="round"
							>
								<path d="M3.714 3.048a.498.498 0 0 0-.683.627l2.843 7.627a2 2 0 0 1 0 1.396l-2.843 7.627a.498.498 0 0 0 .683.627l18-8.5a.5.5 0 0 0 0-.904Z" />
								<path d="M6 12h16" />
							</svg>
						</button>
					</Tooltip>
				</div>
			</div>
			<ChatHistoryModal
				open={chatsOpen}
				onClose={() => setChatsOpen(false)}
				sessions={sessions}
				activeSessionId={activeSessionId}
				onSelect={selectSession}
				onNew={newChat}
			/>
			{rewindFor && rewindFor.anchor
				? createPortal(
						<div
							data-rewind-confirmation="true"
							role="dialog"
							aria-label={t("chat.rewindConfirmTitle")}
							style={{
								position: "fixed",
								left: rewindFor.anchor.left - 130,
								bottom: rewindFor.anchor.bottom,
								width: 260,
								background: "var(--surface)",
								border: "1px solid var(--border)",
								borderRadius: 12,
								boxShadow: "var(--elev-pop)",
								padding: 12,
								zIndex: 1000,
							}}
						>
							<strong style={{ display: "block", marginBottom: 4 }}>
								{t("chat.rewindConfirmTitle")}
							</strong>
							<p
								style={{
									font: "400 12px/1.4 var(--font-body)",
									color: "var(--muted)",
									margin: "0 0 8px",
								}}
							>
								{t("chat.rewindConfirmBody")}
							</p>
							<div style={{ display: "flex", justifyContent: "flex-end", gap: 6 }}>
								<button
									type="button"
									onClick={() => setRewindFor(null)}
									className={`${styles.btn} ${styles.btnSecondary}`}
								>
									{tc("actions.cancel")}
								</button>
								<button
									type="button"
									onClick={() => void confirmRewind(rewindFor.messageId)}
									className={`${styles.btn} ${styles.btnPrimary}`}
								>
									{t("chat.rewindConfirm")}
								</button>
							</div>
						</div>,
						document.body,
					)
				: null}
		</aside>
	);
}
