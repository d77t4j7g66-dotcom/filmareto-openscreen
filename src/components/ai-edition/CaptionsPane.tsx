// The Captions facet of the floating inspector.
//
// Captions have nothing to do with annotations any more: there is no "generate"
// step that stamps text onto the timeline, because the caption layer IS the
// transcript, read through this panel's settings. So every control here changes
// how the transcript is *shown* — never what it says.
//
// The one exception is the translation row, and even that is additive: a
// translation is stored beside the transcript, keyed by segment id, and picking
// "Original" goes straight back to the SSOT text.

import { Captions as CaptionsIcon, Languages, Loader2, Trash2, X } from "lucide-react";
import { useMemo, useState } from "react";
import { Tooltip, TooltipProvider } from "@/components/ui/tooltip";
import { useScopedT } from "@/contexts/I18nContext";
import type {
	CaptionAnchorH,
	CaptionAnchorV,
	CaptionPlate,
	CaptionStyleId,
} from "@/lib/ai-edition/captions";
import {
	CAPTION_FONT_SIZE_MAX,
	CAPTION_FONT_SIZE_MIN,
	CAPTION_INSET_X_MAX,
	CAPTION_INSET_Y_MAX,
	CAPTION_PLATE_OPACITY_MAX,
	CAPTION_PLATE_OPACITY_MIN,
	CAPTION_STYLE_GROUPS,
	captionPlateOf,
	captionPlatePatch,
	captionStyleOf,
	captionStylePatch,
	DEFAULT_CAPTION_SETTINGS,
	insightKey,
	patchCaptionSettings,
	resolveCaptionLane,
	untranslatedUnits,
	withCaptionInsights,
} from "@/lib/ai-edition/captions";
import {
	deleteCaptionTemplate,
	readCaptionTemplates,
	saveCaptionTemplate,
} from "@/lib/ai-edition/captions/myTemplates";
import {
	CAPTION_WORDS_PER_LINE_MAX,
	CAPTION_WORDS_PER_LINE_MIN,
} from "@/lib/ai-edition/captions/wordsPerLine";
import { resolveAspectRatioValue } from "@/lib/ai-edition/document/outputFormat";
import { setDocumentWordText } from "@/lib/ai-edition/document/transcript";
import { getEditorSettings } from "@/lib/ai-edition/store/editorSettings";
import { useProjectStore } from "@/lib/ai-edition/store/projectStore";
import {
	useAssetTranscriptions,
	useTimelineTranscriptGate,
} from "@/lib/ai-edition/store/transcriptionStore";
import { useCaptions } from "@/lib/ai-edition/store/useCaptions";
import { lanePlacements } from "@/lib/ai-edition/timeline/aggregated-transcript";
import { removedRawSpans } from "@/lib/ai-edition/timeline/programme-time";
import { firstTimelineBusyView } from "@/lib/ai-edition/transcription/status";
import { getAssetPath } from "@/lib/assetPath";
import { TEXT_FONT_FAMILIES } from "@/lib/textFonts";
import { nativeBridgeClient } from "@/native";
import type { AiEditionCaptionReadResult } from "@/native/contracts";
import styles from "./NewEditorShell.module.css";
import { ChoiceRow, SliderCell, Toggle } from "./RightPanes";
import { TextColorField } from "./TextColorField";
import { useTranscriptionLabel } from "./TranscriptionStatus";
import { transcriptionBusyLabel } from "./transcriptionBusyLabel";

/** Offered as translation targets. Codes double as the storage key. */
const TRANSLATION_LANGUAGES: ReadonlyArray<{ code: string; label: string }> = [
	{ code: "en", label: "English" },
	{ code: "el", label: "Ελληνικά" },
	{ code: "fr", label: "Français" },
	{ code: "es", label: "Español" },
	{ code: "de", label: "Deutsch" },
	{ code: "it", label: "Italiano" },
	{ code: "pt", label: "Português" },
	{ code: "nl", label: "Nederlands" },
	{ code: "pl", label: "Polski" },
	{ code: "tr", label: "Türkçe" },
	{ code: "ru", label: "Русский" },
	{ code: "ar", label: "العربية" },
	{ code: "hi", label: "हिन्दी" },
	{ code: "ja", label: "日本語" },
	{ code: "ko", label: "한국어" },
	{ code: "zh", label: "中文" },
];

const CAPTION_ANCHORS = (["top", "bottom"] as const).flatMap((v) =>
	(["left", "center", "right"] as const).map((h) => [v, h] as const),
);

