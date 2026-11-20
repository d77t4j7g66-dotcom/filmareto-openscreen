// Not a check: writes every style's text as the compositor receives it, for `scripts/caption-style-thumbs.py`.
// CAPTION_THUMBS_OUT=/tmp/looks.json CAPTION_THUMBS_TEXT="your next video" npx vitest run styleThumbs.gen
import { writeFileSync } from "node:fs";
import { describe, it } from "vitest";
import { captionCuesToTextRegions } from "./cues";
import {
	CAPTION_STYLES,
	type CaptionSettings,
	type CaptionStyleId,
	captionStylePatch,
	DEFAULT_CAPTION_SETTINGS,
} from "./settings";

const out = process.env.CAPTION_THUMBS_OUT;
const FRAME = { w: 1080, h: 1920 };

describe.runIf(Boolean(out))("caption style thumbnails", () => {
	it("writes them", () => {
		const aspect = FRAME.w / FRAME.h;
		const words = (process.env.CAPTION_THUMBS_TEXT ?? "your next video").split(" ");
		const looks = (Object.keys(CAPTION_STYLES) as CaptionStyleId[]).map((id) => {
			const settings: CaptionSettings = {
				...DEFAULT_CAPTION_SETTINGS,
				enabled: true,
				insetY: 24,
				...captionStylePatch(id, aspect),
			};
			const shown = words.slice(0, settings.maxWordsPerLine);
			const cue = {
				id: "c",
				startMs: 0,
				endMs: 3000,
				text: shown.join(" "),
				words: shown.map((text, i) => ({ text, startMs: i * 1000, endMs: (i + 1) * 1000 })),
			};
			const regions = captionCuesToTextRegions([cue], settings, aspect);
			// The word being said is the middle one, or the only one.
			const region = regions[Math.min(1, regions.length - 1)];
			const px = (region.style.fontSize / 1080) * FRAME.h;
			return {
				name: id,
				px,
				w: Math.round((region.size.width / 100) * FRAME.w),
				h: Math.round((region.size.height / 100) * FRAME.h),
				x: Math.round((region.position.x / 100) * FRAME.w),
				y: Math.round((region.position.y / 100) * FRAME.h),
				elapsed: 1000,
				scene: 1300,
				text: {
					content: region.content,
					color: region.style.color,
					backgroundColor: region.style.backgroundColor,
					fontSizeRel: 0.05,
					fontFamily: region.style.fontFamily,
					fontWeight: region.style.fontWeight,
					fontStyle: region.style.fontStyle,
					textDecoration: region.style.textDecoration,
					textAlign: region.style.textAlign,
					verticalAlign: region.verticalAlign,
					animation: null,
					runs: region.runs ?? [],
					stroke: region.stroke ?? null,
					shadow: region.shadow ?? null,
					fx: region.fx ?? null,
				},
			};
		});
		writeFileSync(out as string, JSON.stringify(looks));
		const patches = Object.fromEntries(
			(Object.keys(CAPTION_STYLES) as CaptionStyleId[]).map((id) => [
				id,
				captionStylePatch(id, aspect),
			]),
		);
		writeFileSync(`${out}.patches.json`, JSON.stringify(patches));
	});
});
