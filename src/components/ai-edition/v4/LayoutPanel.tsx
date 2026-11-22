import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { toFileUrl } from "@/components/video-editor/projectPersistence";
import type { SceneChoice } from "@/components/video-editor/types";
import { useScopedT } from "@/contexts/I18nContext";
import type { GraphicTemplate } from "@/lib/ai-edition/annotations/graphics";
import {
	formatFillAvailability,
	resolveAspectRatioValue,
} from "@/lib/ai-edition/document/outputFormat";
import { clipLabel } from "@/lib/ai-edition/document/script";
import {
	type EditorSettingsPatch,
	type EditorSettingsSnapshot,
	SEGMENT_LOOK_KEYS,
	splitLookPatch,
} from "@/lib/ai-edition/store/editorSettings";
import { useProjectStore } from "@/lib/ai-edition/store/projectStore";
import { useEditorSettings } from "@/lib/ai-edition/store/useEditorSettings";
import type { useTimeline } from "@/lib/ai-edition/store/useTimeline";
import type { StylePreset } from "@/lib/ai-edition/stylePresets";
import {
	stylePresetAppearanceFromSettings,
	stylePresetPatch,
} from "@/lib/ai-edition/stylePresetsEditor";
import { assetCameraSource, hasAnyClipWithCamera } from "@/lib/ai-edition/timeline/camera";
import { sceneForFormat, scenesForFormat } from "@/lib/ai-edition/timeline/scenes";
import { clipTakes } from "@/lib/ai-edition/timeline/takeSegments";
import { useSceneLabels } from "@/lib/ai-edition/timeline/useSceneLabels";
import { nativeBridgeClient } from "@/native";
import { FormatField } from "../RightPanes";
import styles from "./EditorShellV4.module.css";
import { LayoutThumb, layoutBoxes } from "./layoutThumb";

type Timeline = ReturnType<typeof useTimeline>;

/** The clip the menu acts on: the one the program is showing. */
function useTargetClip(tl: Timeline) {
	const timeSec = useProjectStore((s) => s.currentTimeSec);
	const clips = tl.clips;
	const underPlayhead = clips.findIndex(
		(c) => c.timelineStartSec <= timeSec && timeSec < c.timelineEndSec,
	);
	const index = underPlayhead >= 0 ? underPlayhead : clips.length - 1;
	const target = clips[index];
	return { clips, target, index, at: target ? Math.min(timeSec, target.timelineEndSec) : 0 };
}

/** The sizes a drawing of a layout needs, for the clip under the playhead. */
function useLayoutFrame(tl: Timeline, settings: EditorSettingsSnapshot) {
	const document = useProjectStore((s) => s.document);
	const { target } = useTargetClip(tl);
	const asset = document?.assets.find((a) => a.id === target?.assetId);
	const aspect = resolveAspectRatioValue(document, settings.aspectRatio);
	const fill =
		settings.formatFollowCursor === true &&
		!!document &&
		formatFillAvailability(document) === "available";
	const screenWidth = asset?.video?.width ?? 1920;
	const screenHeight = asset?.video?.height ?? 1080;
	const cameraWidth = asset?.cameraTrack?.width ?? 1280;
	const cameraHeight = asset?.cameraTrack?.height ?? 720;
	return useMemo(
		() => ({
			aspect,
			fill,
			screen: { width: screenWidth, height: screenHeight },
			camera: { width: cameraWidth, height: cameraHeight },
		}),
		[aspect, fill, screenWidth, screenHeight, cameraWidth, cameraHeight],
	);
}

/** Which tile a look shows as. */
function choiceOf(settings: EditorSettingsSnapshot, portrait: boolean): SceneChoice {
	if (settings.segmentScene) return settings.segmentScene;
	if (settings.webcamLayoutPreset === "no-webcam") return "screen";
	return sceneForFormat(settings.webcamLayoutPreset, portrait);
}