const CAPTION_ANCHOR_KEYS: Record<string, string> = {
	"top-left": "layout.anchors.topLeft",
	"top-center": "layout.anchors.top",
	"top-right": "layout.anchors.topRight",
	"bottom-left": "layout.anchors.bottomLeft",
	"bottom-center": "layout.anchors.bottom",
	"bottom-right": "layout.anchors.bottomRight",
};

/** The frame with a caption line where this anchor puts it (same viewBox as the camera icons). */
function captionAnchorIcon(v: CaptionAnchorV, h: CaptionAnchorH) {
	const fx = h === "left" ? 0 : h === "center" ? 0.5 : 1;
	return (
		<svg
			viewBox="0 0 32 22"
			width={32}
			height={22}
			fill="none"
			stroke="currentColor"
			strokeWidth="1.75"
			aria-hidden="true"
		>
			<rect x="1.5" y="1.5" width="29" height="19" rx="3" />
			<rect
				x={5 + fx * 10}
				y={v === "top" ? 5 : 14}
				width="12"
				height="3"
				rx="1.5"
				fill="currentColor"
				stroke="none"
			/>
		</svg>
	);
}

export function CaptionsPane({ onClose }: { onClose?: () => void } = {}) {
	const t = useScopedT("settings");
	const te = useScopedT("editor");
	const tc = useScopedT("common");
	const {
		settings,
		translations,
		cues,
		hasDocument,
		hasTranscript,
		set,
		setLive,
		commit,
		saveTranslation,
		deleteTranslation,
	} = useCaptions();
	const document = useProjectStore((s) => s.document);
	const saveDocument = useProjectStore((s) => s.saveDocument);
	// Captions are a view of the transcript, and the transcript arrives on its
	// own (transcriptionStore's background pass). The pane reads that state
	// straight from the store rather than being handed a busy flag: it is the
	// same answer everywhere, and this pane only ever reports on the pass —
	// starting one is the transcript tab's job.
	//
	// Resolved over the timeline's assets, not the primary one: `hasTranscript`
	// below is already timeline-scoped (useCaptions), and mixing the two scopes
	// is what let a silent primary asset dead-end this button for a project whose
	// actual footage had speech.
	const gate = useTimelineTranscriptGate();
	const transcriptions = useAssetTranscriptions();
	const transcriptionLabel = useTranscriptionLabel();
	const isTranscribing = gate.state === "pending";
	// Timeline-scoped on purpose: the gate below answers for the timeline's
	// assets, so the label must too — an off-timeline job must not relabel an
	// enabled button.
	const busyLabel = transcriptionBusyLabel(
		firstTimelineBusyView(document, transcriptions) ??
			(isTranscribing ? { assetId: "", status: "running", phase: "loading-model" } : undefined),
		transcriptionLabel,
	);
	const silentMedia = gate.state === "blocked" && gate.reason === "no-audio";
	const engineError = gate.state === "blocked" && gate.reason === "failed" ? gate.message : null;

	const [target, setTarget] = useState<string>("en");
	const [styleGroup, setStyleGroup] = useState<string>(CAPTION_STYLE_GROUPS[0].id);
	const [myTemplates, setMyTemplates] = useState(readCaptionTemplates);
	const [templateName, setTemplateName] = useState("");
	const [reading, setReading] = useState(false);
	const [readNote, setReadNote] = useState<string | null>(null);
	const [readFailed, setReadFailed] = useState(false);
	const currentStyle = captionStyleOf(settings);
	const frameAspect = document
		? resolveAspectRatioValue(document, getEditorSettings(document).aspectRatio)
		: 16 / 9;
	const [translating, setTranslating] = useState(false);
	const [translateError, setTranslateError] = useState<string | null>(null);

	// Documents made by the old "generate captions" flow carry caption text as
	// real annotations. They'd now render *on top of* the derived layer, so the
	// pane offers to clear them — explicitly, since they are the user's data.
	const legacyCaptionAnnotations = useMemo(
		() => (document?.annotations ?? []).filter((a) => a.annotationSource === "auto-caption"),
		[document],
	);

	const disabled = !hasDocument;
	const plate = captionPlateOf(settings);
	const languageOptions = useMemo(() => Object.values(translations), [translations]);

	const handleTranslate = async () => {
		const doc = useProjectStore.getState().document;
		if (!doc) return;
		const label = TRANSLATION_LANGUAGES.find((l) => l.code === target)?.label ?? target;
		setTranslating(true);
		setTranslateError(null);
		try {
			// Only the assets actually on the timeline, and only the units that aren't
			// translated yet — a re-run after adding footage costs just the new
			// material instead of the whole video. Units, not segments: a Whisper
			// transcript is one segment per word, and translating single words gives
			// nonsense in any language that reorders or agrees differently.
			const assetIds = new Set(doc.timeline.clips.map((c) => c.assetId));
			let translatedAny = false;
			for (const transcript of doc.transcripts) {
				if (!assetIds.has(transcript.assetId)) continue;
				const pending = untranslatedUnits(transcript, translations, target);
				if (pending.length === 0) {
					translatedAny = true;
					continue;
				}
				const result = await nativeBridgeClient.aiEdition.translateCaptions({
					segments: pending.map((s) => ({ id: s.id, text: s.text })),
					targetLanguage: label,
					sourceLanguage: transcript.language,
				});
				if (Object.keys(result.segments).length > 0) {
					await saveTranslation({
						language: target,
						label,
						assetId: transcript.assetId,
						segments: result.segments,
						model: result.model,
					});
					translatedAny = true;
				}
				if (!result.success) {
					setTranslateError(result.error ?? t("captions.translateFailed"));
					return;
				}
			}
			if (translatedAny) await set({ language: target, enabled: true });
			else setTranslateError(t("captions.noTranscript"));
		} catch (error) {
			setTranslateError(error instanceof Error ? error.message : String(error));
		} finally {
			setTranslating(false);
		}
	};

	/** One pass of Claude over the words as they were spoken: one undo step. */
	const handleClaudeRead = async () => {
		const asked = useProjectStore.getState().document;
		if (!asked) return;
		setReading(true);
		setReadNote(null);
		setReadFailed(false);
		try {
			// The words the captions are read from, on either lane.
			const placements = lanePlacements(
				resolveCaptionLane(asked, settings),
				asked.timeline.clips,
				asked.audioTracks ?? [],
				removedRawSpans(asked.timeline.clips, asked.timeline.trimRanges),
			);
			const reads: Array<{ assetId: string; result: AiEditionCaptionReadResult }> = [];
			let failure: string | null = null;
			for (const assetId of new Set(placements.map((p) => p.assetId))) {
				const transcript = asked.transcripts.find((tr) => tr.assetId === assetId);
				const words = transcript?.words.filter((word) => word.text.trim()) ?? [];
				if (words.length === 0) continue;
				const result = await nativeBridgeClient.aiEdition.readCaptions(
					words.map((word) => ({ at: insightKey(word.startSec), text: word.text })),
				);
				if (!result.success) {
					failure = result.error ?? t("captions.claudeReadFailed");
					break;
				}
				reads.push({ assetId, result });
			}
			// Onto the document as it is now: the user may have gone on working while Claude read,
			// or opened another project, which these answers do not belong to.
			const current = useProjectStore.getState().document;
			if (!current || current.project.id !== asked.project.id) return;
			let next = current;
			const counts = { keys: 0, emoji: 0, fixes: 0 };
			for (const { assetId, result } of reads) {
				next = withCaptionInsights(next, assetId, { keys: result.keys, emoji: result.emoji });
				const words = next.transcripts.find((tr) => tr.assetId === assetId)?.words ?? [];
				for (const fix of result.fixes) {
					const word = words.find((candidate) => insightKey(candidate.startSec) === fix.at);
					if (word && word.text !== fix.text) {
						next = setDocumentWordText(next, assetId, word.id, fix.text);
						counts.fixes += 1;
					}
				}
				counts.keys += result.keys.length;
				counts.emoji += Object.keys(result.emoji).length;
			}
			if (reads.length > 0) {
				// Asked for and found: show them, in the same undo step.
				if (counts.emoji > 0) next = patchCaptionSettings(next, { emoji: true }, frameAspect);
				await saveDocument(next, { history: true });
			}
			setReadFailed(failure !== null);
			setReadNote(failure ?? t("captions.claudeReadDone", counts));
		} catch (error) {
			setReadFailed(true);
			setReadNote(error instanceof Error ? error.message : String(error));
		} finally {
			setReading(false);
		}
	};

	const clearLegacyCaptionAnnotations = async () => {
		const doc = useProjectStore.getState().document;
		if (!doc) return;
		await saveDocument(
			{
				...doc,
				annotations: doc.annotations.filter((a) => a.annotationSource !== "auto-caption"),
			},
			{ history: true },
		);
	};

	return (
		<div
			className={`${styles.pane} ${styles.isActive}`}
			style={{ minHeight: 0, display: "flex", flexDirection: "column" }}
		>
			<header
				className={styles.paneHead}
				style={{
					position: "relative",
					flexShrink: 0,
				}}
			>
				<span style={{ display: "inline-flex", alignItems: "center", color: "var(--muted)" }}>
					<CaptionsIcon size={14} />
				</span>
				<h2>{t("facets.captions")}</h2>
				{/* Its own provider, like `Toggle`: the pane renders without the app's root one in the
				    tests. */}
				{onClose ? (
					<TooltipProvider>
						<Tooltip content={tc("actions.close")}>
							<button
								type="button"
								className={styles.iconBtn}
								style={{ marginLeft: "auto" }}
								aria-label={tc("actions.close")}
								onClick={onClose}
							>
								<X size={14} />
							</button>
						</Tooltip>
					</TooltipProvider>
				) : null}
			</header>
			<div
				className={styles.paneBody}
				style={{
					padding: "8px 0 16px",
					minHeight: 0,
					flex: "1 1 auto",
					overflowY: "auto",
					overflowX: "hidden",
					scrollbarWidth: "thin",
					scrollbarColor: "var(--border) transparent",
				}}
			>
				<div className={styles.paneRow}>
					<span className={styles.label}>{t("captions.show")}</span>
					<Toggle
						checked={settings.enabled}
						disabled={disabled || !hasTranscript}
						onChange={(next) => void set({ enabled: next })}
					/>
				</div>

				{!hasTranscript ? (
					<div
						style={{
							margin: "0 var(--sp-4) 12px",
							padding: "14px",
							border: "1px dashed var(--border-hi)",
							borderRadius: 10,
							background: "var(--surface-2)",
							display: "flex",
							flexDirection: "column",
							gap: 10,
						}}
					>
						<p style={{ margin: 0, font: "400 12px/1.5 var(--font-body)", color: "var(--muted)" }}>
							{silentMedia ? te("mediaStage.noAudioTrackHint") : t("captions.noTranscript")}
						</p>
						{engineError ? (
							<p
								style={{
									margin: 0,
									font: "400 11.5px/1.5 var(--font-body)",
									color: "var(--danger)",
								}}
							>
								{engineError}
							</p>
						) : null}
						{/* No transcribe button here. This pane is reached from the transcript
						    tab, whose empty state carries the one gate — and two buttons for
						    one background pass is what made people believe captions were
						    transcribed separately from the transcript (issue #560). What is
						    worth saying here is whether a run is already going. */}
						{isTranscribing ? (
							<p
								style={{
									margin: 0,
									display: "inline-flex",
									alignItems: "center",
									gap: 6,
									font: "400 12px/1.5 var(--font-body)",
									color: "var(--muted)",
								}}
							>
								<Loader2 size={14} className="animate-spin" />
								{busyLabel ?? t("transcript.transcribing")}
							</p>
						) : null}
					</div>
				) : (
					<p
						style={{
							margin: "0 var(--sp-4) 12px",
							font: "400 11.5px/1.5 var(--font-body)",
							color: "var(--muted)",
						}}
					>
						{/* The cue count is only meaningful while the layer is on — deriving
						    cues short-circuits when it's off, so a "0 lines" reading there
						    would say the transcript is empty when it isn't. While a
						    regeneration is in flight the phase label matters more than the
						    count of cues about to be replaced. */}
						{busyLabel ??
							(settings.enabled
								? t("captions.derivedFromTranscript", { count: cues.length })
								: t("captions.hiddenHint"))}
					</p>
				)}

				{legacyCaptionAnnotations.length > 0 ? (
					<div
						style={{
							margin: "0 var(--sp-4) 12px",
							padding: "12px 14px",
							border: "1px solid var(--border)",
							borderRadius: 10,
							background: "var(--surface-2)",
							display: "flex",
							flexDirection: "column",
							gap: 8,
						}}
					>
						<p style={{ margin: 0, font: "400 11.5px/1.5 var(--font-body)", color: "var(--fg-2)" }}>
							{t("captions.legacyAnnotations", { count: legacyCaptionAnnotations.length })}
						</p>
						<button
							type="button"
							className={`${styles.btn} ${styles.btnSecondary}`}
							onClick={() => void clearLegacyCaptionAnnotations()}
						>
							<Trash2 size={13} />
							{t("captions.removeLegacyAnnotations")}
						</button>
					</div>
				) : null}

				{/* ── Style ──────────────────────────────────────────────── */}
				{/* Named looks first: each sets font, size, colour, light and how words move together.
				    Tuning anything below leaves none selected. */}
				<div className={styles.sectionLabel}>{t("captions.style")}</div>
				<div
					style={{
						margin: "0 var(--sp-4) 12px",
						display: "flex",
						flexDirection: "column",
						gap: 10,
					}}
				>
					<div
						role="tablist"
						aria-label={t("captions.style")}
						style={{ display: "flex", flexWrap: "wrap", gap: 4 }}
					>
						{[
							...(myTemplates.length > 0 ? ["mine"] : []),
							...CAPTION_STYLE_GROUPS.map((g) => g.id),
						].map((id) => (
							<button
								key={id}
								type="button"
								role="tab"
								aria-selected={styleGroup === id}
								onClick={() => setStyleGroup(id)}
								style={{
									padding: "3px 9px",
									borderRadius: 999,
									border: "1px solid var(--border)",
									background: styleGroup === id ? "var(--accent)" : "transparent",
									color: styleGroup === id ? "#fff" : "var(--fg-2)",
									font: "500 11.5px var(--font-body)",
									cursor: "pointer",
								}}
							>
								{t(`captions.styleGroups.${id}`)}
							</button>
						))}
					</div>
					{styleGroup === "mine" ? (
						<div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
							{myTemplates.map((template) => (
								<div key={template.name} style={{ display: "flex", gap: 4, alignItems: "center" }}>
									<button
										type="button"
										disabled={disabled}
										onClick={() => void set(template.settings)}
										style={{ ...selectStyle, flex: 1, textAlign: "left" }}
									>
										{template.name}
									</button>
									<button
										type="button"
										aria-label={t("captions.deleteTemplate", { name: template.name })}
										onClick={() => setMyTemplates(deleteCaptionTemplate(template.name))}
										style={{ ...selectStyle, minWidth: 32, padding: 0, textAlign: "center" }}
									>
										×
									</button>
								</div>
							))}
						</div>
					) : (
						<div
							role="group"
							aria-label={t(`captions.styleGroups.${styleGroup}`)}
							style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}
						>
							{(CAPTION_STYLE_GROUPS.find((g) => g.id === styleGroup)?.styles ?? []).map((id) => (
								<CaptionStyleTile
									key={id}
									id={id}
									label={t(`captions.styles.${id}`)}
									selected={currentStyle === id}
									disabled={disabled}
									onPick={() => void set(captionStylePatch(id, frameAspect))}
								/>
							))}
						</div>
					)}
					<form
						style={{ display: "flex", gap: 4 }}
						onSubmit={(event) => {
							event.preventDefault();
							const name = templateName.trim();
							if (!name) return;
							setMyTemplates(saveCaptionTemplate(name, settings));
							setTemplateName("");
							setStyleGroup("mine");
						}}
					>
						<input
							value={templateName}
							onChange={(event) => setTemplateName(event.target.value)}
							placeholder={t("captions.templateName")}
							aria-label={t("captions.templateName")}
							style={{ ...selectStyle, flex: 1, minWidth: 0, cursor: "text" }}
						/>
						<button type="submit" disabled={!templateName.trim()} style={selectStyle}>
							{t("captions.saveTemplate")}
						</button>
					</form>
					<button
						type="button"
						disabled={disabled || !hasTranscript || reading}
						onClick={() => void handleClaudeRead()}
						style={{
							...selectStyle,
							display: "inline-flex",
							alignItems: "center",
							justifyContent: "center",
							gap: 6,
						}}
					>
						{reading ? <Loader2 size={14} className="animate-spin" /> : null}
						{reading ? t("captions.claudeReading") : t("captions.claudeRead")}
					</button>
					{readNote ? (
						<p
							style={{
								margin: 0,
								font: "400 11.5px/1.5 var(--font-body)",
								color: readFailed ? "var(--danger)" : "var(--muted)",
							}}
						>
							{readNote}
						</p>
					) : null}
					<div
						style={{
							display: "flex",
							alignItems: "center",
							justifyContent: "space-between",
							gap: 8,
						}}
					>
						<span className={styles.fieldLabel}>{t("captions.emoji")}</span>
						<Toggle
							ariaLabel={t("captions.emoji")}
							checked={settings.emoji}
							disabled={disabled}
							onChange={(emoji) => void set({ emoji })}
						/>
					</div>
					<div
						style={{
							display: "flex",
							alignItems: "center",
							justifyContent: "space-between",
							gap: 8,
						}}
					>
						<span className={styles.fieldLabel}>{t("captions.avoidFace")}</span>
						<Toggle
							ariaLabel={t("captions.avoidFace")}
							checked={settings.avoidFace}
							disabled={disabled}
							onChange={(avoidFace) => void set({ avoidFace })}
						/>
					</div>
				</div>

				{/* ── Language ───────────────────────────────────────────── */}
				<div className={styles.sectionLabel}>{t("captions.translate")}</div>
				{/* Only once there is a translation to switch to: alone, "Original" would be a
				    button that changes nothing. */}
				{languageOptions.length > 0 ? (
					<div className={`${styles.field} ${styles.fieldStack}`}>
						<span className={styles.fieldLabel}>{t("captions.displayLanguage")}</span>
						<ChoiceRow<string>
							label={t("captions.displayLanguage")}
							columns={2}
							options={[
								{ value: "", label: t("captions.original") },
								...languageOptions.map((entry) => ({ value: entry.language, label: entry.label })),
							]}
							value={settings.language ?? ""}
							disabled={disabled}
							onChange={(language) => void set({ language: language || null })}
						/>
					</div>
				) : null}

				<div
					style={{
						margin: "0 var(--sp-4) 12px",
						display: "flex",
						alignItems: "center",
						gap: 8,
					}}
				>
					<select
						value={target}
						disabled={disabled || translating}
						onChange={(e) => setTarget(e.target.value)}
						style={{ ...selectStyle, flex: 1, minWidth: 0 }}
					>
						{TRANSLATION_LANGUAGES.map((language) => (
							<option key={language.code} value={language.code}>
								{language.label}
							</option>
						))}
					</select>
					<button
						type="button"
						className={`${styles.btn} ${styles.btnSecondary}`}
						style={{ flexShrink: 0 }}
						disabled={disabled || translating || !hasTranscript}
						onClick={() => void handleTranslate()}
						title={t("captions.translateHint")}
					>
						{translating ? <Loader2 size={13} className="animate-spin" /> : <Languages size={13} />}
						{translating ? t("captions.translating") : t("captions.translate")}
					</button>
				</div>
				{settings.language ? (
					<button
						type="button"
						className={`${styles.btn} ${styles.btnSecondary}`}
						style={{ margin: "0 var(--sp-4) 12px" }}
						disabled={disabled}
						onClick={() => void deleteTranslation(settings.language as string)}
					>
						<Trash2 size={13} />
						{t("captions.deleteTranslation")}
					</button>
				) : null}
				{translateError ? (
					<p
						style={{
							margin: "0 var(--sp-4) 12px",
							font: "400 11.5px/1.5 var(--font-body)",
							color: "var(--danger)",
						}}
					>
						{translateError}
					</p>
				) : null}
				<p
					style={{
						margin: "0 var(--sp-4) 14px",
						font: "400 11px/1.5 var(--font-body)",
						color: "var(--muted)",
					}}
				>
					{t("captions.translationIsNonDestructive")}
				</p>

				{/* ── Customise ─────────────────────────────────────────── */}
				{/* The detailed look controls, folded behind the named styles above: still one
				    click away, never the first thing to read. */}
				<details>
					<summary className={styles.sectionLabel} style={{ cursor: "pointer" }}>
						{t("captions.customize")}
					</summary>
					<div className={styles.sectionLabel}>{t("captions.text")}</div>
					<div className={`${styles.field} ${styles.fieldStack}`}>
						<span className={styles.fieldLabel}>{t("captions.font")}</span>
						{/* Only the families the compositor ships: it never reads the machine's
						    installed fonts, so any other name would draw a fallback. Each button is a
						    specimen, in the face it picks. */}
						<ChoiceRow<string>
							label={t("captions.font")}
							columns={2}
							options={TEXT_FONT_FAMILIES.map((font) => ({
								value: font,
								label: font,
								icon: <span style={{ fontFamily: font }}>{font}</span>,
								// The specimen already spells the name.
								title: null,
							}))}
							value={settings.fontFamily}
							disabled={disabled}
							onChange={(fontFamily) => void set({ fontFamily })}
						/>
					</div>
					<div className={styles.paneRow}>
						<span className={styles.label}>{t("captions.bold")}</span>
						<Toggle
							checked={settings.fontWeight === "bold"}
							disabled={disabled}
							onChange={(next) => void set({ fontWeight: next ? "bold" : "normal" })}
						/>
					</div>
					<div className={styles.sliderGrid}>
						<SliderCell
							label={t("captions.fontSize")}
							value={settings.fontSize}
							min={CAPTION_FONT_SIZE_MIN}
							max={CAPTION_FONT_SIZE_MAX}
							defaultValue={DEFAULT_CAPTION_SETTINGS.fontSize}
							suffix="px"
							disabled={disabled}
							onChange={(v) => setLive({ fontSize: v })}
							onCommit={() => void commit()}
						/>
					</div>
					<div className={styles.paneRow}>
						<span className={styles.label}>{t("captions.allCaps")}</span>
						<Toggle
							checked={settings.textCase === "upper"}
							disabled={disabled}
							onChange={(next) => void set({ textCase: next ? "upper" : "as-spoken" })}
						/>
					</div>
					{settings.activeWordColor ? (
						<div className={styles.paneRow}>
							<span className={styles.label}>{t("captions.activeWordColor")}</span>
							<TextColorField
								label={t("captions.activeWordColor")}
								value={settings.activeWordColor}
								plate="transparent"
								disabled={disabled}
								onChange={(activeWordColor) => setLive({ activeWordColor })}
								onCommit={() => void commit()}
							/>
						</div>
					) : null}
					{settings.emphasis !== "none" ? (
						<div className={styles.paneRow}>
							<span className={styles.label}>{t("captions.emphasisColor")}</span>
							<TextColorField
								label={t("captions.emphasisColor")}
								value={settings.emphasisColor}
								plate="transparent"
								disabled={disabled}
								onChange={(emphasisColor) => setLive({ emphasisColor })}
								onCommit={() => void commit()}
							/>
						</div>
					) : null}
					<div className={styles.paneRow}>
						<span className={styles.label}>{t("captions.textColor")}</span>
						<TextColorField
							label={t("captions.textColor")}
							value={settings.color}
							plate={settings.backgroundEnabled ? settings.backgroundColor : "transparent"}
							disabled={disabled}
							onChange={(color) => setLive({ color })}
							onCommit={() => void commit()}
						/>
					</div>

					{/* ── Background ─────────────────────────────────────────── */}
					{/* Named plates, like the annotation pane's: the plate choice alone turns it on
				    or off, and choosing one moves text that would vanish on it. An older free
				    colour stays shown while the project carries it. */}
					<div className={styles.sectionLabel}>{t("captions.background")}</div>
					<div style={{ margin: "0 var(--sp-4) 10px" }}>
						<ChoiceRow<CaptionPlate | "custom">
							label={t("captions.background")}
							disabled={disabled}
							options={[
								{ value: "none", label: t("textPlate.none") },
								{ value: "dark", label: t("textPlate.dark") },
								{ value: "light", label: t("textPlate.light") },
								...(plate === "custom"
									? [{ value: "custom" as const, label: t("textPlate.custom") }]
									: []),
							]}
							value={plate}
							onChange={(next) => {
								if (next !== "custom") void set(captionPlatePatch(settings, next));
							}}
						/>
					</div>
					{settings.backgroundEnabled ? (
						<div className={styles.sliderGrid}>
							<SliderCell
								label={t("captions.backgroundOpacity")}
								value={Math.round(settings.backgroundOpacity * 100)}
								min={CAPTION_PLATE_OPACITY_MIN * 100}
								max={CAPTION_PLATE_OPACITY_MAX * 100}
								defaultValue={Math.round(DEFAULT_CAPTION_SETTINGS.backgroundOpacity * 100)}
								suffix="%"
								disabled={disabled}
								onChange={(v) => setLive({ backgroundOpacity: v / 100 })}
								onCommit={() => void commit()}
							/>
						</div>
					) : null}
				</details>

				{/* ── Placement ──────────────────────────────────────────── */}
				{/* One control per axis, each naming the edge it measures from. The old pane
				    had four that overlapped: a band width nothing drew, an offset measured
				    against that invisible band, and a text alignment fighting the offset for
				    the same visual outcome. */}
				<div className={styles.sectionLabel}>{t("captions.position")}</div>
				{/* Same 3-column picker as the camera position, minus the middle row: a
				    caption is anchored to the top or bottom edge, never the centre. */}
				<div style={{ padding: "0 var(--sp-4) 12px" }}>
					<ChoiceRow<string>
						label={t("captions.position")}
						columns={3}
						options={CAPTION_ANCHORS.map(([v, h]) => ({
							value: `${v}-${h}`,
							label: t(CAPTION_ANCHOR_KEYS[`${v}-${h}`]),
							icon: captionAnchorIcon(v, h),
						}))}
						value={`${settings.anchorV}-${settings.anchorH}`}
						disabled={disabled}
						onChange={(key) => {
							const [anchorV, anchorH] = key.split("-") as [CaptionAnchorV, CaptionAnchorH];
							void set({ anchorV, anchorH });
						}}
					/>
				</div>
				<div className={styles.sliderGrid}>
					<SliderCell
						label={
							settings.anchorV === "bottom"
								? t("captions.distanceFromBottom")
								: t("captions.distanceFromTop")
						}
						value={settings.insetY}
						min={0}
						max={CAPTION_INSET_Y_MAX}
						defaultValue={DEFAULT_CAPTION_SETTINGS.insetY}
						step={0.5}
						decimals={1}
						suffix="%"
						disabled={disabled}
						onChange={(v) => setLive({ insetY: v })}
						onCommit={() => void commit()}
					/>
				</div>

				{/* Centre has no edge to measure from, so the control is ABSENT rather than
				    disabled — a dead slider reads as a bug. */}
				{settings.anchorH === "center" ? null : (
					<div className={styles.sliderGrid}>
						<SliderCell
							label={
								settings.anchorH === "left"
									? t("captions.distanceFromLeft")
									: t("captions.distanceFromRight")
							}
							value={settings.insetX}
							min={0}
							max={CAPTION_INSET_X_MAX}
							defaultValue={DEFAULT_CAPTION_SETTINGS.insetX}
							step={0.5}
							decimals={1}
							suffix="%"
							disabled={disabled}
							onChange={(v) => setLive({ insetX: v })}
							onCommit={() => void commit()}
						/>
					</div>
				)}

				{/* ── Line length ────────────────────────────────────────── */}
				{/* Two counts on one scale, so two sliders; each stops at the other, so the
				    minimum never passes the maximum. */}
				<div className={styles.sectionLabel}>{t("captions.lineLength")}</div>
				<div className={styles.sliderGrid}>
					<SliderCell
						label={t("captions.minWords")}
						value={settings.minWordsPerLine}
						min={CAPTION_WORDS_PER_LINE_MIN}
						max={CAPTION_WORDS_PER_LINE_MAX}
						defaultValue={DEFAULT_CAPTION_SETTINGS.minWordsPerLine}
						showValue
						disabled={disabled}
						onChange={(v) => setLive({ minWordsPerLine: Math.min(v, settings.maxWordsPerLine) })}
						onCommit={() => void commit()}
					/>
					<SliderCell
						label={t("captions.maxWords")}
						value={settings.maxWordsPerLine}
						min={CAPTION_WORDS_PER_LINE_MIN}
						max={CAPTION_WORDS_PER_LINE_MAX}
						defaultValue={DEFAULT_CAPTION_SETTINGS.maxWordsPerLine}
						showValue
						disabled={disabled}
						onChange={(v) => setLive({ maxWordsPerLine: Math.max(v, settings.minWordsPerLine) })}
						onCommit={() => void commit()}
					/>
				</div>
			</div>
		</div>
	);
}

