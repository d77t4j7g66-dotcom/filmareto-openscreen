// Shown in the chat body while there is no Claude to talk to: the chat runs on the user's own Claude
// plan, through Claude Code on this Mac, so all there can be to set up is that.

import { ArrowRight, Info, Sparkles } from "lucide-react";
import { useScopedT } from "@/contexts/I18nContext";
import styles from "./NewEditorShell.module.css";

const FEATURE_KEYS = ["feature1", "feature2", "feature3"] as const;
const INSTALL_URL = "https://claude.com/product/claude-code";

export function ChatWelcome({ installed }: { installed: boolean }) {
	const t = useScopedT("editor");

	return (
		<div className={styles.chatWelcome}>
			<header className={styles.chatWelcomeHero}>
				<Sparkles size={20} className={styles.chatWelcomeIcon} aria-hidden="true" />
				<h2 className={styles.chatWelcomeTitle}>{t("chat.welcome.title")}</h2>
				<p className={styles.chatWelcomeSubtitle}>
					{installed ? t("chat.welcome.subtitle") : t("chat.welcome.subtitleInstall")}
				</p>
			</header>

			<ul className={styles.chatWelcomeFeatures}>
				{FEATURE_KEYS.map((key) => (
					<li key={key}>{t(`chat.welcome.${key}`)}</li>
				))}
			</ul>

			<button
				type="button"
				className={styles.chatWelcomeCta}
				onClick={() =>
					installed
						? void window.electronAPI.claudeSignIn()
						: void window.electronAPI.openExternalUrl(INSTALL_URL)
				}
			>
				{installed ? t("chat.welcome.cta") : t("chat.welcome.ctaInstall")}
				<ArrowRight size={16} />
			</button>

			<p className={styles.chatWelcomeDisclaimer}>
				<Info size={14} className={styles.chatWelcomeDisclaimerIcon} aria-hidden="true" />
				<span>{t("chat.welcome.disclaimer")}</span>
			</p>
		</div>
	);
}
