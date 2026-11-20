import { useMemo } from "react";
import type { SceneChoice } from "@/components/video-editor/types";
import { useScopedT } from "@/contexts/I18nContext";

/** What the menu and the timeline call each layout. */
export function useSceneLabels(): Record<SceneChoice, string> {
	const t = useScopedT("editor");
	return useMemo(
		() => ({
			camera: t("studio.layoutCamera"),
			"picture-in-picture": t("studio.layoutCorner"),
			"vertical-stack": t("studio.layoutStack"),
			"dual-frame": t("studio.layoutSide"),
			"cutout-stack": t("studio.layoutCutout"),
			"free-layout": t("studio.layoutFree"),
			screen: t("studio.layoutScreen"),
		}),
		[t],
	);
}
