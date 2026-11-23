# Filmareto Screen (DaVinci Resolve)

The Resolve side of "Export για Resolve": a Fusion effect that redraws a screen recording, or a camera,
from per-frame framing data the app exported. Auto / Whole screen / Manual, live controls, never
per-frame keyframes.

## Files

| File | Installs to |
|---|---|
| `FilmaretoScreen.fuse` (Fuse, self-contained: Lua math + GPU kernel) | `~/Library/Application Support/Blackmagic Design/DaVinci Resolve/Fusion/Fuses/Filmareto/` |
| `Filmareto Screen.setting` (macro, shown on the Edit page as "Filmareto Screen") | `~/Library/Application Support/Blackmagic Design/DaVinci Resolve/Fusion/Templates/Edit/Effects/` |
| `Filmareto Import.lua` (import script, Workspace > Scripts > Utility > Filmareto Import) | `~/Library/Application Support/Blackmagic Design/DaVinci Resolve/Fusion/Scripts/Utility/` |

The export also writes a pointer file, `~/Library/Application Support/Blackmagic Design/DaVinci Resolve/Fusion/Filmareto/last-export.lua`
(`return { folder = "<export folder>" }`), once the export folder is complete. The import script reads
it to find the latest export. It lives outside `Scripts/` so it stays out of the Scripts menu.

The app copies all of these BEFORE it starts the export's media work, so a build that does not ship the
Fuse stops at once.

## Paths in the export

`timeline.lua` (media paths, each effect's `data` and `atlas`) and the data files' own `cursor.atlas` are
written relative to the export folder, so the folder can be moved or renamed. The import script joins them
to the folder `last-export.lua` names (an absolute path is kept as it is), and sets the Loader clip to the
joined, absolute path of the atlas. The timeline is the project's aspect with the short side at 1080
(9:16 is 1080x1920, 16:9 is 1920x1080), both sides even.

A Fuse loads only when Resolve starts, so after installing or updating it Resolve needs one restart.
Never `comp:AddTool` the Fuse from a script (it can crash Resolve): the effect is added only through the
template (`TimelineItem.AddEffect`).

## What the import script must set on each clip's effect

The macro is named `FilmaretoScreen`; inside it is only the Fuse `FScreen`. The effect comp already has a
MediaIn of its own (the clip the effect sits on), so the script ADDS two tools to it with `comp:AddTool`: a
`MediaIn` for the full-resolution Source and, for the screen role, a `Loader` for the cursor atlas. Both are
configured and connected to `FScreen` last, inside `comp:Lock()`. (A MediaIn named `MediaIn1` inside the
template crashed Resolve 21.2 the moment the effect was added: SIGBUS in the Fusion render thread.)

| What | Where | Value |
|---|---|---|
| `DataFile` | macro input (published) | absolute path of the segment's `data/<segKey>.lua` |
| `ClipStartFrame` | Fuse input (hidden) | the clip's SOURCE start frame (`start` in `timeline.lua`). The effect comp has no `COMPN_GlobalStart` in 21.2 and its time is the clip's own (0 at the clip's first frame, measured), so the media frame is this plus the time |
| `MediaSource` / `MediaID` | the added MediaIn | `MediaPool`, and the Media Pool item id of the full-resolution recording |
| `Clip` | the added Loader | absolute path of the cursor atlas PNG (`cursors.png`, screen role only) |
| `FetchByFrame` | macro input (published, default 1) | 1: the Fuse pulls `Source` at the media frame, so the MediaIn keeps `GlobalIn = 0`, `ClipTimeStart = 0`, `GlobalOut` large. 0: `Source` is taken at `req.Time` |

A missing or broken `DataFile`, or data with no `Source` picture (not connected, `MediaID` not set), passes
the main input (the timeline-resolution clip) through with a thin red border and writes one line to the
Fusion console. It never errors and never draws the crop on the wrong picture.

## Controls

Mode (Auto / Ολόκληρη οθόνη / Manual), Smoothing (s, 0 to 1.5, default 0 = exactly the app's motion; otherwise a
centred Gaussian average over +/- that many seconds, no lag), Zoom strength (0 to 2.5, keeps the zoom's fixed
point), Offset (shifts the drawn card in output space, so it works at zoom 1 too, and the cursor moves with it), Safe zone top / bottom / right / left (%) (the safe zone applies BEFORE Offset: the card is first fitted inside the safe zone, then Offset moves it), Manual centre, Manual zoom (1 to 5),
Transition from Auto (s), Cursor on/off, Cursor size (x). Manual centre and zoom are ordinary inputs, so
they can be keyframed on the Edit page. The Auto data stays untouched when Mode is switched to Manual.

## Tests

`bash scripts/test-resolve-lua.sh` runs `resolve/tests/core_test.lua` under Resolve's `fuscript -l lua`
(plain LuaJIT, no connection to Resolve). It tests `FilmaretoCore`, the pure-Lua table at the top of the
Fuse. The GPU kernel and the Fuse glue cannot run outside Resolve and are untested until Task 8.

## Not in v1

Motion blur (screen, card, camera, cursor trail), click rings, keycaps, 3D tilt/orbit and the 3D cursor
(the flat sprite is drawn at the true pointer position), the window or device frame, shader effects, the
camera's cutout / blur / custom background, depth of field. The export names each of these in its warnings.

## Notes

- The cursor atlas PNG is straight alpha. The kernel premultiplies it; do not set a post-multiply on `Loader1`.
- Atlas hotspots are fractions (0..1) of the sprite, as written by the app's `cursorAtlas`.
- The data file is re-validated every 2 s by file size and reloaded if it changed; a failed path is retried after 2 s.
- Camera data with `mirror = true` draws the crop flipped horizontally.
- v1 limit: block-layout masking (cropping the card to a layout block) is not done by this effect.
- `GetSource(frame)` is called without request flags, so proxy/quick modes may fetch the Source at full quality.
