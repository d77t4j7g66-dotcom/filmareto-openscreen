import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useScopedT } from "@/contexts/I18nContext";
import { useProjectStore } from "@/lib/ai-edition/store/projectStore";
import {
	type KeycapLabels,
	type KeycapTheme,
	keycapTokens,
	renderKeycapImage,
} from "@/lib/ai-edition/timeline/keycapImage";
import {
	KEYCAP_HOLD_MS,
	KEYCAP_STAGGER_MS,
	type KeycapPart,
	type KeycapPlan,
	keycapLabel,
	type PlainKeys,
	planKeycaps,
	withPlus,
} from "@/lib/ai-edition/timeline/keycaps";
import { nativeBridgeClient } from "@/native/client";
import type { CursorRecordingKey } from "@/native/contracts";

interface KeycapsDialogProps {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	addKeycaps: (
		plans: KeycapPlan[],
		options?: { heightPct?: number; y?: number },
	) => Promise<number>;
}

/** The modifier words a person types, as the helper names them. */
const MODIFIER_WORDS: Record<string, CursorRecordingKey["modifiers"][number]> = {
	cmd: "cmd",
	command: "cmd",
	"⌘": "cmd",
	shift: "shift",
	"⇧": "shift",
	ctrl: "ctrl",
	control: "ctrl",
	"⌃": "ctrl",
	alt: "alt",
	opt: "alt",
	option: "alt",
	"⌥": "alt",
};
const KEY_WORDS: Record<string, string> = {
	esc: "Esc",
	escape: "Esc",
	enter: "Return",
	return: "Return",
	space: "Space",
	tab: "Tab",
	delete: "Delete",
	backspace: "Delete",
	up: "Up",
	down: "Down",
	left: "Left",
	right: "Right",
};

/** "Cmd+Shift+Z" → the key and its modifiers, or null when there is no key. */
export function parseCombination(
	text: string,
): Pick<CursorRecordingKey, "key" | "modifiers"> | null {
	const parts = text
		.split("+")
		.map((part) => part.trim())
		.filter(Boolean);
	if (parts.length === 0) return null;
	const modifiers: CursorRecordingKey["modifiers"] = [];
	let key: string | null = null;
	for (const [index, part] of parts.entries()) {
		const lower = part.toLowerCase();
		const modifier = MODIFIER_WORDS[lower];
		if (modifier && index < parts.length - 1) {
			if (!modifiers.includes(modifier)) modifiers.push(modifier);
		} else {
			key = KEY_WORDS[lower] ?? (part.length === 1 ? part.toUpperCase() : part);
		}
	}
	return key ? { key, modifiers } : null;
}

function buildParts(tokens: string[], theme: KeycapTheme): KeycapPart[] | undefined {
	const parts: KeycapPart[] = [];
	for (const [index, token] of tokens.entries()) {
		const image = renderKeycapImage([token], theme);
		if (!image) return undefined;
		parts.push({ token, image, delayMs: index * KEYCAP_STAGGER_MS });
	}
	return parts;
}

function Segmented<T extends string>(props: {
	value: T;
	options: Array<{ value: T; label: string }>;
	onChange: (value: T) => void;
}) {
	return (
		<div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
			{props.options.map((option) => (
				<button
					key={option.value}
					type="button"
					onClick={() => props.onChange(option.value)}
					style={{
						padding: "7px 12px",
						borderRadius: 10,
						border: "1px solid var(--border)",
						background: option.value === props.value ? "var(--accent, #34b27b)" : "transparent",
						color: option.value === props.value ? "#fff" : "inherit",
						fontWeight: option.value === props.value ? 600 : 400,
					}}
				>
					{option.label}
				</button>
			))}
		</div>
	);
}

const fieldLabel = { fontSize: 12, color: "var(--muted)", margin: "10px 0 4px" } as const;

/**
 * Keyboard shortcuts as keycaps: add the keys recorded with the take, in the look chosen here, or
 * one written by hand at the playhead. They become ordinary image annotations on the timeline.
 */
