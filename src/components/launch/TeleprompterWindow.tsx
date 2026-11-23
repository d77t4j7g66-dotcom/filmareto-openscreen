import {
	ChevronDown,
	ChevronRight,
	ChevronUp,
	Eye,
	type LucideIcon,
	Mic,
	Minus,
	PanelTop,
	Play,
	Plus,
	RotateCcw,
	SkipBack,
	SkipForward,
} from "lucide-react";
import { createContext, type ReactNode, useContext, useEffect, useState } from "react";
import { useScopedT } from "@/contexts/I18nContext";
import { bindingConflict, captureKey } from "../../../electron/teleprompter/shared/hotkeyKeys";
import {
	HOTKEY_ACTIONS,
	type HotkeyAction,
	type HotkeyBinding,
} from "../../../electron/teleprompter/shared/protocol";
import { bindingParts, positionPatch } from "../../../electron/teleprompter/shared/settings";

type Position = "screen" | "fullscreen";
type Mode = "voice" | "manual" | "bullets";
type Settings = {
	position: Position;
	mode: Mode;
	fontSize: number;
	visibleLines: number;
	width: number;
	opacity: number;
	screenOpacity: number;
	mirror: boolean;
	speed: number;
	displayId: number | null;
	displayPicked: boolean;
	activeLine: number;
	paddingH: number;
	paddingV: number;
	lineSpacing: number;
	showGuide: boolean;
	cameraOpacity: number;
};
type State = {
	open: boolean;
	playing: boolean;
	stageIndex: number;
	stageCount: number;
	status: string;
	message: string;
	micName: string;
	micDevices: { id: string; name: string; isDefault: boolean }[];
	micDeviceId: string | null;
	settings: Settings;
	hasScript: boolean;
	hotkeys: HotkeyBinding[];
	failedHotkeys: HotkeyAction[];
	cameraPreview: { enabled: boolean; displayId: number | null };
	cameraOn: boolean;
	cameraPreviewError: string;
	helperError: string;
	displays: { id: number; label: string }[];
	primaryDisplayId: number;
	secondaryDisplayId: number | null;
	/** Full screen on a display other than the main one: where the camera can sit behind text. */
	cameraBehindText: boolean;
};
type Bridge = {
	perform: (action: string) => Promise<void>;
	set: (patch: Partial<Settings>) => Promise<void>;
	setCameraPreview: (patch: { enabled?: boolean; displayId?: number | null }) => Promise<void>;
	setMic: (deviceId: string | null) => Promise<void>;
	setHotkeys: (bindings: HotkeyBinding[]) => Promise<void>;
	suspendHotkeys: (suspended: boolean) => Promise<void>;
	listMics: () => Promise<void>;
	state: () => Promise<State>;
	onState: (listener: (state: State) => void) => () => void;
};

const ICON_SIZE = 16;
const ICON_STROKE = 1.5;
const Icon = ({ icon: Glyph }: { icon: LucideIcon }) => (
	<Glyph size={ICON_SIZE} strokeWidth={ICON_STROKE} aria-hidden="true" />
);

const ACTION_ICONS: Record<HotkeyAction, LucideIcon> = {
	playPause: Play,
	nextLine: ChevronDown,
	prevLine: ChevronUp,
	nextStage: SkipForward,
	prevStage: SkipBack,
	retakeStage: RotateCcw,
	faster: Plus,
	slower: Minus,
	toggleMode: Mic,
	toggleVisible: Eye,
	cyclePosition: PanelTop,
};

type T = ReturnType<typeof useScopedT>;
const modesOf = (t: T): { id: Mode; label: string }[] => [
	{ id: "voice", label: t("scene.modeVoice") },
	{ id: "manual", label: t("scene.manual") },
	{ id: "bullets", label: t("scene.modeBullets") },
];
const positionsOf = (t: T): { id: "fullscreen" | "screen"; label: string }[] => [
	{ id: "fullscreen", label: t("scene.posFull") },
	{ id: "screen", label: t("scene.posTop") },
];