/** A saved look as a patch: only what a segment can have of its own. */
function presetLook(preset: StylePreset): EditorSettingsPatch {
	return (preset.appearance.look ??
		splitLookPatch(stylePresetPatch(preset.appearance)).look) as EditorSettingsPatch;
}

/** The attempts at a segment that was said again. Any of them can be the one on the timeline. */
export function TakeRow({ tl, onSeek }: { tl: Timeline; onSeek: (sec: number) => void }) {
	const t = useScopedT("editor");
	const { target } = useTargetClip(tl);
	// Every hook before the early return: the clip under the playhead gains its attempts after the
	// editor opens on a fresh take, and a hook skipped on the first render throws and blanks it.
	const assetIds = useProjectStore((s) => s.document?.assets.map((a) => a.id).join("|") ?? "");
	if (!target?.alternates?.length) return null;
	const { takes, current } = clipTakes(target, assetIds.split("|"));
	return (
		<div className={styles.takeRow} role="group" aria-label={t("studio.takes")}>
			{t("studio.take")}
			{takes.map((take, number) => (
				<button
					type="button"
					key={`${take.assetId ?? ""}:${take.sourceStartSec}`}
					aria-pressed={current === number}
					onClick={() => {
						if (current === number) return;
						// The take changes how long the clip is, so the playhead stays put no longer: it
						// could land in another clip or past them all. The picked take plays from its start.
						const startSec = target.timelineStartSec;
						void tl.showClipTake(target.id, take).then(() => onSeek(startSec));
					}}
				>
					{number + 1}
				</button>
			))}
		</div>
	);
}

/**
 * The ready overlays, and the looks you saved. A press starts this segment from it; everything
 * else is then adjusted on the right, for this segment alone. Its own component because it reads
 * the playhead, which moves on every frame of playback.
 */
