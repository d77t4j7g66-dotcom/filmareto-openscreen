import { ChevronDown, ChevronRight, Plus } from "lucide-react";
import { useMemo, useState } from "react";
import { toast } from "sonner";
import { toFileUrl } from "@/components/video-editor/projectPersistence";
import { useScopedT } from "@/contexts/I18nContext";
import { createId } from "@/lib/ai-edition/document/ids";
import { scenesOf } from "@/lib/ai-edition/document/script";
import { placeSceneTake } from "@/lib/ai-edition/document/timeline";
import type { AxcutClip } from "@/lib/ai-edition/schema";
import { useProjectStore } from "@/lib/ai-edition/store/projectStore";
import { type ClipTake, clipTakes } from "@/lib/ai-edition/timeline/takeSegments";
import styles from "./EditorShellV4.module.css";

function formatLength(sec: number) {
	const whole = Math.max(0, Math.round(sec));
	return `${String(Math.floor(whole / 60)).padStart(2, "0")}:${String(whole % 60).padStart(2, "0")}`;
}

/** A take as a frame of itself, with its number and length. */
function TakeThumb({
	clip,
	take,
	number,
	shown,
	onShow,
}: {
	clip: AxcutClip;
	take: ClipTake;
	number: number;
	shown: boolean;
	onShow: () => void;
}) {
	const path = useProjectStore(
		(s) => s.document?.assets.find((a) => a.id === (take.assetId ?? clip.assetId))?.originalPath,
	);
	return (
		<button
			type="button"
			className={styles.sceneTake}
			aria-pressed={shown}
			aria-label={`Take ${number}`}
			onClick={onShow}
		>
			{path ? (
				<video
					src={`${toFileUrl(path)}#t=${(take.sourceStartSec + 0.4).toFixed(2)}`}
					preload="metadata"
					muted
					playsInline
				/>
			) : null}
			<span>
				Take {number} ({formatLength(take.sourceEndSec - take.sourceStartSec)})
			</span>
		</button>
	);
}

/** The scenes to record: each with its own Record, its takes, and the takes it did not keep. */
export function SceneCards({
	onRecord,
	onShowTake,
}: {
	onRecord: (sceneIndex: number) => void;
	onShowTake: (clipId: string, take: ClipTake) => void;
}) {
	const t = useScopedT("editor");
	const document = useProjectStore((s) => s.document);
	const scenes = scenesOf(document);
	const assetIds = useMemo(() => document?.assets.map((a) => a.id) ?? [], [document?.assets]);
	const [archiveOpen, setArchiveOpen] = useState<Record<string, boolean>>({});

	const importFile = async (sceneId: string) => {
		const result = await window.electronAPI?.openVideoFilePicker?.();
		if (!result || result.canceled || !result.success || !result.path) return;
		const store = useProjectStore.getState();
		const label = result.name || result.path.split(/[\\/]/).pop() || "Recording";
		const asset = await store.addAsset(result.path, label);
		const current = useProjectStore.getState().document;
		if (!asset || !current) {
			toast.error(t("studio.fileNotAdded"));
			return;
		}
		await useProjectStore.getState().saveDocument(
			placeSceneTake(
				current,
				{
					clipId: createId("clip"),
					sceneId,
					assetId: asset.id,
					startSec: 0,
					endSec: asset.durationSec ?? 60,
				},
				scenes.map((scene) => scene.id),
			),
			{ history: true },
		);
	};

	return (
		<div className={styles.sceneCards}>
			<div className={styles.sceneCardsHead}>
				<b>{t("studio.scenes")}</b>
				<button type="button" className={styles.sceneRecordAll} onClick={() => onRecord(0)}>
					<i aria-hidden />
					{t("studio.recordAll")}
				</button>
			</div>
			{scenes.map((scene, index) => {
				const clip = document?.timeline.clips.find((c) => c.sceneId === scene.id);
				const { takes, current } = clip
					? clipTakes(clip, assetIds)
					: { takes: [] as ClipTake[], current: -1 };
				const others = takes.filter((_, number) => number !== current);
				const open = archiveOpen[scene.id] === true;
				return (
					<article key={scene.id} className={styles.sceneCard} data-done={!!clip || undefined}>
						<header>
							<i aria-hidden />
							{scene.name}
						</header>
						<p>{scene.text || t("studio.noText")}</p>
						<div className={styles.sceneTakes}>
							{clip ? (
								<>
									<button
										type="button"
										className={styles.sceneRecordAgain}
										onClick={() => onRecord(index)}
									>
										<Plus size={14} />
										Record
									</button>
									<TakeThumb
										clip={clip}
										take={takes[current]}
										number={current + 1}
										shown
										onShow={() => {}}
									/>
									{others.length > 0 ? (
										<button
											type="button"
											className={styles.sceneArchive}
											aria-expanded={open}
											onClick={() => setArchiveOpen((was) => ({ ...was, [scene.id]: !open }))}
										>
											{open ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
											{t("studio.archive", { count: others.length })}
										</button>
									) : null}
									{open
										? others.map((take) => (
												<TakeThumb
													key={`${take.assetId ?? ""}:${take.sourceStartSec}`}
													clip={clip}
													take={take}
													number={takes.indexOf(take) + 1}
													shown={false}
													onShow={() => onShowTake(clip.id, take)}
												/>
											))
										: null}
								</>
							) : (
								<>
									<button
										type="button"
										className={styles.sceneRecord}
										onClick={() => onRecord(index)}
									>
										<i aria-hidden />
										Record
									</button>
									<button
										type="button"
										className={styles.sceneFromFile}
										onClick={() => void importFile(scene.id)}
									>
										{t("studio.fromFile")}
									</button>
								</>
							)}
						</div>
					</article>
				);
			})}
		</div>
	);
}