/** The same controls on the dark settings window and on the editor's light Record tab. */
const LightTone = createContext(false);

function Segmented<Id extends string>({
	options,
	value,
	onChange,
}: {
	options: { id: Id; label: string }[];
	value: Id | null;
	onChange: (id: Id) => void;
}) {
	const light = useContext(LightTone);
	return (
		<div className={`flex gap-1 rounded-lg p-1 ${light ? "bg-black/5" : "bg-zinc-900"}`}>
			{options.map((option) => {
				const active = option.id === value;
				const tone = light
					? active
						? "bg-[#ee6c0e] text-[#231003]"
						: "text-inherit hover:bg-black/5"
					: active
						? "bg-zinc-700 text-zinc-50"
						: "text-zinc-400 hover:text-zinc-200";
				return (
					<button
						key={option.id}
						type="button"
						aria-pressed={active}
						onClick={() => onChange(option.id)}
						className={`h-8 flex-1 rounded-md px-3 text-xs font-medium ${tone}`}
					>
						{option.label}
					</button>
				);
			})}
		</div>
	);
}

function Switch({
	label,
	checked,
	disabled,
	onChange,
}: {
	label: string;
	checked: boolean;
	disabled?: boolean;
	onChange: (checked: boolean) => void;
}) {
	const light = useContext(LightTone);
	const on = light ? "bg-[#ee6c0e]" : "bg-zinc-100";
	return (
		<button
			type="button"
			role="switch"
			aria-checked={checked}
			aria-label={label}
			disabled={disabled}
			onClick={() => onChange(!checked)}
			className={`relative h-5 w-9 shrink-0 rounded-full disabled:opacity-40 ${checked ? on : light ? "bg-black/20" : "bg-zinc-700"}`}
		>
			<span
				className={`absolute top-0.5 size-4 rounded-full ${
					checked
						? light
							? "left-[18px] bg-white"
							: "left-[18px] bg-zinc-900"
						: "left-0.5 bg-zinc-400"
				}`}
			/>
		</button>
	);
}

function Row({ label, children }: { label: string; children: ReactNode }) {
	const light = useContext(LightTone);
	return (
		<label className={`flex items-center gap-3 text-xs ${light ? "" : "text-zinc-300"}`}>
			<span className="w-32 shrink-0">{label}</span>
			{children}
		</label>
	);
}

function Select({
	label,
	value,
	onChange,
	children,
}: {
	label: string;
	value: string;
	onChange: (value: string) => void;
	children: ReactNode;
}) {
	const light = useContext(LightTone);
	return (
		<Row label={label}>
			<select
				className={`h-8 min-w-0 flex-1 rounded-md px-2 text-xs ${light ? "bg-black/5" : "bg-zinc-800 text-zinc-100"}`}
				value={value}
				onChange={(event) => onChange(event.target.value)}
			>
				{children}
			</select>
		</Row>
	);
}

function Slider({
	label,
	value,
	min,
	max,
	step = 1,
	shown,
	onChange,
}: {
	label: string;
	value: number;
	min: number;
	max: number;
	step?: number;
	shown?: string;
	onChange: (value: number) => void;
}) {
	const light = useContext(LightTone);
	return (
		<Row label={label}>
			<input
				type="range"
				className={`h-1 min-w-0 flex-1 cursor-pointer rounded-full ${light ? "bg-black/15" : "bg-zinc-700"}`}
				value={value}
				min={min}
				max={max}
				step={step}
				onChange={(event) => onChange(Number(event.target.value))}
			/>
			<span
				className={`w-10 shrink-0 text-right tabular-nums ${light ? "opacity-60" : "text-zinc-400"}`}
			>
				{shown ?? value}
			</span>
		</Row>
	);
}