function LayoutGrid({ tl, onSeek }: { tl: Timeline; onSeek: (sec: number) => void }) {
	const sceneLabels = useSceneLabels();
	const t = useScopedT("editor");
	const timeSec = useProjectStore((s) => s.currentTimeSec);
	const { settings, set } = useEditorSettings();
	const frame = useLayoutFrame(tl, settings);
	const portrait = frame.aspect < 1;
	const { clips, target, index } = useTargetClip(tl);
	const document = useProjectStore((s) => s.document);
	const hasCamera = !!assetCameraSource(document?.assets.find((a) => a.id === target?.assetId))
		.path;
	const current = choiceOf(settings, portrait);

	// A clip eases in from the one before, so right after its start the program is still between
	// the two. To see what a press does, stand past that.
	const showSettled = useCallback(() => {
		if (!target || index === 0) return;
		const settled =
			target.timelineStartSec +
			Math.min(1.1, (target.timelineEndSec - target.timelineStartSec) / 2);
		if (timeSec < settled) onSeek(settled);
	}, [target, index, timeSec, onSeek]);

	const choose = (choice: SceneChoice) => {
		if (!target) return;
		const patch: EditorSettingsPatch =
			choice === "camera" || choice === "screen"
				? { segmentScene: choice }
				: {
						segmentScene: null,
						webcamLayoutPreset: choice,
						// A cut-out chosen by hand on another layout does not carry over.
						...(settings.webcamBackgroundMode === "transparent"
							? { webcamBackgroundMode: "none" as const }
							: {}),
					};
		void set(patch);
		showSettled();
	};

	const [presets, setPresets] = useState<StylePreset[]>([]);
	const [naming, setNaming] = useState<string | null>(null);
	const loadPresets = useCallback(async () => {
		setPresets(await nativeBridgeClient.presets.list().catch(() => []));
	}, []);
	useEffect(() => {
		void loadPresets();
	}, [loadPresets]);

	const savePreset = async () => {
		const name = naming?.trim();
		if (!name) return;
		const look = Object.fromEntries(
			SEGMENT_LOOK_KEYS.map((key) => [key, (settings as unknown as Record<string, unknown>)[key]]),
		);
		try {
			await nativeBridgeClient.presets.create(name, {
				...stylePresetAppearanceFromSettings(settings),
				look,
			});
			setNaming(null);
			await loadPresets();
			toast.success(t("studio.presetSaved", { name }));
		} catch (error) {
			toast.error(error instanceof Error ? error.message : String(error));
		}
	};
	const removePreset = async (id: string) => {
		await nativeBridgeClient.presets.delete(id);
		await loadPresets();
	};

	const tile = (choice: SceneChoice) => (
		<button
			type="button"
			key={choice}
			className={styles.layoutTile}
			aria-pressed={current === choice}
			disabled={!hasCamera}
			onClick={() => choose(choice)}
		>
			<LayoutThumb aspect={frame.aspect} boxes={layoutBoxes(settings, choice, frame)} />
			{sceneLabels[choice]}
		</button>
	);
	const sameLook = (preset: StylePreset) => {
		const look = presetLook(preset) as Record<string, unknown>;
		const own = settings as unknown as Record<string, unknown>;
		return Object.keys(look).every(
			(key) => JSON.stringify(look[key] ?? null) === JSON.stringify(own[key] ?? null),
		);
	};
	return (
		<>
			<div className={styles.layoutHeading}>
				Layout
				{target ? <span>{clipLabel(document, target, index)}</span> : null}
			</div>
			<div className={styles.layoutGrid}>{scenesForFormat(portrait).map(tile)}</div>
			<button
				type="button"
				className={styles.layoutAll}
				disabled={clips.length < 2 || !target}
				onClick={() => target && void tl.applyLookToAll(target.id)}
			>
				{t("studio.applyToAll")}
			</button>
			<div className={styles.layoutHeading} style={{ paddingTop: 12 }}>
				{t("studio.myPresets")}
				<span>{t("studio.everyProject")}</span>
			</div>
			<div className={styles.layoutGrid}>
				{presets.map((preset) => {
					const look = { ...settings, ...presetLook(preset) } as EditorSettingsSnapshot;
					return (
						<div key={preset.id} className={styles.myLook}>
							<button
								type="button"
								className={styles.layoutTile}
								aria-pressed={sameLook(preset)}
								title={preset.name}
								onClick={() => {
									void set(presetLook(preset));
									showSettled();
								}}
							>
								<LayoutThumb
									aspect={frame.aspect}
									boxes={layoutBoxes(look, choiceOf(look, portrait), frame)}
								/>
								<span className={styles.myLookName}>{preset.name}</span>
							</button>
							<button
								type="button"
								className={styles.myLookDelete}
								aria-label={t("studio.deleteNamed", { name: preset.name })}
								onClick={() => void removePreset(preset.id)}
							>
								×
							</button>
						</div>
					);
				})}
				<button
					type="button"
					className={`${styles.layoutTile} ${styles.myLookAdd}`}
					onClick={() => setNaming(t("studio.myLook", { number: presets.length + 1 }))}
				>
					+<span>{t("studio.save")}</span>
				</button>
			</div>
			{naming !== null ? (
				<form
					className={styles.myLookForm}
					onSubmit={(event) => {
						event.preventDefault();
						void savePreset();
					}}
				>
					<input
						aria-label={t("studio.name")}
						// biome-ignore lint/a11y/noAutofocus: it opened from the press that asked for a name.
						autoFocus
						value={naming}
						onChange={(event) => setNaming(event.target.value)}
						onBlur={() => {
							if (!naming.trim()) setNaming(null);
						}}
					/>
					<button type="submit">OK</button>
				</form>
			) : null}
		</>
	);
}

