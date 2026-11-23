import { useScopedT } from "@/contexts/I18nContext";
import type { ResolveExportProgress } from "../../../electron/resolve-export/build";
import { ModalShell } from "./Modals";
import styles from "./NewEditorShell.module.css";

export type { ResolveExportProgress };

export type ResolveExportDialogState =
	| { kind: "running"; progress: ResolveExportProgress }
	| { kind: "done"; folder: string; warnings: string[]; restartNeeded: boolean }
	| { kind: "error"; reason: string };

interface ResolveExportDialogProps {
	/** Null keeps the dialog closed. */
	state: ResolveExportDialogState | null;
	onReveal: () => void;
	onClose: () => void;
}

const bodyStyle = {
	margin: 0,
	color: "var(--fg)",
	lineHeight: 1.5,
	wordBreak: "break-word",
} as const;

function percentOf({ done, total }: ResolveExportProgress): number {
	if (!(total > 0)) return 0;
	return Math.max(0, Math.min(100, Math.round((done / total) * 100)));
}

/** Everything "Export for Resolve" has to say: progress, the finished folder with its warnings
 *  and next step, or an error. */
export function ResolveExportDialog({ state, onReveal, onClose }: ResolveExportDialogProps) {
	const t = useScopedT("editor");
	const tc = useScopedT("common");
	if (!state) return null;

	switch (state.kind) {
		case "running": {
			const pct = percentOf(state.progress);
			return (
				<ModalShell
					open
					onClose={onClose}
					title={t("resolveExport.runningTitle")}
					closeOnBackdrop={false}
					closeOnEscape={false}
				>
					<p style={bodyStyle}>{t("resolveExport.runningBody")}</p>
					<div
						role="progressbar"
						aria-label={t("resolveExport.runningTitle")}
						aria-valuemin={0}
						aria-valuemax={100}
						aria-valuenow={pct}
						style={{
							marginTop: 12,
							height: 6,
							borderRadius: 3,
							background: "var(--surface-2)",
							overflow: "hidden",
						}}
					>
						<div style={{ width: `${pct}%`, height: "100%", background: "var(--accent)" }} />
					</div>
					<p style={{ ...bodyStyle, marginTop: 8, color: "var(--muted)" }}>{pct}%</p>
				</ModalShell>
			);
		}
		case "done":
			return (
				<ModalShell
					open
					onClose={onClose}
					title={t("resolveExport.doneTitle")}
					footer={
						<>
							<button
								type="button"
								className={`${styles.btn} ${styles.btnSecondary}`}
								onClick={onClose}
							>
								{tc("actions.close")}
							</button>
							<button
								type="button"
								className={`${styles.btn} ${styles.btnPrimary}`}
								onClick={onReveal}
							>
								{t("resolveExport.reveal")}
							</button>
						</>
					}
				>
					<p style={bodyStyle}>{t("resolveExport.doneBody", { path: state.folder })}</p>
					{state.warnings.length > 0 ? (
						<ul style={{ margin: "10px 0 0", paddingLeft: 20 }}>
							{state.warnings.map((warning) => (
								<li key={warning} style={bodyStyle}>
									{warning}
								</li>
							))}
						</ul>
					) : null}
					{state.restartNeeded ? (
						<p style={{ ...bodyStyle, marginTop: 10 }}>{t("resolveExport.restartNeeded")}</p>
					) : null}
					<p style={{ ...bodyStyle, marginTop: 10 }}>{t("resolveExport.nextStep")}</p>
				</ModalShell>
			);
		case "error":
			return (
				<ModalShell open onClose={onClose} title={t("resolveExport.errorTitle")}>
					<p style={bodyStyle}>{state.reason}</p>
				</ModalShell>
			);
	}
}