function Section({
	title,
	collapsed,
	children,
}: {
	title: string;
	/** Present: the section opens and closes, and starts closed when true. */
	collapsed?: boolean;
	children: ReactNode;
}) {
	const light = useContext(LightTone);
	const [closed, setClosed] = useState(collapsed ?? false);
	const heading = `text-xs font-medium ${light ? "opacity-60" : "text-zinc-400"}`;
	return (
		<section
			className={`flex flex-col gap-3 border-t py-4 first:border-t-0 ${light ? "border-black/10" : "border-zinc-800"}`}
		>
			{collapsed === undefined ? (
				<h2 className={heading}>{title}</h2>
			) : (
				<h2 className={heading}>
					<button
						type="button"
						aria-expanded={!closed}
						onClick={() => setClosed(!closed)}
						className="flex items-center gap-1"
					>
						<Icon icon={closed ? ChevronRight : ChevronDown} />
						{title}
					</button>
				</h2>
			)}
			{closed ? null : children}
		</section>
	);
}

function Keycaps({ binding }: { binding: HotkeyBinding | undefined }) {
	const parts = binding ? bindingParts(binding) : [];
	return (
		<span className="flex items-center gap-1">
			{parts.map((part) => (
				<kbd
					key={part}
					className="inline-flex h-6 min-w-6 items-center justify-center rounded-md border border-zinc-700 bg-zinc-800 px-1.5 text-xs font-medium text-zinc-200 shadow-[0_1px_0_0_#3f3f46]"
					style={{ fontFamily: "inherit" }}
				>
					{part}
				</kbd>
			))}
		</span>
	);
}

/** One row per action: record a new combination by clicking it. */
function ShortcutsSection({ state, bridge }: { state: State; bridge: Bridge }) {
	const t = useScopedT("launch");
	const [capturing, setCapturing] = useState<HotkeyAction | null>(null);
	const [note, setNote] = useState<{ action: HotkeyAction; text: string } | null>(null);
	const nameOf = (action: HotkeyAction) => t(`scene.action.${action}`);

	// The registered shortcuts would fire on the very keys being recorded.
	useEffect(() => {
		if (!capturing) return;
		void bridge.suspendHotkeys(true);
		return () => void bridge.suspendHotkeys(false);
	}, [capturing, bridge]);

	useEffect(() => {
		if (!capturing) return;
		const save = (patch: Pick<HotkeyBinding, "key" | "modifiers">) => {
			const next = HOTKEY_ACTIONS.map((action): HotkeyBinding => {
				if (action === capturing) return { action, ...patch };
				return state.hotkeys.find((b) => b.action === action) ?? { action, key: "", modifiers: [] };
			});
			void bridge.setHotkeys(next);
			setCapturing(null);
			setNote(null);
		};
		const onKeyDown = (event: KeyboardEvent) => {
			event.preventDefault();
			event.stopPropagation();
			if (event.repeat) return;
			const result = captureKey(event);
			switch (result.kind) {
				case "pending":
					return;
				case "cancel":
					setCapturing(null);
					setNote(null);
					return;
				case "clear":
					save({ key: "", modifiers: [] });
					return;
				case "unsupported":
					setNote({ action: capturing, text: t("scene.shortcutUnsupported") });
					return;
				case "needsModifier":
					setNote({ action: capturing, text: t("scene.shortcutNeedsModifier") });
					return;
				case "binding": {
					const other = bindingConflict(state.hotkeys, capturing, result);
					if (other) {
						setNote({
							action: capturing,
							text: t("scene.shortcutTaken", { name: nameOf(other) }),
						});
						return;
					}
					save({ key: result.key, modifiers: result.modifiers });
				}
			}
		};
		window.addEventListener("keydown", onKeyDown, true);
		return () => window.removeEventListener("keydown", onKeyDown, true);
		// biome-ignore lint/correctness/useExhaustiveDependencies: nameOf and t only read the language
	}, [capturing, state.hotkeys, bridge]);

	return (
		<Section title={t("scene.shortcuts")}>
			<ul className="flex flex-col">
				{HOTKEY_ACTIONS.map((action) => {
					const binding = state.hotkeys.find((b) => b.action === action);
					const active = capturing === action;
					const busy = state.failedHotkeys.includes(action) && binding?.key;
					const text = note?.action === action ? note.text : busy ? t("scene.shortcutBusy") : "";
					return (
						<li key={action}>
							<button
								type="button"
								onClick={() => {
									setNote(null);
									setCapturing(active ? null : action);
								}}
								onBlur={() => active && setCapturing(null)}
								className={`flex h-10 w-full items-center gap-3 rounded-md px-2 text-left text-xs hover:bg-zinc-900 ${
									active ? "bg-zinc-900 ring-1 ring-zinc-600" : ""
								}`}
							>
								<span className="text-zinc-400">
									<Icon icon={ACTION_ICONS[action]} />
								</span>
								<span className="flex-1 text-zinc-200">{nameOf(action)}</span>
								{active ? (
									<span className="text-zinc-400">{t("scene.shortcutPress")}</span>
								) : binding?.key ? (
									<Keycaps binding={binding} />
								) : (
									<span className="text-zinc-500">{t("scene.shortcutNone")}</span>
								)}
							</button>
							{text ? <p className="px-2 pb-1 text-xs text-zinc-400">{text}</p> : null}
						</li>
					);
				})}
			</ul>
			<p className="text-xs text-zinc-500">{t("scene.shortcutHint")}</p>
		</Section>
	);
}

