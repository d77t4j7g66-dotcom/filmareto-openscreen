import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { app, BrowserWindow, ipcMain, type NativeImage, shell } from "electron";

/**
 * Motion graphics as HyperFrames compositions: HTML rendered offline, here, by seeking the
 * composition frame by frame in a hidden window with the HyperFrames runtime in it. The frames are
 * PNGs with alpha, which the compositor draws as images over the program, so no browser and no
 * network take part in a preview or an export.
 */

const FPS = 30;
/** Bumped when a render would come out different for the same inputs. */
const RENDER_VERSION = 1;
const READY_TIMEOUT_MS = 15_000;
/** How long a composition with no `__renderReady` signal gets to settle. */
const SETTLE_MS = 3_000;

export interface GraphicField {
	id: string;
	label: string;
	default: string;
}

export interface GraphicTemplate {
	id: string;
	name: string;
	variables: GraphicField[];
	durationSec: number;
	holdSec: number;
	/** Laid out for whatever frame it is given, rather than for a size of its own. */
	fitsFormat: boolean;
}

export interface GraphicRender {
	frames: { path: string; atMs: number }[];
	durationMs: number;
	holdMs: number;
}

interface Located extends GraphicTemplate {
	dir: string;
	html: string;
	ownSize: { width: number; height: number } | null;
}

function runtimeRoot(): string {
	return app.isPackaged
		? path.join(process.resourcesPath, "electron", "graphics")
		: path.join(app.getAppPath(), "electron", "graphics");
}

function userRoot(): string {
	return path.join(app.getPath("userData"), "graphics");
}

const attribute = (html: string, name: string): string | null => {
	const match = new RegExp(`${name}=(?:'([^']*)'|"([^"]*)")`).exec(html);
	return match ? (match[1] ?? match[2] ?? "") : null;
};

function readVariables(html: string): GraphicField[] {
	try {
		const raw = JSON.parse(attribute(html, "data-composition-variables") ?? "[]") as Array<{
			id?: unknown;
			label?: unknown;
			default?: unknown;
		}>;
		return raw
			.filter((v) => typeof v.id === "string")
			.map((v) => ({
				id: v.id as string,
				label: typeof v.label === "string" ? v.label : (v.id as string),
				default: v.default === undefined ? "" : String(v.default),
			}));
	} catch {
		return [];
	}
}

function readTemplate(id: string, dir: string, folder: string): Located | null {
	const file = path.join(dir, "index.html");
	if (!existsSync(file)) return null;
	const html = readFileSync(file, "utf8");
	const root = /<[^>]*\bid="root"[^>]*>/s.exec(html)?.[0] ?? "";
	const durationSec = Number(attribute(root, "data-duration")) || 3;
	const hold = Number(attribute(html, "data-graphic-hold"));
	const width = Number(attribute(root, "data-width"));
	const height = Number(attribute(root, "data-height"));
	return {
		id,
		dir,
		html,
		name: attribute(html, "data-graphic-name") ?? folder,
		variables: readVariables(html),
		durationSec,
		// An outside composition does not say: the last moments are its way out.
		holdSec: hold > 0 && hold < durationSec ? hold : Math.max(0, durationSec - 0.4),
		fitsFormat: root.includes("data-fit-format"),
		ownSize: width > 0 && height > 0 ? { width, height } : null,
	};
}

function listLocated(): Located[] {
	const read = (root: string, prefix: string) =>
		existsSync(root)
			? readdirSync(root, { withFileTypes: true })
					.filter((entry) => entry.isDirectory() && !entry.name.startsWith("_"))
					.map((entry) =>
						readTemplate(`${prefix}:${entry.name}`, path.join(root, entry.name), entry.name),
					)
					.filter((template): template is Located => template !== null)
			: [];
	return [...read(path.join(runtimeRoot(), "templates"), "builtin"), ...read(userRoot(), "user")];
}

const publicTemplate = ({
	dir: _d,
	html: _h,
	ownSize: _o,
	...template
}: Located): GraphicTemplate => template;

