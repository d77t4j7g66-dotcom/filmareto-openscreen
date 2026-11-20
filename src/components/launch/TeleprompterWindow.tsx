import { useScopedT } from "@/contexts/I18nContext";
import { createContext, type ReactNode, useContext, useEffect, useRef, useState } from "react";

const SCRIPT_KEY = "filmareto.teleprompter.script";

type Position = "notch" | "free" | "screen" | "fullscreen";
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
	activeLine: number;
	paddingH: number;
	paddingV: number;
	lineSpacing: number;
	showGuide: boolean;
};
type State = {
	open: boolean;
	playing: boolean;
	stageIndex: number;
	stageCount: number;
	status: string;
	message: string;
	micName: string;
	settings: Settings;
	displays: { id: number; label: string }[];
};
type Bridge = {
	setText: (text: string) => Promise<void>;
	perform: (action: string) => Promise<void>;
	set: (patch: Partial<Settings>) => Promise<void>;
	state: () => Promise<State>;
	onState: (listener: (state: State) => void) => () => void;
};

type T = ReturnType<typeof useScopedT>;
const modesOf = (t: T): { id: Mode; label: string }[] => [
	{ id: "voice", label: t("scene.modeVoice") },
	{ id: "manual", label: t("scene.modeManual") },
	{ id: "bullets", label: t("scene.modeBullets") },
];
const positionsOf = (t: T): { id: Position; label: string }[] => [
	{ id: "notch", label: t("scene.posTop") },
	{ id: "free", label: t("scene.posWindow") },
	{ id: "screen", label: t("scene.posScreen") },
	{ id: "fullscreen", label: t("scene.posFull") },
];

/** The same controls on the dark settings window and on the editor's light Record tab. */
const LightTone = createContext(false);

function Button({
	label,
	onClick,
	active,
	primary,
}: {
	label: string;
	onClick: () => void;
	active?: boolean;
	primary?: boolean;
}) {
	const light = useContext(LightTone);
	const tone = primary
		? "bg-red-600 text-white hover:bg-red-500"
		: light
			? active
				? "bg-[#ee6c0e] text-[#231003]"
				: "bg-black/5 text-inherit hover:bg-black/10"
			: active
				? "bg-zinc-100 text-zinc-900"
				: "bg-zinc-800 text-zinc-100 hover:bg-zinc-700";
	return (
		<button
			type="button"
			aria-pressed={active}
			onClick={onClick}
			className={`rounded-md px-2.5 py-1.5 text-xs font-medium ${tone}`}
		>
			{label}
		</button>
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
		<label className={`flex items-center gap-3 text-xs ${light ? "" : "text-zinc-300"}`}>
			<span className={`${light ? "w-28" : "w-36"} shrink-0`}>{label}</span>
			<input
				type="range"
				className="h-1 min-w-0 flex-1 cursor-pointer rounded-full bg-zinc-700"
				value={value}
				min={min}
				max={max}
				step={step}
				onChange={(event) => onChange(Number(event.target.value))}
			/>
			<span className="w-10 shrink-0 text-right tabular-nums text-zinc-400">{shown ?? value}</span>
		</label>
	);
}

function Section({ title, children }: { title: string; children: ReactNode }) {
	const light = useContext(LightTone);
	return (
		<section
			className={`flex flex-col gap-2.5 rounded-lg ${light ? "py-1.5" : "bg-zinc-900 p-3"}`}
		>
			<h2 className="text-[11px] font-semibold uppercase tracking-wide text-zinc-500">{title}</h2>
			{children}
		</section>
	);
}

/** How the prompter scrolls, where it sits and how it looks. */
function PrompterFields({ state, bridge }: { state: State; bridge: Bridge }) {
	const t = useScopedT("launch");
	const s = state.settings;
	const set = (patch: Partial<Settings>) => bridge.set(patch);
	const act = (action: string) => () => bridge.perform(action);
	const voice = s.mode === "voice";
	const fullscreen = s.position === "fullscreen";
	const top = s.position === "notch";
	const overScreen = s.position === "screen";
	return (
		<>
			<Section title={t("scene.scrolling")}>
				<div className="flex flex-wrap gap-1.5">
					{modesOf(t).map((mode) => (
						<Button
							key={mode.id}
							label={mode.label}
							active={s.mode === mode.id}
							onClick={() => set({ mode: mode.id })}
						/>
					))}
				</div>
				{s.mode === "manual" ? (
					<Slider
						label={t("scene.speed")}
						value={s.speed}
						min={1}
						max={30}
						onChange={(speed) => set({ speed })}
					/>
				) : null}
				{voice ? (
					<p className="text-xs leading-relaxed text-zinc-400">
						{t("scene.listensTo", { mic: state.micName || t("scene.macInput") })}
					</p>
				) : null}
				{s.mode === "bullets" ? (
					<p className="text-xs leading-relaxed text-zinc-400">
						{t("scene.bulletsHint")}
					</p>
				) : null}
			</Section>

			<Section title={t("scene.position")}>
				<div className="flex flex-wrap gap-1.5">
					{positionsOf(t).map((position) => (
						<Button
							key={position.id}
							label={position.label}
							active={s.position === position.id}
							onClick={() => set({ position: position.id })}
						/>
					))}
				</div>
				{(top || fullscreen) && state.displays.length > 1 ? (
					<label className="flex items-center gap-3 text-xs text-zinc-300">
						<span className="w-36 shrink-0">{t("scene.display")}</span>
						<select
							className="min-w-0 flex-1 rounded-md bg-zinc-800 p-1.5 text-xs"
							value={s.displayId ?? ""}
							onChange={(event) =>
								set({ displayId: event.target.value ? Number(event.target.value) : null })
							}
						>
							<option value="">{t("scene.automatic")}</option>
							{state.displays.map((display) => (
								<option key={display.id} value={display.id}>
									{display.label}
								</option>
							))}
						</select>
					</label>
				) : null}
				{!top ? (
					<Slider
						label={t("scene.activeLine")}
						value={Math.round(s.activeLine * 100)}
						min={0}
						max={90}
						shown={`${Math.round(s.activeLine * 100)}%`}
						onChange={(percent) => set({ activeLine: percent / 100 })}
					/>
				) : null}
				{!top ? (
					<div className="flex gap-1.5">
						<Button
							label={t("scene.guideLine")}
							active={s.showGuide}
							onClick={() => set({ showGuide: !s.showGuide })}
						/>
					</div>
				) : null}
				{!fullscreen ? (
					<Slider
						label={t("scene.width")}
						value={s.width}
						min={320}
						max={2400}
						step={20}
						onChange={(width) => set({ width })}
					/>
				) : null}
				{top ? (
					<Slider
						label={t("scene.lines")}
						value={s.visibleLines}
						min={1}
						max={12}
						onChange={(visibleLines) => set({ visibleLines })}
					/>
				) : null}
			</Section>

			<Section title={t("scene.look")}>
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
					label={t("scene.paddingTop")}
					value={s.paddingV}
					min={0}
					max={400}
					step={4}
					onChange={(paddingV) => set({ paddingV })}
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
				<div className="flex gap-1.5">
					<Button label="Mirror" active={s.mirror} onClick={() => set({ mirror: !s.mirror })} />
					<Button label={t("scene.hide")} onClick={act("toggleVisible")} />
				</div>
			</Section>
		</>
	);
}