/** The helper's other error codes, in the app's words; its own text is never shown. */
function helperErrorText(t: T, code: string): string {
	return code === "file_open" ? t("scene.helperErrorFile") : t("scene.helperErrorOther");
}

/** The helper's error codes in the app's words; its own text is never shown. */
function cameraErrorText(t: T, code: string): string {
	switch (code) {
		case "camera_preview_display":
			return t("scene.cameraErrorDisplay");
		case "camera_preview_camera":
			return t("scene.cameraErrorCamera");
		default:
			return t("scene.cameraErrorOther");
	}
}

function CameraSection({ state, bridge }: { state: State; bridge: Bridge }) {
	const t = useScopedT("launch");
	const preview = state.cameraPreview;
	const second = state.secondaryDisplayId;
	// Never the main display: that is the one being recorded.
	const others = state.displays.filter((display) => display.id !== state.primaryDisplayId);
	const shownDisplay =
		preview.displayId !== null && others.some((display) => display.id === preview.displayId)
			? preview.displayId
			: second;
	return (
		<Section title={t("scene.cameraPreview")}>
			<Row label={t("scene.cameraPreviewSwitch")}>
				<span className="flex-1" />
				<Switch
					label={t("scene.cameraPreviewSwitch")}
					checked={preview.enabled && second !== null}
					disabled={second === null}
					onChange={(enabled) =>
						void bridge.setCameraPreview({
							enabled,
							...(enabled && shownDisplay !== null ? { displayId: shownDisplay } : {}),
						})
					}
				/>
			</Row>
			{second === null ? (
				<p className="text-xs text-zinc-400">{t("scene.connectSecondDisplay")}</p>
			) : others.length > 1 ? (
				<Select
					label={t("scene.display")}
					value={String(shownDisplay)}
					onChange={(value) => void bridge.setCameraPreview({ displayId: Number(value) })}
				>
					{others.map((display) => (
						<option key={display.id} value={display.id}>
							{display.label}
						</option>
					))}
				</Select>
			) : null}
			{preview.enabled && second !== null && !state.cameraOn ? (
				<p className="text-xs text-zinc-400">{t("scene.cameraNeeded")}</p>
			) : null}
			{state.cameraPreviewError ? (
				<p className="text-xs text-zinc-300">{cameraErrorText(t, state.cameraPreviewError)}</p>
			) : null}
		</Section>
	);
}

