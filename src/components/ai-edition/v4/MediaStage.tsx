import {
	ArrowDown,
	Film,
	MoreHorizontal,
	Plus,
	RotateCw,
	Search,
	Trash2,
	Unlink,
	X,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { Tooltip } from "@/components/ui/tooltip";
import { toFileUrl } from "@/components/video-editor/projectPersistence";
import { useI18n, useScopedT } from "@/contexts/I18nContext";
import { documentWithoutAsset } from "@/lib/ai-edition/document/removeAsset";
import { VOCABULARY_MAX_CHARS, withVocabulary } from "@/lib/ai-edition/document/transcript";
import type { AxcutAsset, AxcutTranscript, TranscriptLanguageCode } from "@/lib/ai-edition/schema";
import { useProjectStore } from "@/lib/ai-edition/store/projectStore";
import {
	useAssetTranscriptions,
	useTranscriptionStore,
} from "@/lib/ai-edition/store/transcriptionStore";
import { formatSeconds } from "@/lib/ai-edition/timeline/format";
import {
	languageLabel,
	sortedLanguageOptions,
} from "@/lib/ai-edition/transcription/languageLabels";
import {
	type AssetTranscriptionStatus,
	type AssetTranscriptionView,
	isSilentFailure,
	transcriptHasSpeech,
	transcriptionFailureHintKey,
} from "@/lib/ai-edition/transcription/status";
import { moveMenuFocus } from "@/lib/menuKeyboard";
import { formatBytes } from "@/utils/formatBytes";
import { ModalShell } from "../Modals";
import shellStyles from "../NewEditorShell.module.css";
import {
	TranscriptionProgressBar,
	TranscriptionStatusDot,
	useTranscriptionLabel,
} from "../TranscriptionStatus";
import styles from "./EditorShellV4.module.css";

const ASSET_MIME = "application/x-axcut-asset";
const THUMB_GRADIENTS = [
	"linear-gradient(135deg, #fb7185, #f97316)",
	"linear-gradient(135deg, #ee6c0e, #0d986a)",
	"linear-gradient(135deg, #fbbf24, #f59e0b)",
	"linear-gradient(135deg, #38bdf8, #6366f1)",
];

function basename(path: string): string {
	return path.split(/[\\/]/).pop() ?? path;
}

export function detectedLanguageForTranscript(transcript: AxcutTranscript | null): string | null {
	if (!transcript || transcript.language === "auto" || !transcriptHasSpeech(transcript)) {
		return null;
	}
	return transcript.language;
}

export async function addSelectedAssetToTimeline(
	selected: Pick<AxcutAsset, "id" | "label" | "originalPath"> | null,
	onAddToTimeline: (assetId: string) => Promise<void>,
	onSuccess: (label: string) => void,
): Promise<void> {
	if (!selected) return;
	await onAddToTimeline(selected.id);
	onSuccess(selected.label || basename(selected.originalPath));
}

/**
 * Takes an asset, and every clip, trim and audio track that uses it, out of the open project as
 * ONE undo step (Cmd+Z brings them back). The file stays on disk. Resolves with the asset that
 * left, or null when nothing changed (no such asset, or the save did not go through).
 */
export async function removeAssetFromProject(assetId: string): Promise<AxcutAsset | null> {
	const { document, saveDocument } = useProjectStore.getState();
	const asset = document?.assets.find((a) => a.id === assetId);
	if (!document || !asset) return null;
	const saved = await saveDocument(documentWithoutAsset(document, assetId), { history: true });
	return saved ? asset : null;
}

export function MediaStage({
	onAddToTimeline,
}: {
	onAddToTimeline: (assetId: string) => Promise<void>;
}) {
	const t = useScopedT("editor");
	const { locale } = useI18n();
	const projectId = useProjectStore((s) => s.projectId);
	const document = useProjectStore((s) => s.document);
	const addAsset = useProjectStore((s) => s.addAsset);
	const createProject = useProjectStore((s) => s.createProject);
	const saveDocument = useProjectStore((s) => s.saveDocument);
	const vocabularySave = useRef<Promise<boolean>>(undefined);
	// Transcripts are produced in the background as soon as a media lands here
	// (see transcriptionStore) — this stage only reports where each one is at,
	// and lets the user force a re-run in another language.
	const transcriptions = useAssetTranscriptions();
	const requestTranscription = useTranscriptionStore((s) => s.request);
	const transcriptionLabel = useTranscriptionLabel();
	const [query, setQuery] = useState("");
	const [busy, setBusy] = useState(false);
	const [selectedId, setSelectedId] = useState<string | null>(null);
	const [detailOpen, setDetailOpen] = useState(false);
	const [lang, setLang] = useState<TranscriptLanguageCode>("auto");
	const tc = useScopedT("common");
	// The item whose "⋯" menu is open, and the one the user is asked to delete from the disk.
	const [menuId, setMenuId] = useState<string | null>(null);
	const [deleteTarget, setDeleteTarget] = useState<{
		asset: AxcutAsset;
		token: string;
		files: string[];
	} | null>(null);
	const [deleting, setDeleting] = useState(false);
	const regenLanguageOptions = useMemo(
		() => sortedLanguageOptions(locale, t("mediaStage.auto")),
		[locale, t],
	);

	// Video only — this stage arranges clips. Imported audio (issue #350) is a
	// timeline overlay added from the timeline toolbar, not a clip, so it never
	// appears in this list.
	const assets = (document?.assets ?? []).filter((a) => a.kind !== "audio");
	const filtered = useMemo(
		() =>
			assets.filter((a) => {
				if (!query) return true;
				return `${a.label} ${a.originalPath}`.toLowerCase().includes(query.toLowerCase());
			}),
		[assets, query],
	);
	const selected = assets.find((a) => a.id === selectedId) ?? null;
	const transcript = selected
		? (document?.transcripts?.find((t) => t.assetId === selected.id) ?? null)
		: null;
	const detectedLanguage = detectedLanguageForTranscript(transcript);
	const selectedTranscription: AssetTranscriptionView = selected
		? (transcriptions[selected.id] ?? { assetId: selected.id, status: "idle" })
		: { assetId: "", status: "idle" };
	const selectedBusy =
		selectedTranscription.status === "running" || selectedTranscription.status === "queued";
	const failureHintKey = selectedTranscription.failure
		? transcriptionFailureHintKey(selectedTranscription.failure)
		: null;

	const handleImport = async () => {
		const picker = await window.electronAPI?.openVideoFilePicker();
		if (!picker?.success || !picker.path) {
			// A refused pick says why instead of doing nothing; a cancelled one is silent.
			if (picker && !picker.canceled && picker.message) {
				toast.error(t("mediaStage.couldNotAddAsset"), { description: picker.message });
			}
			return;
		}
		setBusy(true);
		try {
			// No project open yet (a fresh editor): this import starts one, as the empty state's
			// "Import video" does. The button used to be disabled here and looked alive.
			if (!useProjectStore.getState().projectId) {
				await createProject(`Project ${new Date().toLocaleString()}`);
			}
			const label = picker.name || basename(picker.path);
			await addAsset(picker.path, label);
			toast.success(t("mediaStage.added", { label }));
		} catch (err) {
			toast.error(t("mediaStage.couldNotAddAsset"), {
				description: err instanceof Error ? err.message : String(err),
			});
		} finally {
			setBusy(false);
		}
	};

	const openDetail = (asset: AxcutAsset) => {
		setSelectedId(asset.id);
		setDetailOpen(true);
	};

	useEffect(() => {
		if (!menuId) return;
		// Operable from the keyboard as it opens, as the app menu is.
		window.document
			.querySelector<HTMLButtonElement>('[data-media-menu="true"][role="menu"] [role="menuitem"]')
			?.focus();
		const close = (event: Event) => {
			if (event instanceof KeyboardEvent && event.key !== "Escape") return;
			if (event.target instanceof Element && event.target.closest('[data-media-menu="true"]'))
				return;
			setMenuId(null);
		};
		window.document.addEventListener("mousedown", close);
		window.document.addEventListener("keydown", close);
		return () => {
			window.document.removeEventListener("mousedown", close);
			window.document.removeEventListener("keydown", close);
		};
	}, [menuId]);

	const nameOf = (asset: AxcutAsset) => asset.label || basename(asset.originalPath);

	const clearSelection = (assetId: string) => {
		if (selectedId === assetId) {
			setSelectedId(null);
			setDetailOpen(false);
		}
	};

	const removeFromProject = async (asset: AxcutAsset) => {
		setMenuId(null);
		const removed = await removeAssetFromProject(asset.id);
		if (!removed) return;
		clearSelection(asset.id);
		toast.success(t("mediaStage.removedFromProject", { label: nameOf(asset) }));
	};

	// Step one, before anything changes: main reads the saved project and lists the files that
	// would go (it is given ids, never paths). The dialog shows that list.
	const askToDelete = async (asset: AxcutAsset) => {
		setMenuId(null);
		const prepared =
			projectId && window.electronAPI?.prepareMediaTrash
				? await window.electronAPI.prepareMediaTrash(projectId, asset.id).catch(() => null)
				: null;
		if (!prepared || prepared.files.length === 0) {
			toast.error(t("mediaStage.cannotDelete", { label: nameOf(asset) }));
			return;
		}
		setDeleteTarget({ asset, token: prepared.token, files: prepared.files });
	};

	const cancelDelete = () => {
		if (deleteTarget) void window.electronAPI?.cancelMediaTrash?.(deleteTarget.token);
		setDeleteTarget(null);
	};

	// Step two: the asset leaves the project (one undo step) and is saved, then main re-reads
	// the saved project and moves the listed files to the Trash, unless a project still uses
	// them. Undo brings back the entries only.
	const deleteFromDisk = async (target: NonNullable<typeof deleteTarget>) => {
		const { asset, token } = target;
		setDeleting(true);
		try {
			const removed = await removeAssetFromProject(asset.id);
			if (!removed) {
				void window.electronAPI?.cancelMediaTrash?.(token);
				return;
			}
			clearSelection(asset.id);
			const label = nameOf(asset);
			const result = await window.electronAPI?.commitMediaTrash?.(token).catch(() => null);
			if (result?.shared) {
				toast.info(t("mediaStage.removedStillUsed", { label }));
			} else if (result && result.trashed.length > 0 && result.kept.length === 0) {
				toast.success(t("mediaStage.movedToTrash", { label }));
			} else if (result && !result.failedClosed && !result.refused && result.kept.length === 0) {
				// Nothing was left on the disk to move.
				toast.success(t("mediaStage.removedFromProject", { label }));
			} else {
				toast.warning(t("mediaStage.trashFailed", { label }));
			}
		} finally {
			setDeleting(false);
			setDeleteTarget(null);
		}
	};

	const addSelectedToTimeline = () => {
		void addSelectedAssetToTimeline(selected, onAddToTimeline, (label) => {
			toast.success(t("mediaStage.addedToTimeline", { label }));
		}).catch(() => undefined);
	};

	return (
		<div className={styles.mediaStage}>
			<div className={styles.mediaInner} style={{ maxWidth: detailOpen ? 1120 : 900 }}>
				<div className={styles.mediaSearchRow}>
					<Search size={16} style={{ color: "var(--muted)", flexShrink: 0 }} />
					<input
						value={query}
						onChange={(e) => setQuery(e.target.value)}
						placeholder={t("mediaStage.searchPlaceholder")}
					/>
				</div>
				<div className={styles.mediaCols}>
					<div className={styles.mediaListCol}>
						<div
							className={styles.mediaGrid}
							style={{ gridTemplateColumns: detailOpen ? "repeat(2,1fr)" : "repeat(3,1fr)" }}
						>
							{filtered.map((asset, i) => {
								const transcription = transcriptions[asset.id] ?? {
									assetId: asset.id,
									status: "idle" as AssetTranscriptionStatus,
								};
								return (
									<div
										key={asset.id}
										className={styles.mediaCardWrap}
										onContextMenu={(e) => {
											e.preventDefault();
											setMenuId(asset.id);
										}}
									>
										<button
											type="button"
											draggable
											className={`${styles.mediaCard}${
												asset.id === selectedId ? ` ${styles.selected}` : ""
											}`}
											title={asset.originalPath}
											onDragStart={(e) => {
												e.dataTransfer.setData(ASSET_MIME, asset.id);
												e.dataTransfer.effectAllowed = "copy";
											}}
											onClick={() => openDetail(asset)}
										>
											<div
												className={styles.mediaThumb}
												style={{ background: THUMB_GRADIENTS[i % THUMB_GRADIENTS.length] }}
											>
												{asset.kind === "video" && asset.originalPath ? (
													<video
														className={styles.mediaThumbFrame}
														src={`${toFileUrl(asset.originalPath)}#t=0.5`}
														preload="metadata"
														muted
														playsInline
													/>
												) : (
													<Film size={30} strokeWidth={1.8} />
												)}
											</div>
											<div className={styles.mediaCardMeta}>
												{asset.id === selectedId ? (
													<span
														aria-hidden
														style={{
															width: 6,
															height: 6,
															borderRadius: "50%",
															background: "var(--accent)",
															flexShrink: 0,
														}}
													/>
												) : null}
												<div className={styles.body}>
													<div className={styles.mediaCardName}>
														{asset.label || basename(asset.originalPath)}
													</div>
													<div className={styles.mediaCardStats}>
														<span className={styles.dur}>
															{formatSeconds(asset.durationSec ?? 0)}
														</span>
														<span className={styles.size}>{formatBytes(asset.sizeBytes)}</span>
													</div>
												</div>
												<TranscriptionStatusDot view={transcription} />
											</div>
										</button>
										<button
											type="button"
											data-media-menu="true"
											className={styles.mediaMore}
											aria-label={t("mediaStage.moreActions")}
											aria-haspopup="menu"
											aria-expanded={menuId === asset.id}
											onClick={() => setMenuId(menuId === asset.id ? null : asset.id)}
										>
											<MoreHorizontal size={15} />
										</button>
										{menuId === asset.id ? (
											<div
												data-media-menu="true"
												className={`${styles.appMenu} ${styles.mediaMenu}`}
												role="menu"
												onKeyDown={moveMenuFocus}
											>
												<button
													type="button"
													role="menuitem"
													className={styles.appMenuRow}
													onClick={() => void removeFromProject(asset)}
												>
													<Unlink size={15} />
													{t("mediaStage.removeFromProject")}
												</button>
												<button
													type="button"
													role="menuitem"
													className={styles.appMenuRow}
													onClick={() => {
														setMenuId(null);
														void askToDelete(asset);
													}}
												>
													<Trash2 size={15} />
													{t("mediaStage.deleteFromDisk")}
												</button>
											</div>
										) : null}
									</div>
								);
							})}
						</div>
						{assets.length > 0 ? (
							<div className={styles.mediaHint}>
								<ArrowDown size={12} />
								{t("mediaStage.dragHint")}
							</div>
						) : (
							<div className={styles.mediaHint}>{t("mediaStage.emptyHint")}</div>
						)}
						<button
							type="button"
							className={styles.importBtn}
							onClick={handleImport}
							disabled={busy}
						>
							<Plus size={14} />
							{t("mediaStage.importMedia")}
						</button>
					</div>

					{detailOpen && selected ? (
						<div className={styles.mediaDetail}>
							<div
								style={{
									display: "flex",
									alignItems: "flex-start",
									justifyContent: "space-between",
									gap: 10,
									marginBottom: 4,
								}}
							>
								<h2
									style={{
										margin: 0,
										fontSize: 16.5,
										fontWeight: 700,
										color: "var(--fg-emphasis)",
										letterSpacing: "-0.01em",
									}}
								>
									{t("mediaStage.sourceTranscript")}
								</h2>
								<button
									type="button"
									title={t("mediaStage.close")}
									aria-label={t("mediaStage.close")}
									onClick={() => setDetailOpen(false)}
									style={{
										width: 26,
										height: 26,
										display: "grid",
										placeItems: "center",
										borderRadius: 8,
										color: "var(--muted)",
										background: "transparent",
										border: 0,
										cursor: "pointer",
										flexShrink: 0,
									}}
								>
									<X size={15} />
								</button>
							</div>
							<div
								style={{
									fontSize: 12,
									color: "var(--muted)",
									marginBottom: 10,
									whiteSpace: "nowrap",
									overflow: "hidden",
									textOverflow: "ellipsis",
								}}
							>
								{selected.label || basename(selected.originalPath)}
							</div>
							<button
								type="button"
								onClick={addSelectedToTimeline}
								style={{
									width: "100%",
									height: 36,
									display: "inline-flex",
									alignItems: "center",
									justifyContent: "center",
									gap: 7,
									marginBottom: 16,
									borderRadius: 9,
									border: "1px solid var(--accent)",
									background: "var(--accent)",
									color: "var(--accent-on)",
									fontSize: 12.5,
									fontWeight: 650,
									cursor: "pointer",
								}}
							>
								<Plus size={14} />
								{t("mediaStage.addToTimeline")}
							</button>

							<div style={{ marginBottom: 16 }}>
								<span
									style={{
										display: "inline-flex",
										alignItems: "center",
										gap: 6,
										padding: "5px 10px 5px 8px",
										borderRadius: 9999,
										// A silent recording reads as a verdict about the media, not as a
										// broken run, so it keeps the neutral accent rather than the danger
										// red the engine failures get (issue #628).
										background:
											selectedTranscription.status === "failed" &&
											!isSilentFailure(selectedTranscription)
												? "var(--danger-soft)"
												: selectedTranscription.status === "ready"
													? "var(--success-soft)"
													: "var(--accent-soft)",
										color:
											selectedTranscription.status === "failed" &&
											!isSilentFailure(selectedTranscription)
												? "var(--danger)"
												: selectedTranscription.status === "ready"
													? "var(--success)"
													: "var(--accent)",
										fontSize: 12,
										fontWeight: 600,
									}}
								>
									<TranscriptionStatusDot view={selectedTranscription} size={5} />
									{transcriptionLabel(selectedTranscription)}
								</span>
								{/* The language whisper resolved on the first chunk, which every later
								    chunk was then pinned to. Its only pill used to live in the v3 left
								    panel's transcript modal, which nothing mounted, so the value was
								    reaching the document and being displayed nowhere. It belongs next to
								    "Regenerate as" below in any case: that selector is the control
								    you set BECAUSE of what was detected. */}
								{detectedLanguage ? (
									<span
										style={{
											display: "inline-flex",
											alignItems: "center",
											marginLeft: 8,
											padding: "5px 10px",
											borderRadius: 9999,
											background: "var(--success-soft)",
											color: "var(--success)",
											fontSize: 12,
											fontWeight: 600,
										}}
									>
										{t("mediaStage.detectedLanguage", {
											language: languageLabel(detectedLanguage, locale),
										})}
									</span>
								) : null}
							</div>

							{/* Renders itself away — spacing included — unless the run reports progress. */}
							<TranscriptionProgressBar view={selectedTranscription} />

							{selectedTranscription.failure ? (
								<p
									style={{
										margin: "-8px 0 16px",
										fontSize: 12,
										lineHeight: 1.5,
										color: "var(--muted)",
									}}
								>
									{failureHintKey ? t(failureHintKey) : selectedTranscription.failure.message}
								</p>
							) : null}

							{/* Project-wide: whisper's initial prompt for every run (issue #1023).
							    Uncontrolled and keyed on the saved value, so an undo that restores
							    an older list shows it; the save happens on blur, one undo step. */}
							<label style={{ display: "block", marginBottom: 12 }}>
								<span
									style={{
										display: "block",
										fontSize: 12.5,
										fontWeight: 600,
										color: "var(--fg-2)",
										marginBottom: 6,
									}}
								>
									{t("mediaStage.namesAndTerms")}
								</span>
								<textarea
									key={`${document?.project.id}:${document?.project.vocabulary ?? ""}`}
									defaultValue={document?.project.vocabulary ?? ""}
									maxLength={VOCABULARY_MAX_CHARS}
									rows={2}
									spellCheck={false}
									onBlur={(e) => {
										// The latest document, not the render's: a save replaces the whole
										// document, so a stale one would undo a transcript written meanwhile.
										const latest = useProjectStore.getState().document;
										const next = latest && withVocabulary(latest, e.target.value);
										if (next) vocabularySave.current = saveDocument(next, { history: true });
									}}
									style={{
										width: "100%",
										padding: "8px 10px",
										borderRadius: 9,
										border: "1px solid var(--border)",
										background: "var(--surface-2)",
										color: "var(--fg)",
										fontSize: 12.5,
										lineHeight: 1.5,
										resize: "vertical",
										outline: "none",
									}}
								/>
							</label>

							<div style={{ marginBottom: 12 }}>
								<div
									style={{
										fontSize: 12.5,
										fontWeight: 600,
										color: "var(--fg-2)",
										marginBottom: 6,
									}}
								>
									{t("mediaStage.regenerateAs")}
								</div>
								<div style={{ display: "flex", gap: 8 }}>
									<select
										value={lang}
										onChange={(e) => setLang(e.target.value as TranscriptLanguageCode)}
										style={{
											flex: 1,
											minWidth: 0,
											height: 36,
											padding: "0 10px",
											borderRadius: 9,
											border: "1px solid var(--border)",
											background: "var(--surface-2)",
											color: "var(--fg)",
											fontSize: 12.5,
											fontWeight: 500,
											outline: "none",
										}}
									>
										{regenLanguageOptions.map(({ code, label }) => (
											<option key={code} value={code}>
												{label}
											</option>
										))}
									</select>
									{/* A bare refresh icon beside a language list: the tip says what it redoes. */}
									<Tooltip content={t("mediaStage.regenerateTip")}>
										<button
											type="button"
											aria-label={t("mediaStage.regenerate")}
											// `aria-disabled`, not `disabled`: a natively disabled button cannot take focus or
											// open its tooltip. It does nothing while a transcription runs.
											aria-disabled={selectedBusy || undefined}
											onClick={
												selectedBusy
													? undefined
													: async () => {
															// Clicking here blurs the terms field, whose save is still in
															// flight: the run must read the terms it just saved, so a failed
															// save (already toasted) runs nothing.
															const saving = vocabularySave.current;
															vocabularySave.current = undefined;
															if ((await saving) === false) return;
															void requestTranscription(selected.id, lang);
														}
											}
											style={{
												width: 36,
												height: 36,
												flexShrink: 0,
												display: "grid",
												placeItems: "center",
												borderRadius: 9,
												color: "var(--fg-2)",
												background: "var(--surface-2)",
												border: "1px solid var(--border)",
												cursor: selectedBusy ? "not-allowed" : "pointer",
												opacity: selectedBusy ? 0.6 : 1,
											}}
										>
											<RotateCw size={14} className={selectedBusy ? "animate-spin" : undefined} />
										</button>
									</Tooltip>
								</div>
							</div>

							<div
								style={{
									padding: "16px",
									border: "1px solid var(--border)",
									borderRadius: 12,
									background: "var(--surface)",
									fontSize: 12.5,
									lineHeight: 1.7,
									color: "var(--fg-2)",
									maxHeight: 360,
									overflowY: "auto",
								}}
							>
								{transcript ? (
									(transcript.segments ?? [])
										.map((seg) => (seg as { text?: string }).text ?? "")
										.join(" ") || t("mediaStage.transcriptEmpty")
								) : (
									<span style={{ color: "var(--muted)" }}>
										{selectedBusy
											? transcriptionLabel(selectedTranscription)
											: isSilentFailure(selectedTranscription)
												? t("mediaStage.noAudioTrackHint")
												: selectedTranscription.status === "failed"
													? t("mediaStage.generationFailedHint")
													: t("mediaStage.notGeneratedHint")}
									</span>
								)}
							</div>
						</div>
					) : null}
				</div>
			</div>
			<ModalShell
				open={deleteTarget !== null}
				onClose={() => {
					if (!deleting) cancelDelete();
				}}
				closeOnBackdrop={!deleting}
				closeOnEscape={!deleting}
				title={t("mediaStage.deleteDialogTitle", {
					name: deleteTarget ? nameOf(deleteTarget.asset) : "",
				})}
				footer={
					<>
						<button
							type="button"
							className={`${shellStyles.btn} ${shellStyles.btnSecondary}`}
							disabled={deleting}
							onClick={cancelDelete}
						>
							{tc("actions.cancel")}
						</button>
						<button
							type="button"
							className={`${shellStyles.btn} ${shellStyles.btnDanger}`}
							disabled={deleting}
							onClick={() => deleteTarget && void deleteFromDisk(deleteTarget)}
						>
							{t("mediaStage.deleteDialogConfirm")}
						</button>
					</>
				}
			>
				<p style={{ margin: 0, font: "13px/1.5 var(--font-body)", color: "var(--fg-2)" }}>
					{t("mediaStage.deleteDialogBody", {
						name: deleteTarget ? nameOf(deleteTarget.asset) : "",
					})}
				</p>
				<ul
					style={{
						margin: "10px 0 0",
						paddingLeft: 20,
						maxHeight: 160,
						overflow: "auto",
						font: "12px/1.6 var(--font-mono)",
					}}
				>
					{(deleteTarget?.files ?? []).map((file) => (
						<li key={file} title={file}>
							{basename(file)}
						</li>
					))}
				</ul>
			</ModalShell>
		</div>
	);
}