export function KeycapsDialog({ open, onOpenChange, addKeycaps }: KeycapsDialogProps) {
	const t = useScopedT("timeline");
	const [theme, setTheme] = useState<KeycapTheme>("dark");
	const [labels, setLabels] = useState<KeycapLabels>("words");
	const [plainKeys, setPlainKeys] = useState<PlainKeys>("isolated");
	const [onlyKeys, setOnlyKeys] = useState("");
	const [heightPct, setHeightPct] = useState(6.5);
	const [manual, setManual] = useState("");
	const [keysByAssetId, setKeysByAssetId] = useState<Map<string, CursorRecordingKey[]>>(new Map());
	const [busy, setBusy] = useState(false);

	// The keys recorded with the clips on the timeline, read when the dialog opens.
	useEffect(() => {
		if (!open) return;
		let cancelled = false;
		const document = useProjectStore.getState().document;
		if (!document) return;
		const assets = document.assets.filter(
			(asset) =>
				asset.kind === "video" &&
				asset.originalPath &&
				document.timeline.clips.some((clip) => clip.assetId === asset.id),
		);
		void (async () => {
			const found = new Map<string, CursorRecordingKey[]>();
			await Promise.all(
				assets.map(async (asset) => {
					const data = await nativeBridgeClient.cursor.getRecordingData(asset.originalPath);
					if (data?.keys && data.keys.length > 0) found.set(asset.id, data.keys);
				}),
			);
			if (!cancelled) setKeysByAssetId(found);
		})();
		return () => {
			cancelled = true;
		};
	}, [open]);

	const recorded = useMemo(
		() => [...keysByAssetId.values()].reduce((sum, keys) => sum + keys.length, 0),
		[keysByAssetId],
	);
	const planned = useMemo(() => {
		const document = useProjectStore.getState().document;
		if (!document || recorded === 0) return [];
		return planKeycaps({
			keysByAssetId,
			clips: document.timeline.clips,
			plainKeys,
			onlyKeys: onlyKeys.split(/[\s,]+/),
			labels,
		});
		// `open` re-reads the clips each time the dialog is shown.
		// biome-ignore lint/correctness/useExhaustiveDependencies: see above
	}, [keysByAssetId, recorded, plainKeys, onlyKeys, labels, open]);

	const addFromRecording = async () => {
		setBusy(true);
		try {
			const plans = planned.map((plan) => ({ ...plan, parts: buildParts(plan.tokens, theme) }));
			const added = await addKeycaps(plans, { heightPct });
			if (added > 0) toast.success(t("keycapsDialog.added", { count: added }));
			onOpenChange(false);
		} finally {
			setBusy(false);
		}
	};

	const addByHand = async () => {
		const combination = parseCombination(manual);
		if (!combination) {
			toast.error(t("keycapsDialog.manualInvalid"));
			return;
		}
		const nowMs = Math.round((useProjectStore.getState().currentTimeSec ?? 0) * 1000);
		const tokens = withPlus(keycapTokens(combination, labels));
		const plan: KeycapPlan = {
			startMs: nowMs,
			endMs: nowMs + KEYCAP_HOLD_MS,
			label: keycapLabel({ ...combination, timeMs: nowMs } as CursorRecordingKey),
			tokens,
			parts: buildParts(tokens, theme),
		};
		setBusy(true);
		try {
			const added = await addKeycaps([plan], { heightPct });
			if (added > 0) toast.success(t("keycapsDialog.added", { count: added }));
		} finally {
			setBusy(false);
		}
	};

	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent className="max-w-lg" data-testid="keycaps-dialog">
				<DialogHeader>
					<DialogTitle>{t("keycapsDialog.title")}</DialogTitle>
				</DialogHeader>
				<p style={{ margin: 0, fontSize: 13, color: "var(--muted)" }}>{t("keycapsDialog.intro")}</p>

				<div style={fieldLabel}>{t("keycapsDialog.look")}</div>
				<Segmented<KeycapTheme>
					value={theme}
					options={[
						{ value: "dark", label: t("keycapsDialog.dark") },
						{ value: "light", label: t("keycapsDialog.light") },
					]}
					onChange={setTheme}
				/>
				<div style={fieldLabel}>{t("keycapsDialog.labels")}</div>
				<Segmented<KeycapLabels>
					value={labels}
					options={[
						{ value: "words", label: t("keycapsDialog.words") },
						{ value: "symbols", label: t("keycapsDialog.symbols") },
					]}
					onChange={setLabels}
				/>
				<div style={fieldLabel}>
					{t("keycapsDialog.size")} · {heightPct.toFixed(1)}%
				</div>
				<input
					type="range"
					min={3}
					max={12}
					step={0.5}
					value={heightPct}
					onChange={(event) => setHeightPct(Number(event.target.value))}
				/>

				<div style={{ ...fieldLabel, marginTop: 16, fontWeight: 600 }}>
					{recorded > 0
						? t("keycapsDialog.recorded", { count: recorded })
						: t("keycapsDialog.none")}
				</div>
				{recorded > 0 ? (
					<>
						<div style={fieldLabel}>{t("keycapsDialog.plain")}</div>
						<Segmented<PlainKeys>
							value={plainKeys}
							options={[
								{ value: "off", label: t("keycapsDialog.plainOff") },
								{ value: "isolated", label: t("keycapsDialog.plainIsolated") },
								{ value: "all", label: t("keycapsDialog.plainAll") },
							]}
							onChange={setPlainKeys}
						/>
						<div style={fieldLabel}>{t("keycapsDialog.onlyKeys")}</div>
						<input
							value={onlyKeys}
							onChange={(event) => setOnlyKeys(event.target.value)}
							placeholder="E Q W"
							style={{ padding: "7px 10px", borderRadius: 10, border: "1px solid var(--border)" }}
						/>
						<div style={{ fontSize: 12, color: "var(--muted)" }}>
							{t("keycapsDialog.onlyKeysHint")}
						</div>
						<button
							type="button"
							disabled={busy || planned.length === 0}
							onClick={() => void addFromRecording()}
							style={{
								marginTop: 12,
								padding: "9px 14px",
								borderRadius: 10,
								background: "var(--accent, #34b27b)",
								color: "#fff",
								fontWeight: 600,
							}}
						>
							{t("keycapsDialog.fromRecording")} ·{" "}
							{t("keycapsDialog.willAdd", { count: planned.length })}
						</button>
					</>
				) : null}

				<div style={{ ...fieldLabel, marginTop: 16, fontWeight: 600 }}>
					{t("keycapsDialog.manual")}
				</div>
				<div style={{ fontSize: 12, color: "var(--muted)" }}>{t("keycapsDialog.manualHint")}</div>
				<div style={{ display: "flex", gap: 8 }}>
					<input
						value={manual}
						onChange={(event) => setManual(event.target.value)}
						placeholder={t("keycapsDialog.manualPlaceholder")}
						onKeyDown={(event) => {
							if (event.key === "Enter") void addByHand();
						}}
						style={{
							flex: 1,
							padding: "7px 10px",
							borderRadius: 10,
							border: "1px solid var(--border)",
						}}
					/>
					<button
						type="button"
						disabled={busy}
						onClick={() => void addByHand()}
						style={{ padding: "7px 14px", borderRadius: 10, border: "1px solid var(--border)" }}
					>
						{t("keycapsDialog.addAtPlayhead")}
					</button>
				</div>
			</DialogContent>
		</Dialog>
	);
}