/** Where the prompter sits, how it looks and how it scrolls. */
function PrompterFields({ state, bridge }: { state: State; bridge: Bridge }) {
	const t = useScopedT("launch");
	const s = state.settings;
	const set = (patch: Partial<Settings>) => bridge.set(patch);
	const fullscreen = s.position === "fullscreen";
	const overScreen = !fullscreen;
	const multiple = state.displays.length > 1;
	// A display not picked yet: the second one for full screen, the main one for the top.
	const defaultDisplay = (position: Position) =>
		position === "fullscreen"
			? (state.secondaryDisplayId ?? state.primaryDisplayId)
			: state.primaryDisplayId;
	const changePosition = (position: "fullscreen" | "screen") =>
		set(
			positionPatch(s, position, {
				primary: state.primaryDisplayId,
				secondary: multiple ? state.secondaryDisplayId : null,
			}),
		);
	const mics = state.micDevices;
	// A display never picked: save the default now, so the picker shows what the prompter uses.
	// biome-ignore lint/correctness/useExhaustiveDependencies: runs when the display is unset
	useEffect(() => {
		if (s.displayId === null && multiple) void set({ displayId: defaultDisplay(s.position) });
	}, [s.displayId, s.position, multiple]);
	useEffect(() => {
		void bridge.listMics();
	}, [bridge]);

	return (
		<>
			<Section title={t("scene.position")}>
				<Segmented
					options={positionsOf(t)}
					value={fullscreen ? "fullscreen" : "screen"}
					onChange={changePosition}
				/>
				{multiple ? (
					<Select
						label={t("scene.display")}
						value={String(s.displayId ?? defaultDisplay(s.position))}
						onChange={(value) => set({ displayId: Number(value), displayPicked: true })}
					>
						{state.displays.map((display) => (
							<option key={display.id} value={display.id}>
								{display.label}
							</option>
						))}
					</Select>
				) : null}
				{fullscreen ? (
					state.cameraBehindText ? (
						<Slider
							label={t("scene.cameraBehind")}
							value={Math.round(s.cameraOpacity * 100)}
							min={0}
							max={100}
							step={5}
							shown={`${Math.round(s.cameraOpacity * 100)}%`}
							onChange={(percent) => set({ cameraOpacity: percent / 100 })}
						/>
					) : null
				) : (
					<>
						<Slider
							label={t("scene.height")}
							value={s.visibleLines}
							min={1}
							max={12}
							onChange={(visibleLines) => set({ visibleLines })}
						/>
						<Slider
							label={t("scene.width")}
							value={s.width}
							min={320}
							max={2400}
							step={20}
							onChange={(width) => set({ width })}
						/>
						<Slider
							label={t("scene.distanceFromTop")}
							value={s.paddingV}
							min={0}
							max={400}
							step={4}
							onChange={(paddingV) => set({ paddingV })}
						/>
					</>
				)}
			</Section>

			<Section title={t("scene.look")} collapsed>
				<Slider
					label={t("scene.letters")}
					value={s.fontSize}
					min={18}
					max={200}
					onChange={(fontSize) => set({ fontSize })}
				/>
				<Slider
					label={t("scene.lineSpacing")}
					value={s.lineSpacing}
					min={0.8}
					max={2.5}
					step={0.05}
					shown={s.lineSpacing.toFixed(2)}
					onChange={(lineSpacing) => set({ lineSpacing })}
				/>
				<Slider
					label={t("scene.paddingSides")}
					value={s.paddingH}
					min={0}
					max={600}
					step={4}
					onChange={(paddingH) => set({ paddingH })}
				/>
				<Slider
					label={t("scene.background")}
					value={Math.round((overScreen ? s.screenOpacity : s.opacity) * 100)}
					min={overScreen ? 10 : 20}
					max={100}
					shown={`${Math.round((overScreen ? s.screenOpacity : s.opacity) * 100)}%`}
					onChange={(percent) =>
						set(overScreen ? { screenOpacity: percent / 100 } : { opacity: percent / 100 })
					}
				/>
				<Slider
					label={t("scene.activeLine")}
					value={Math.round(s.activeLine * 100)}
					min={0}
					max={90}
					shown={`${Math.round(s.activeLine * 100)}%`}
					onChange={(percent) => set({ activeLine: percent / 100 })}
				/>
				<Row label={t("scene.guideLine")}>
					<span className="flex-1" />
					<Switch
						label={t("scene.guideLine")}
						checked={s.showGuide}
						onChange={(showGuide) => set({ showGuide })}
					/>
				</Row>
				<Row label={t("scene.mirror")}>
					<span className="flex-1" />
					<Switch
						label={t("scene.mirror")}
						checked={s.mirror}
						onChange={(mirror) => set({ mirror })}
					/>
				</Row>
			</Section>

			<Section title={t("scene.scrolling")}>
				<Segmented options={modesOf(t)} value={s.mode} onChange={(mode) => set({ mode })} />
				{s.mode === "voice" ? (
					<Select
						label={t("scene.microphone")}
						value={state.micDeviceId ?? ""}
						onChange={(value) => void bridge.setMic(value || null)}
					>
						<option value="">{state.micName || t("scene.micDefault")}</option>
						{mics.map((mic) => (
							<option key={mic.id} value={mic.id}>
								{mic.name}
							</option>
						))}
					</Select>
				) : null}
				{s.mode === "manual" ? (
					<Slider
						label={t("scene.speed")}
						value={s.speed}
						min={1}
						max={30}
						onChange={(speed) => set({ speed })}
					/>
				) : null}
				{s.mode === "bullets" ? (
					<p className="text-xs text-zinc-400">{t("scene.bulletsHint")}</p>
				) : null}
			</Section>
		</>
	);
}

