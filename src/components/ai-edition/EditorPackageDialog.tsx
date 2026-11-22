import { useScopedT } from "@/contexts/I18nContext";
import { ModalShell } from "./Modals";
import styles from "./NewEditorShell.module.css";

export interface PackageProgress {
	copiedBytes: number;
	totalBytes: number;
}

export type PackageDialogState =
	| { kind: "packing"; progress: PackageProgress }
	| { kind: "packed"; zipPath: string }
	| { kind: "missing"; files: string[] }
	| { kind: "conflict"; title: string }
	| { kind: "opened"; title: string }
	| { kind: "error"; reason: string };

interface EditorPackageDialogProps {
	/** Null keeps the dialog closed. */
	state: PackageDialogState | null;
	onReveal: () => void;
	onChoose: (mode: "replace" | "copy") => void;
	onClose: () => void;
}

const bodyStyle = {
	margin: 0,
	color: "var(--fg)",
	lineHeight: 1.5,
	wordBreak: "break-word",
} as const;

function percentOf({ copiedBytes, totalBytes }: PackageProgress): number {
	if (!(totalBytes > 0)) return 0;
	return Math.max(0, Math.min(100, Math.round((copiedBytes / totalBytes) * 100)));
}

/** Everything "Package for Editing" and "Open Package" have to say: progress, the finished
 *  package, the files that could not be found, the name clash, the opened project, an error. */
export function EditorPackageDialog({
	state,
	onReveal,
	onChoose,
	onClose,
}: EditorPackageDialogProps) {
	const t = useScopedT("editor");
	const tc = useScopedT("common");
	if (!state) return null;
	const packing = state.kind === "packing";
	// A pack in flight is not abandoned by a stray click or Escape.
	const guard = { closeOnBackdrop: !packing, closeOnEscape: !packing };

	switch (state.kind) {
		case "packing": {
			const pct = percentOf(state.progress);
			return (
				<ModalShell open onClose={onClose} title={t("editorPackage.packingTitle")} {...guard}>
					<p style={bodyStyle}>{t("editorPackage.packingBody")}</p>
					<div
						role="progressbar"
						aria-label={t("editorPackage.packingTitle")}
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
		case "packed":
			return (
				<ModalShell
					open
					onClose={onClose}
					title={t("editorPackage.packedTitle")}
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
								{t("editorPackage.reveal")}
							</button>
						</>
					}
				>
					<p style={bodyStyle}>{t("editorPackage.packedBody", { path: state.zipPath })}</p>
				</ModalShell>
			);
		case "missing":
			return (
				<ModalShell open onClose={onClose} title={t("editorPackage.missingTitle")}>
					<p style={bodyStyle}>{t("editorPackage.missingBody")}</p>
					<ul style={{ margin: "10px 0 0", paddingLeft: 20, maxHeight: 220, overflow: "auto" }}>
						{state.files.map((name) => (
							<li key={name} style={{ ...bodyStyle, font: "12px/1.6 var(--font-mono)" }}>
								{name}
							</li>
						))}
					</ul>
				</ModalShell>
			);
		case "conflict":
			return (
				<ModalShell
					open
					onClose={onClose}
					title={t("editorPackage.conflictTitle")}
					footer={
						<>
							<button
								type="button"
								className={`${styles.btn} ${styles.btnSecondary}`}
								onClick={() => onChoose("replace")}
							>
								{t("editorPackage.replace")}
							</button>
							<button
								type="button"
								className={`${styles.btn} ${styles.btnPrimary}`}
								onClick={() => onChoose("copy")}
							>
								{t("editorPackage.openAsCopy")}
							</button>
						</>
					}
				>
					<p style={bodyStyle}>{t("editorPackage.conflictBody", { title: state.title })}</p>
				</ModalShell>
			);
		case "opened":
			return (
				<ModalShell open onClose={onClose} title={t("editorPackage.openedTitle")}>
					<p style={bodyStyle}>{t("editorPackage.openedBody", { title: state.title })}</p>
				</ModalShell>
			);
		case "error":
			return (
				<ModalShell open onClose={onClose} title={t("editorPackage.errorTitle")}>
					<p style={bodyStyle}>{state.reason}</p>
				</ModalShell>
			);
	}
}