/** The prompter's settings, on the editor's Record tab. */
export function TeleprompterFields() {
	const bridge = (window.electronAPI as unknown as { teleprompter?: Bridge }).teleprompter;
	const [state, setState] = useState<State | null>(null);
	useEffect(() => {
		if (!bridge) return;
		void bridge.state().then(setState);
		return bridge.onState(setState);
	}, [bridge]);
	if (!bridge || !state) return null;
	return (
		<LightTone.Provider value>
			<PrompterFields state={state} bridge={bridge} />
		</LightTone.Provider>
	);
}

/** The teleprompter's settings and script. Rec hides this window and leaves only the prompter. */
export function TeleprompterWindow() {
	const t = useScopedT("launch");
	const bridge = (window.electronAPI as unknown as { teleprompter?: Bridge }).teleprompter;
	const [state, setState] = useState<State | null>(null);
	const [text, setText] = useState(() => {
		try {
			return localStorage.getItem(SCRIPT_KEY) ?? "";
		} catch {
			return "";
		}
	});
	const editor = useRef<HTMLTextAreaElement>(null);

	useEffect(() => {
		if (!bridge) return;
		void bridge.state().then(setState);
		return bridge.onState(setState);
	}, [bridge]);

	useEffect(() => {
		const timer = setTimeout(() => {
			try {
				localStorage.setItem(SCRIPT_KEY, text);
			} catch {
				// The script still reaches the prompter; it just will not survive a restart.
			}
			void bridge?.setText(text);
		}, 300);
		return () => clearTimeout(timer);
	}, [bridge, text]);

	const addSegment = () => {
		const area = editor.current;
		const at = area?.selectionStart ?? text.length;
		const next = `${text.slice(0, at).trimEnd()}\n/\n${text.slice(at).trimStart()}`;
		setText(next);
		area?.focus();
	};

	if (!bridge || !state) return <div className="h-screen w-screen bg-zinc-950" />;
	const act = (action: string) => () => bridge.perform(action);

	return (
		<main
			// The app's font draws the Greek ω as a capital Ω.
			style={{ fontFamily: "-apple-system, system-ui, sans-serif" }}
			className="flex h-screen w-screen flex-col gap-3 overflow-y-auto bg-zinc-950 p-3 text-zinc-100"
		>
			<div className="flex flex-wrap items-center gap-1.5">
				<Button label={state.playing ? t("scene.pause") : t("scene.start")} onClick={act("playPause")} primary />
				<Button label={t("scene.fromSegmentStart")} onClick={act("retakeStage")} />
				<Button label="← Segment" onClick={act("prevStage")} />
				<span className="text-xs tabular-nums text-zinc-400">
					{state.open ? `${state.stageIndex + 1}/${state.stageCount}` : "0/0"}
				</span>
				<Button label="Segment →" onClick={act("nextStage")} />
				<Button label={t("scene.prevLine")} onClick={act("prevLine")} />
				<Button label={t("scene.nextLine")} onClick={act("nextLine")} />
			</div>

			<Section title={t("scene.text")}>
				<textarea
					ref={editor}
					value={text}
					onChange={(event) => setText(event.target.value)}
					placeholder={t("scene.textPlaceholder")}
					className="h-44 w-full resize-y rounded-md bg-zinc-950 p-2.5 text-sm leading-relaxed text-zinc-100 outline-none placeholder:text-zinc-600 focus:ring-1 focus:ring-zinc-600"
				/>
				<div>
					<Button label={t("scene.newSegment")} onClick={addSegment} />
				</div>
			</Section>

			<PrompterFields state={state} bridge={bridge} />

			<p className="pb-1 text-xs text-zinc-500">
				{state.message ||
					state.status ||
					t("scene.recHides")}
			</p>
		</main>
	);
}