function useTeleprompter(): { bridge: Bridge | undefined; state: State | null } {
	const bridge = (window.electronAPI as unknown as { teleprompter?: Bridge }).teleprompter;
	const [state, setState] = useState<State | null>(null);
	useEffect(() => {
		if (!bridge) return;
		void bridge.state().then(setState);
		return bridge.onState(setState);
	}, [bridge]);
	return { bridge, state };
}

/** The prompter's settings, on the editor's Record tab. */
export function TeleprompterFields() {
	const { bridge, state } = useTeleprompter();
	if (!bridge || !state) return null;
	return (
		<LightTone.Provider value>
			<PrompterFields state={state} bridge={bridge} />
		</LightTone.Provider>
	);
}

/** The teleprompter's settings. The script comes from the open project. Rec hides this window. */
export function TeleprompterWindow() {
	const t = useScopedT("launch");
	const { bridge, state } = useTeleprompter();
	if (!bridge || !state) return <div className="h-screen w-screen bg-zinc-950" />;

	return (
		<main
			// The app's font draws the Greek ω as a capital Ω.
			style={{ fontFamily: "-apple-system, system-ui, sans-serif" }}
			className="flex h-screen w-screen flex-col overflow-y-auto bg-zinc-950 px-4 py-2 text-zinc-100"
		>
			{state.hasScript ? null : (
				<div className="flex items-center gap-2 py-4 text-xs text-zinc-300">
					<span>{t("scene.noScript")}</span>
					<button
						type="button"
						onClick={() => void window.electronAPI.openScriptEditor()}
						className="underline underline-offset-2 hover:text-zinc-50"
					>
						{t("scene.editScript")}
					</button>
				</div>
			)}
			<PrompterFields state={state} bridge={bridge} />
			<ShortcutsSection state={state} bridge={bridge} />
			<CameraSection state={state} bridge={bridge} />
			<p className="border-t border-zinc-800 py-4 text-xs text-zinc-500">
				{state.helperError
					? helperErrorText(t, state.helperError)
					: state.message || state.status || t("scene.recHides")}
			</p>
		</main>
	);
}