function locate(templateId: string): Located {
	const template = listLocated().find((candidate) => candidate.id === templateId);
	if (!template) throw new Error(`Graphic not found: ${templateId}`);
	return template;
}

/** The composition's page: its own file, with the runtime and the values put in front of it. */
function pageFor(
	template: Located,
	variables: Record<string, string>,
	width: number,
	height: number,
): string {
	const base = `${pathToFileURL(template.dir).href}/`;
	const runtime = pathToFileURL(path.join(runtimeRoot(), "hyperframe.runtime.iife.js")).href;
	const values = JSON.stringify(variables).replace(/</g, "\\u003c");
	const inject = `<base href="${base}"><script>window.__timelines=window.__timelines||{};window.__hfVariables=${values};</script><script src="${runtime}"></script>`;
	const sized = template.html.replace(
		"data-fit-format",
		`data-width="${width}" data-height="${height}"`,
	);
	return /<head[^>]*>/i.test(sized)
		? sized.replace(/<head[^>]*>/i, (head) => head + inject)
		: inject + sized;
}

/**
 * Renders the frames at `times` (seconds) into `dir`, calling `onFrame` for each. Only a frame that
 * differs from the one before it is handed over as an image: most of a graphic holds still.
 */
async function capture(
	page: string,
	dir: string,
	width: number,
	height: number,
	times: number[],
	onFrame: (index: number, image: NativeImage | null) => void,
): Promise<void> {
	mkdirSync(dir, { recursive: true });
	const pageFile = path.join(dir, "page.html");
	writeFileSync(pageFile, page);
	const win = new BrowserWindow({
		show: false,
		width,
		height,
		useContentSize: true,
		frame: false,
		transparent: true,
		enableLargerThanScreen: true,
		backgroundColor: "#00000000",
		webPreferences: {
			offscreen: true,
			sandbox: true,
			contextIsolation: true,
			nodeIntegration: false,
			// A composition reads its own scene files over file://, which fetch refuses otherwise.
			webSecurity: false,
			backgroundThrottling: false,
			partition: "graphics",
		},
	});
	const contents = win.webContents;
	contents.setWindowOpenHandler(() => ({ action: "deny" }));
	contents.on("will-navigate", (event) => event.preventDefault());
	try {
		win.setContentSize(width, height);
		contents.setFrameRate(60);
		let latest: NativeImage | null = null;
		let onPaint: (() => void) | null = null;
		contents.on("paint", (_event, _dirty, image) => {
			latest = image;
			onPaint?.();
		});
		const nextPaint = () =>
			new Promise<void>((resolve) => {
				const timer = setTimeout(resolve, 400);
				onPaint = () => {
					clearTimeout(timer);
					onPaint = null;
					resolve();
				};
			});
		await win.loadFile(pageFile);
		const started = Date.now();
		for (;;) {
			const [player, ready] = (await contents.executeJavaScript(
				"[!!(window.__player&&window.__player.renderSeek),window.__renderReady===true]",
			)) as [boolean, boolean];
			if (player && (ready || Date.now() - started > SETTLE_MS)) break;
			if (Date.now() - started > READY_TIMEOUT_MS) {
				throw new Error("The graphic did not start: check its HTML");
			}
			await new Promise((resolve) => setTimeout(resolve, 50));
		}
		await contents.executeJavaScript(
			"document.fonts.ready.then(()=>{window.__graphicFit&&window.__graphicFit();return 1})",
		);
		// The runtime picks up nested CSS animations on its first seek, too late for that seek itself.
		await contents.executeJavaScript(`window.__player.renderSeek(${times[0] ?? 0});1`);
		let previous = "";
		for (const [index, time] of times.entries()) {
			await contents.executeJavaScript(
				`new Promise(r=>{window.__player.renderSeek(${time});requestAnimationFrame(()=>requestAnimationFrame(()=>r(1)))})`,
			);
			// The paint right after a seek can still be the frame before it.
			for (let pass = 0; pass < 2; pass += 1) {
				const painted = nextPaint();
				contents.invalidate();
				await painted;
			}
			if (!latest) throw new Error("The graphic did not draw");
			const image = latest as NativeImage;
			const hash = createHash("sha1").update(image.toBitmap()).digest("hex");
			if (hash === previous) {
				onFrame(index, null);
				continue;
			}
			previous = hash;
			const size = image.getSize();
			onFrame(
				index,
				// A Retina display paints at twice the size.
				size.width === width && size.height === height
					? image
					: image.resize({ width, height, quality: "best" }),
			);
		}
	} finally {
		win.destroy();
	}
}

