import { Plus, X } from "lucide-react";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { useScopedT } from "@/contexts/I18nContext";
import { createId } from "@/lib/ai-edition/document/ids";
import { type Scene, scenesOf, splitPastedScript } from "@/lib/ai-edition/document/script";
import { useProjectStore } from "@/lib/ai-edition/store/projectStore";
import styles from "./EditorShellV4.module.css";

const sceneMaker =
	(t: ReturnType<typeof useScopedT>) =>
	(number: number, text = ""): Scene => ({
		id: createId("scene"),
		name: t("studio.sceneNumber", { number }),
		text,
	});

function SceneText({
	value,
	focus,
	onChange,
	onPaste,
}: {
	value: string;
	focus: boolean;
	onChange: (value: string) => void;
	onPaste: (event: React.ClipboardEvent<HTMLTextAreaElement>) => void;
}) {
	const t = useScopedT("editor");
	const area = useRef<HTMLTextAreaElement>(null);
	// biome-ignore lint/correctness/useExhaustiveDependencies: the height follows the text.
	useLayoutEffect(() => {
		const el = area.current;
		if (!el) return;
		el.style.height = "auto";
		el.style.height = `${el.scrollHeight}px`;
	}, [value]);
	useEffect(() => {
		if (focus) area.current?.focus();
	}, [focus]);
	return (
		<textarea
			ref={area}
			className={styles.scriptText}
			rows={1}
			value={value}
			placeholder={t("studio.scriptPlaceholder")}
			spellCheck={false}
			onChange={(event) => onChange(event.target.value)}
			onPaste={onPaste}
		/>
	);
}

/** The script of the project: a line for every scene, each one a segment to record. */
export function ScriptStage({ onContinue }: { onContinue: () => void }) {
	const t = useScopedT("editor");
	const newScene = sceneMaker(t);
	const projectId = useProjectStore((s) => s.projectId);
	const [scenes, setScenes] = useState<Scene[]>(() => {
		const saved = scenesOf(useProjectStore.getState().document);
		return saved.length > 0 ? saved : [newScene(1)];
	});
	const [focusId, setFocusId] = useState<string | null>(null);
	const pending = useRef<Scene[] | null>(null);
	const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

	const flush = useCallback(async () => {
		if (timer.current) clearTimeout(timer.current);
		timer.current = null;
		const next = pending.current;
		pending.current = null;
		if (!next) return;
		const store = useProjectStore.getState();
		// A script can come first: writing one starts the project.
		const document = store.document ?? (await store.createProject(t("studio.newVideo")));
		await useProjectStore
			.getState()
			.saveDocument({ ...document, script: { scenes: next } }, { history: true });
	}, []);

	const change = useCallback(
		(next: Scene[]) => {
			setScenes(next);
			pending.current = next;
			if (timer.current) clearTimeout(timer.current);
			timer.current = setTimeout(() => void flush(), 500);
		},
		[flush],
	);

	// Another project: its own script. Whatever was being typed is saved first.
	const shownProject = useRef(projectId);
	useEffect(() => {
		if (shownProject.current === projectId) return;
		shownProject.current = projectId;
		const saved = scenesOf(useProjectStore.getState().document);
		setScenes(saved.length > 0 ? saved : [newScene(1)]);
	}, [projectId]);
	useEffect(
		() => () => {
			void flush();
		},
		[flush],
	);

	const update = (id: string, patch: Partial<Scene>) =>
		change(scenes.map((scene) => (scene.id === id ? { ...scene, ...patch } : scene)));

	const paste = (scene: Scene, event: React.ClipboardEvent<HTMLTextAreaElement>) => {
		const parts = splitPastedScript(event.clipboardData.getData("text"));
		if (parts.length < 2) return;
		event.preventDefault();
		const at = scenes.indexOf(scene);
		const added = parts.map((text, offset) =>
			offset === 0 ? { ...scene, text: `${scene.text}${text}` } : newScene(at + offset + 1, text),
		);
		change([...scenes.slice(0, at), ...added, ...scenes.slice(at + 1)]);
	};

	const add = () => {
		const scene = newScene(scenes.length + 1);
		change([...scenes, scene]);
		setFocusId(scene.id);
	};

	return (
		<div className={styles.scriptStage}>
			<div className={styles.scriptScroll}>
				<div className={styles.scriptDoc}>
					<h2 className={styles.scriptHeading}>{t("studio.scriptTitle")}</h2>
					{scenes.map((scene) => (
						<div key={scene.id} className={styles.scriptScene}>
							<input
								className={styles.scriptName}
								aria-label={t("studio.sceneName")}
								value={scene.name}
								onChange={(event) => update(scene.id, { name: event.target.value })}
							/>
							<span className={styles.scriptBar} aria-hidden />
							<SceneText
								value={scene.text}
								focus={focusId === scene.id}
								onChange={(text) => update(scene.id, { text })}
								onPaste={(event) => paste(scene, event)}
							/>
							{scenes.length > 1 ? (
								<button
									type="button"
									className={styles.scriptDelete}
									aria-label={t("studio.deleteNamed", { name: scene.name })}
									onClick={() => change(scenes.filter((other) => other.id !== scene.id))}
								>
									<X size={14} />
								</button>
							) : null}
						</div>
					))}
					<button type="button" className={styles.scriptAdd} onClick={add}>
						<Plus size={15} />
						{t("studio.newScene")}
					</button>
				</div>
			</div>
			<div className={styles.stageFooter}>
				<button
					type="button"
					className={styles.stageContinue}
					onClick={() => {
						void flush();
						onContinue();
					}}
				>
					{t("studio.continueToRecord")}
				</button>
			</div>
		</div>
	);
}
