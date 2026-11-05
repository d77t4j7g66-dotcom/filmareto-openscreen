// A timeline file that stacks the exported layers, for an editor to import: Final Cut Pro XML
// (FCPXML 1.8) for DaVinci Resolve, and FCP7 XML (xmeml 4) for Premiere. The layers are the
// export's own files, all the same length and the same frame rate: the main video (screen and
// camera, trims and speed already applied) on the first video track, with its audio, and the
// overlay (keycaps, picture-in-picture, annotations) with alpha on the track above it.
//
// Pure: the dialog hands it the paths and numbers, and writes what comes back.

export type EditorTarget = "resolve" | "premiere";

export interface EditorTimelineInput {
	name: string;
	/** Whole frames per second the layers were rendered at. */
	fps: number;
	width: number;
	height: number;
	/** Length of every layer, in frames. */
	durationFrames: number;
	/** Absolute path of the main video. */
	mainPath: string;
	/** Absolute path of the overlay with alpha; absent when the project has no overlay. */
	overlayPath?: string;
}

export function editorTimelineExtension(target: EditorTarget): string {
	return target === "resolve" ? "fcpxml" : "xml";
}

export function buildEditorTimeline(target: EditorTarget, input: EditorTimelineInput): string {
	return target === "resolve" ? buildFcpxml(input) : buildXmeml(input);
}

function escapeXml(text: string): string {
	return text
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;");
}

function fileName(filePath: string): string {
	return filePath.split(/[\\/]/).pop() ?? filePath;
}

/** `/Users/me/My Take.mp4` as the file URL an editor reads, spaces and all escaped. */
export function fileUrl(filePath: string, host = ""): string {
	const normalised = filePath.replace(/\\/g, "/");
	const absolute = normalised.startsWith("/") ? normalised : `/${normalised}`;
	return `file://${host}${encodeURI(absolute).replace(/[?#]/g, encodeURIComponent)}`;
}

function buildFcpxml(input: EditorTimelineInput): string {
	const { fps, width, height, durationFrames: frames } = input;
	const frameDuration = `1/${fps}s`;
	const duration = `${frames}/${fps}s`;
	const name = escapeXml(input.name);
	const overlay = input.overlayPath
		? `
    <asset id="r3" name="${escapeXml(fileName(input.overlayPath))}" src="${escapeXml(fileUrl(input.overlayPath))}" start="0s" duration="${duration}" hasVideo="1" format="r1"/>`
		: "";
	const overlayClip = input.overlayPath
		? `
              <asset-clip ref="r3" lane="1" offset="0s" name="${escapeXml(fileName(input.overlayPath))}" duration="${duration}" format="r1"/>`
		: "";
	return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE fcpxml>
<fcpxml version="1.8">
  <resources>
    <format id="r1" name="FFVideoFormatCustom" frameDuration="${frameDuration}" width="${width}" height="${height}"/>
    <asset id="r2" name="${escapeXml(fileName(input.mainPath))}" src="${escapeXml(fileUrl(input.mainPath))}" start="0s" duration="${duration}" hasVideo="1" hasAudio="1" format="r1" audioSources="1" audioChannels="2" audioRate="48000"/>${overlay}
  </resources>
  <library>
    <event name="${name}">
      <project name="${name}">
        <sequence format="r1" duration="${duration}" tcStart="0s" tcFormat="NDF" audioLayout="stereo" audioRate="48k">
          <spine>
            <asset-clip ref="r2" offset="0s" name="${escapeXml(fileName(input.mainPath))}" duration="${duration}" format="r1" tcFormat="NDF">${overlayClip}
            </asset-clip>
          </spine>
        </sequence>
      </project>
    </event>
  </library>
</fcpxml>
`;
}

function buildXmeml(input: EditorTimelineInput): string {
	const { fps, width, height, durationFrames: frames } = input;
	const rate = `<rate><timebase>${fps}</timebase><ntsc>FALSE</ntsc></rate>`;
	const characteristics = `<samplecharacteristics>${rate}<width>${width}</width><height>${height}</height><anamorphic>FALSE</anamorphic><pixelaspectratio>square</pixelaspectratio><fielddominance>none</fielddominance></samplecharacteristics>`;
	const file = (id: string, filePath: string, audio: boolean) =>
		`<file id="${id}"><name>${escapeXml(fileName(filePath))}</name><pathurl>${escapeXml(fileUrl(filePath, "localhost"))}</pathurl>${rate}<duration>${frames}</duration><media><video>${characteristics}</video>${
			audio
				? "<audio><samplecharacteristics><depth>16</depth><samplerate>48000</samplerate></samplecharacteristics><channelcount>2</channelcount></audio>"
				: ""
		}</media></file>`;
	const clip = (id: string, filePath: string, fileXml: string, extra = "") =>
		`<clipitem id="${id}"><name>${escapeXml(fileName(filePath))}</name><enabled>TRUE</enabled><duration>${frames}</duration>${rate}<start>0</start><end>${frames}</end><in>0</in><out>${frames}</out>${fileXml}${extra}</clipitem>`;
	const mainVideo = clip("clipitem-1", input.mainPath, file("file-1", input.mainPath, true));
	const overlayVideo = input.overlayPath
		? `<track>${clip("clipitem-2", input.overlayPath, file("file-2", input.overlayPath, false))}</track>`
		: "";
	const audioClip = (channel: number) =>
		`<clipitem id="clipitem-a${channel}"><name>${escapeXml(fileName(input.mainPath))}</name><enabled>TRUE</enabled><duration>${frames}</duration>${rate}<start>0</start><end>${frames}</end><in>0</in><out>${frames}</out><file id="file-1"/><sourcetrack><mediatype>audio</mediatype><trackindex>${channel}</trackindex></sourcetrack></clipitem>`;
	return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE xmeml>
<xmeml version="4">
  <sequence id="sequence-1">
    <name>${escapeXml(input.name)}</name>
    <duration>${frames}</duration>
    ${rate}
    <media>
      <video>
        <format>${characteristics}</format>
        <track>${mainVideo}</track>
        ${overlayVideo}
      </video>
      <audio>
        <track>${audioClip(1)}</track>
        <track>${audioClip(2)}</track>
      </audio>
    </media>
  </sequence>
</xmeml>
`;
}