function cacheDir(template: Located, parts: unknown[]): string {
	const stamp = statSync(path.join(template.dir, "index.html")).mtimeMs;
	const key = createHash("sha1")
		.update(JSON.stringify([RENDER_VERSION, template.id, stamp, ...parts]))
		.digest("hex")
		.slice(0, 20);
	return path.join(app.getPath("userData"), "graphics-cache", key);
}

// One hidden window at a time: a render is heavy, and a burst of them comes from one project.
let queue: Promise<unknown> = Promise.resolve();
function enqueue<T>(job: () => Promise<T>): Promise<T> {
	const run = queue.then(job, job);
	queue = run.catch(() => undefined);
	return run;
}

function renderGraphic(
	templateId: string,
	variables: Record<string, string>,
	frameWidth: number,
	frameHeight: number,
): Promise<GraphicRender> {
	return enqueue(async () => {
		const template = locate(templateId);
		const { width, height } =
			template.fitsFormat || !template.ownSize
				? { width: frameWidth, height: frameHeight }
				: template.ownSize;
		const dir = cacheDir(template, [variables, width, height, FPS]);
		const manifest = path.join(dir, "manifest.json");
		if (existsSync(manifest)) {
			const cached = JSON.parse(readFileSync(manifest, "utf8")) as GraphicRender;
			if (cached.frames.every((frame) => existsSync(frame.path))) return cached;
		}
		const count = Math.max(1, Math.round(template.durationSec * FPS));
		const times = Array.from({ length: count }, (_unused, index) => index / FPS);
		const frames: GraphicRender["frames"] = [];
		await capture(
			pageFor(template, variables, width, height),
			dir,
			width,
			height,
			times,
			(index, image) => {
				if (!image) return;
				const file = path.join(dir, `f${String(index).padStart(5, "0")}.png`);
				writeFileSync(file, image.toPNG());
				frames.push({ path: file, atMs: Math.round((index * 1000) / FPS) });
			},
		);
		const result: GraphicRender = {
			frames,
			durationMs: Math.round(template.durationSec * 1000),
			holdMs: Math.round(template.holdSec * 1000),
		};
		writeFileSync(manifest, JSON.stringify(result));
		return result;
	});
}

/** One still of a template with its own wording, for the menu. */
function previewGraphic(templateId: string, frameWidth: number, frameHeight: number) {
	return enqueue(async () => {
		const template = locate(templateId);
		const { width, height } =
			template.fitsFormat || !template.ownSize
				? { width: frameWidth, height: frameHeight }
				: template.ownSize;
		const dir = cacheDir(template, ["preview", width, height]);
		const file = path.join(dir, "preview.png");
		if (existsSync(file)) return file;
		const variables = Object.fromEntries(template.variables.map((v) => [v.id, v.default]));
		await capture(
			pageFor(template, variables, width, height),
			dir,
			width,
			height,
			[template.holdSec * 0.9],
			(_index, image) => {
				if (image) writeFileSync(file, image.toPNG());
			},
		);
		return file;
	});
}

export function registerGraphics(): void {
	ipcMain.handle("graphics:list", () => listLocated().map(publicTemplate));
	ipcMain.handle(
		"graphics:render",
		(
			_event,
			request: {
				templateId: string;
				variables: Record<string, string>;
				width: number;
				height: number;
			},
		) => renderGraphic(request.templateId, request.variables, request.width, request.height),
	);
	ipcMain.handle(
		"graphics:preview",
		(_event, request: { templateId: string; width: number; height: number }) =>
			previewGraphic(request.templateId, request.width, request.height),
	);
	ipcMain.handle("graphics:openFolder", () => {
		mkdirSync(userRoot(), { recursive: true });
		return shell.openPath(userRoot());
	});
}