/** A style, shown the way it will look: a frame the compositor drew (`scripts/caption-style-thumbs.py`). */
function CaptionStyleTile({
	id,
	label,
	selected,
	disabled,
	onPick,
}: {
	id: CaptionStyleId;
	label: string;
	selected: boolean;
	disabled: boolean;
	onPick: () => void;
}) {
	return (
		<button
			type="button"
			aria-label={label}
			aria-pressed={selected}
			disabled={disabled}
			onClick={onPick}
			style={{
				display: "flex",
				flexDirection: "column",
				gap: 6,
				padding: 0,
				background: "transparent",
				border: "none",
				cursor: disabled ? "default" : "pointer",
				font: "500 12px var(--font-body)",
				color: selected ? "var(--accent)" : "var(--fg-2)",
				textAlign: "center",
			}}
		>
			<img
				src={getAssetPath(`caption-styles/${id}.webp`)}
				alt=""
				loading="lazy"
				style={{
					width: "100%",
					aspectRatio: "16 / 9",
					objectFit: "cover",
					borderRadius: 10,
					background: "#16181d",
					outline: selected ? "2px solid var(--accent)" : "1px solid var(--border)",
					outlineOffset: selected ? 1 : 0,
				}}
			/>
			{label}
		</button>
	);
}

const selectStyle: React.CSSProperties = {
	height: 32,
	padding: "0 10px",
	borderRadius: 8,
	border: "1px solid var(--border)",
	background: "var(--surface-2)",
	color: "var(--fg)",
	font: "500 12.5px var(--font-body)",
	minWidth: 120,
	cursor: "pointer",
};