/** The motion graphics, each shown as itself. A press puts one on the clip with its own wording. */
function GraphicsGrid({ tl, onSeek }: { tl: Timeline; onSeek: (sec: number) => void }) {
	const t = useScopedT("editor");
	const timeSec = useProjectStore((s) => s.currentTimeSec);
	const document = useProjectStore((s) => s.document);
	const { settings } = useEditorSettings();
	const portrait = resolveAspectRatioValue(document, settings.aspectRatio) < 1;
	const { target, index, at } = useTargetClip(tl);
	const [templates, setTemplates] = useState<GraphicTemplate[]>([]);
	const [stills, setStills] = useState<Record<string, string>>({});
	const [busy, setBusy] = useState<string | null>(null);

	useEffect(() => {
		let live = true;
		void (async () => {
			const list = await window.electronAPI.graphics.list();
			if (!live) return;
			setTemplates(list);
			for (const template of list) {
				const still = await window.electronAPI.graphics
					.preview({
						templateId: template.id,
						width: portrait ? 270 : 480,
						height: portrait ? 480 : 270,
					})
					.catch(() => null);
				if (!live) return;
				if (still) setStills((known) => ({ ...known, [`${template.id}:${portrait}`]: still }));
			}
		})();
		return () => {
			live = false;
		};
	}, [portrait]);

	const add = async (template: GraphicTemplate) => {
		if (!target) return;
		setBusy(template.id);
		await tl.addGraphic(template, at, target.timelineEndSec);
		setBusy(null);
		if (at !== timeSec) onSeek(at);
	};
	return (
		<>
			<div className={styles.layoutHeading}>
				{t("studio.graphics")}
				{target ? <span>{clipLabel(document, target, index)}</span> : null}
			</div>
			<div className={styles.graphicGrid}>
				{templates.map((template) => {
					const still = stills[`${template.id}:${portrait}`];
					return (
						<button
							type="button"
							key={template.id}
							className={styles.layoutTile}
							disabled={!target || busy !== null}
							onClick={() => void add(template)}
						>
							<span
								className={styles.graphicStill}
								style={{ aspectRatio: portrait ? "9/16" : "16/9" }}
							>
								{still ? <img src={toFileUrl(still)} alt="" /> : null}
							</span>
							{busy === template.id ? t("studio.rendering") : template.name}
						</button>
					);
				})}
			</div>
			<button
				type="button"
				className={styles.layoutAll}
				onClick={() => void window.electronAPI.graphics.openFolder()}
			>
				{t("studio.graphicsFolder")}
			</button>
		</>
	);
}

/** Beside the program window: the format of the whole project, the layout of each clip, the graphics. */
export function LayoutPanel({ tl, onSeek }: { tl: Timeline; onSeek: (sec: number) => void }) {
	const t = useScopedT("editor");
	const hasAnyCamera = useMemo(
		() => hasAnyClipWithCamera(tl.assets, tl.clips),
		[tl.assets, tl.clips],
	);
	const [tab, setTab] = useState<"layout" | "graphics">("layout");
	const projectId = useProjectStore((s) => s.projectId);
	const document = useProjectStore((s) => s.document);
	const { settings } = useEditorSettings();
	const aspect = resolveAspectRatioValue(document, settings.aspectRatio);
	const refreshGraphics = useRef(tl.refreshGraphics);
	refreshGraphics.current = tl.refreshGraphics;
	// biome-ignore lint/correctness/useExhaustiveDependencies: runs when the project or its format changes.
	useEffect(() => {
		void refreshGraphics.current();
	}, [projectId, aspect]);
	return (
		<aside className={styles.layoutPanel} aria-label={t("studio.formatAndLayout")}>
			<div className={styles.panelTabs} role="tablist">
				<button
					type="button"
					role="tab"
					aria-selected={tab === "layout"}
					onClick={() => setTab("layout")}
				>
					Layout
				</button>
				<button
					type="button"
					role="tab"
					aria-selected={tab === "graphics"}
					onClick={() => setTab("graphics")}
				>
					{t("studio.graphics")}
				</button>
			</div>
			{tab === "layout" ? (
				<>
					<FormatField />
					<TakeRow tl={tl} onSeek={onSeek} />
					{/* Absent, not greyed out, in a project with no camera: there is only one way to show it. */}
					{hasAnyCamera ? <LayoutGrid tl={tl} onSeek={onSeek} /> : null}
				</>
			) : (
				<GraphicsGrid tl={tl} onSeek={onSeek} />
			)}
		</aside>
	);
}
