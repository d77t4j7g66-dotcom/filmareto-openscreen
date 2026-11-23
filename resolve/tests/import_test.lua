-- Tests for the pure parts of resolve/Filmareto Import.lua (no Resolve connection).
-- Run: bash scripts/test-resolve-lua.sh

local root = os.getenv("FILMARETO_ROOT") or "."
_G.FILMARETO_IMPORT_TEST = true
_G.Resolve = function() error("Resolve() must not be called under test") end
dofile(root .. "/resolve/Filmareto Import.lua")
local I = _G.FilmaretoImport

local failures, count = 0, 0
local function check(name, cond, extra)
	count = count + 1
	if not cond then
		failures = failures + 1
		print("FAIL: " .. name .. (extra and (" -> " .. tostring(extra)) or ""))
	else
		print("ok:   " .. name)
	end
end

check("script exposes its pure parts under the test guard", type(I) == "table" and type(I.buildClipInfo) == "function")

-- Manifest reading: fixture + a fake pointer file (chunks are loaded through an injected loader)
local fixtureDir = root .. "/resolve/tests/fixtures/export"
local function loader(path)
	if path == "/fake/last-export.lua" then return { folder = fixtureDir } end
	if path == "/fake/nofolder.lua" then return {} end
	return dofile(path)
end
local m, err, folder = I.readManifestFromLastExport("/fake/last-export.lua", loader)
check("reads the manifest through last-export.lua", m ~= nil and m.name == "Lesson 1" and folder == fixtureDir, err)
check("manifest has media and clips", m and #m.media == 4 and #m.clips == 5)
check("media paths are joined to the export folder", m and m.media[2].path == fixtureDir .. "/media/rec.mov", m and m.media[2].path)
check("effect data and atlas are joined too", m and m.clips[2].effect.data == fixtureDir .. "/data/seg-001.lua"
	and m.clips[2].effect.atlas == fixtureDir .. "/cursors.png" and m.clips[3].effect.atlas == nil)
check("resolvePath keeps an absolute path", I.resolvePath("/exp", "/abs/x.mov") == "/abs/x.mov"
	and I.resolvePath("C:/exp", "D:\\x.mov") == "D:\\x.mov")
check("resolvePath joins a relative path and tolerates a trailing slash", I.resolvePath("/exp/", "media/a.mov") == "/exp/media/a.mov")
local abs = I.absolutizeManifest({ media = { { key = "k", path = "/already/abs.mov" } }, clips = { { effect = { data = "/abs/d.lua" } } } }, "/exp")
check("absolutizeManifest leaves absolute paths alone", abs.media[1].path == "/already/abs.mov" and abs.clips[1].effect.data == "/abs/d.lua")
local _, e1 = I.readManifestFromLastExport("/fake/missing.lua", function(p) error("cannot open " .. p) end)
check("missing pointer gives a clear message", e1 ~= nil and e1:find("last export pointer", 1, true) ~= nil, e1)
local _, e2 = I.readManifestFromLastExport("/fake/nofolder.lua", loader)
check("pointer without folder is rejected", e2 ~= nil and e2:find("no folder", 1, true) ~= nil, e2)
local _, e3 = I.readManifestFromLastExport("/fake/last-export.lua", function(p)
	if p == "/fake/last-export.lua" then return { folder = "/nowhere" } end
	error("cannot open " .. p)
end)
check("missing timeline.lua names the folder", e3 ~= nil and e3:find("/nowhere", 1, true) ~= nil, e3)
check("a manifest with an unknown media key is rejected",
	I.validateManifest({ format = 1, name = "x", width = 1, height = 1, fps = 30,
		media = {}, clips = { { track = "video", index = 1, media = "zz", start = 0, finish = 1, record = 0 } } }) == nil)
check("a wrong format is rejected", I.validateManifest({ format = 2 }) == nil)
check("a broken chunk gives nil and a reason", select(2, I.loadTable("/x", function() error("boom") end)) ~= nil)

-- uniqueName
local taken = { ["A"] = true, ["A 2"] = true, ["B"] = true }
local ex = function(n) return taken[n] end
check("uniqueName keeps a free name", I.uniqueName("C", ex) == "C")
check("uniqueName adds 2", I.uniqueName("B", ex) == "B 2")
check("uniqueName skips taken numbers", I.uniqueName("A", ex) == "A 3")

-- clipInfo frame maths
local mpi = { id = "item" }
local c = m.clips[2] -- start 60, finish 360 (exclusive), record 0, V2
local info = I.buildClipInfo(c, mpi, 86400)
check("clipInfo: startFrame is the manifest start", info.startFrame == 60)
check("clipInfo: endFrame is finish minus one (finish is exclusive)", info.endFrame == 359 and I.FINISH_TO_END_FRAME == -1)
check("clipInfo: frame count is unchanged", (info.endFrame - info.startFrame + 1) == (c.finish - c.start))
check("clipInfo: recordFrame adds the timeline start", info.recordFrame == 86400)
check("clipInfo: trackIndex and mediaPoolItem", info.trackIndex == 2 and info.mediaPoolItem == mpi)
check("clipInfo: video is mediaType 1", info.mediaType == 1)
local ai = I.buildClipInfo(m.clips[5], mpi, 100)
check("clipInfo: audio is mediaType 2 at record offset", ai.mediaType == 2 and ai.recordFrame == 400 and ai.trackIndex == 3)
local si = I.buildClipInfo(m.clips[1], mpi, 0)
check("clipInfo: a still is video only", si.mediaType == 1 and si.startFrame == 0 and si.endFrame == 299)

-- required tracks
local v, a = I.requiredTracks(m.clips)
check("requiredTracks: highest video and audio index", v == 3 and a == 3, v .. "," .. a)

-- item -> key mapping
local items = {
	{ p = fixtureDir .. "/media/rec.mov" }, { p = "/private/exp/cam.mov" }, { p = fixtureDir .. "/media/mic.wav" },
	{ p = fixtureDir .. "/media/bg.png" }, { p = "/other/zzz.mov" },
}
local byKey, un = I.mapItemsToKeys(items, m.media, function(it) return it.p end)
check("mapItemsToKeys: exact path", byKey.m1 == items[1] and byKey.bg == items[4])
check("mapItemsToKeys: unique file name survives a path prefix", byKey.cam1 == items[2])
check("mapItemsToKeys: unknown items are reported", #un == 1 and un[1] == "/other/zzz.mov")

-- one path, several keys (voice pieces falling back to the screen file)
local media2 = { { key = "m1", path = "/exp/rec.mov" }, { key = "v1", path = "/exp/rec.mov" }, { key = "c", path = "/exp/a/x.mov" }, { key = "d", path = "/exp/b/x.mov" } }
local shared = { p = "/exp/rec.mov" }
local k2, un2 = I.mapItemsToKeys({ shared, { p = "/private/exp/a/x.mov" } }, media2, function(it) return it.p end)
check("mapItemsToKeys: one path feeds all its keys", k2.m1 == shared and k2.v1 == shared)
check("mapItemsToKeys: an ambiguous file name is not guessed", k2.c == nil and k2.d == nil and #un2 == 1)
local media3 = { { key = "a", path = "/exp/s.mov" }, { key = "b", path = "/exp/s.mov" } }
local it3 = { p = "/private/exp/s.mov" }
local k3 = I.mapItemsToKeys({ it3 }, media3, function(it) return it.p end)
check("mapItemsToKeys: basename fallback feeds all keys too", k3.a == it3 and k3.b == it3)

-- effect lookup
local list = { { category = "fusion", id = "Other", name = "Other" }, { category = "fusion", id = "X1", name = "Filmareto Screen" } }
check("findEffectInfo finds the effect by name", I.findEffectInfo(list).id == "X1")
check("findEffectInfo returns nil when absent", I.findEffectInfo({ { name = "Blur", category = "ofx", id = "b" } }) == nil)
check("findEffectInfo tolerates a nil list", I.findEffectInfo(nil) == nil)

-- tool finder by RegID, on stub tools (names are prefixed on purpose)
local function stubTool(name, reg)
	local t = { name = name, inputs = {} }
	function t:GetAttrs() return { TOOLS_RegID = reg, TOOLS_Name = name } end
	function t:SetInput(k, val) self.inputs[k] = val end
	function t:GetInput(k) return self.inputs[k] end
	t.connected = {}
	function t:ConnectInput(name, from) self.connected[name] = from; return true end
	return t
end
local fuse, mediaIn, loader2 = stubTool("fx_FScreen", "Fuse.FilmaretoScreen"), stubTool("fx_MediaIn1", "MediaIn"), stubTool("fx_Loader1", "Loader")
local comp = { GetToolList = function(self, sel) return { stubTool("Merge1", "Merge"), mediaIn, fuse, loader2 } end }
local tools = I.findTools(comp)
check("findTools: by RegID, not by name", tools.fuse == fuse and tools.mediaIn == mediaIn and tools.loader == loader2)
check("findTools: missing tools stay nil", I.findTools({ GetToolList = function() return { stubTool("M", "Merge") } end }).fuse == nil)

-- configureEffectTools
local fails = I.configureEffectTools(tools, { data = "/exp/data/seg-001.lua", atlas = "/exp/cursors.png" }, "MEDIA-ID-1")
check("configureEffectTools: no failures on stubs", #fails == 0, table.concat(fails, "; "))
check("configureEffectTools: Fuse inputs", fuse.inputs.DataFile == "/exp/data/seg-001.lua" and fuse.inputs.FetchByFrame == 1)
check("configureEffectTools: MediaIn inputs", mediaIn.inputs.MediaID == "MEDIA-ID-1" and mediaIn.inputs.GlobalIn == 0
	and mediaIn.inputs.ClipTimeStart == 0 and mediaIn.inputs.GlobalOut == 1e6)
check("configureEffectTools: Loader clip is the atlas", loader2.inputs.Clip == "/exp/cursors.png")
check("configureEffectTools: no clip start leaves the Fuse's alone", fuse.inputs.ClipStartFrame == nil)
local fuseC, miC, ldC = stubTool("cs", "Fuse.FilmaretoScreen"), stubTool("cm", "MediaIn"), stubTool("cl", "Loader")
local fC = I.configureEffectTools({ fuse = fuseC, mediaIn = miC, loader = ldC }, { data = "/d.lua" }, "id", 442)
check("configureEffectTools: the clip's source start is set", #fC == 0 and fuseC.inputs.ClipStartFrame == 442, table.concat(fC, "; "))
check("configureEffectTools: the MediaIn reads the Media Pool", mediaIn.inputs.MediaSource == "MediaPool")
check("configureEffectTools: connects Source and Atlas last", fuse.connected.Source == mediaIn and fuse.connected.Atlas == loader2)
local fuseN, miN, ldN = stubTool("n", "Fuse.FilmaretoScreen"), stubTool("o", "MediaIn"), stubTool("p", "Loader")
I.configureEffectTools({ fuse = fuseN, mediaIn = miN, loader = ldN }, { data = "/d.lua" }, nil)
check("configureEffectTools: nothing is connected when configuring failed", fuseN.connected.Source == nil)
local fuseR = stubTool("r", "Fuse.FilmaretoScreen")
function fuseR:ConnectInput() return false end
local fR = I.configureEffectTools({ fuse = fuseR, mediaIn = miN, loader = ldN }, { data = "/d.lua" }, "id")
check("configureEffectTools: a refused connection is a failure", #fR >= 1 and fR[1]:find("did not connect", 1, true) ~= nil, fR[1])
local fuse2, mi2, ld2 = stubTool("a", "Fuse.FilmaretoScreen"), stubTool("b", "MediaIn"), stubTool("c", "Loader")
I.configureEffectTools({ fuse = fuse2, mediaIn = mi2, loader = ld2 }, { data = "/d.lua" }, "id")
check("configureEffectTools: no atlas leaves the Loader alone", ld2.inputs.Clip == nil)
local f3 = I.configureEffectTools({ fuse = fuse2 }, { data = "/d.lua" }, nil)
check("configureEffectTools: missing tools and id are reported", #f3 >= 3, #f3)
local bad = stubTool("bad", "Fuse.FilmaretoScreen")
function bad:SetInput() error("locked") end
local f4 = I.configureEffectTools({ fuse = bad, mediaIn = mi2, loader = ld2 }, { data = "/d.lua" }, "id")
check("configureEffectTools: a throwing tool becomes a failure, not an error", #f4 == 2 and f4[1]:find("locked", 1, true) ~= nil, f4[1])
local stuck = stubTool("stuck", "MediaIn")
function stuck:GetInput() return 5 end
check("setInput: a value that does not read back is a failure", I.setInput(stuck, "GlobalIn", 0) == false)
check("setInput: matching value is ok", I.setInput(stubTool("ok", "MediaIn"), "GlobalIn", 0) == true)

-- connected MediaIn / Loader win over the first of their RegID
local fuseC = stubTool("F", "Fuse.FilmaretoScreen")
local mi1, mi2c, ldA, ldB = stubTool("M1", "MediaIn"), stubTool("M2", "MediaIn"), stubTool("L1", "Loader"), stubTool("L2", "Loader")
fuseC.Source = { GetConnectedOutput = function() return { GetTool = function() return mi2c end } end }
fuseC.Atlas = { GetConnectedOutput = function() return { GetTool = function() return ldB end } end }
local tc = I.findTools({ GetToolList = function() return { mi1, mi2c, ldA, ldB, fuseC } end })
check("findTools: picks the tools connected to Source and Atlas", tc.mediaIn == mi2c and tc.loader == ldB)
local fuseD = stubTool("F", "Fuse.FilmaretoScreen")
local td = I.findTools({ GetToolList = function() return { mi1, mi2c, fuseD } end })
check("findTools: falls back to the RegID scan when nothing is connected", td.mediaIn == mi1)

-- soft read-back warnings
local goT = stubTool("g", "MediaIn")
function goT:GetInput(k) if k == "GlobalOut" then return 999999 end return self.inputs[k] end
local ldS = stubTool("l", "Loader")
function ldS:GetInput() return "/normalised.png" end
local fS, wS = I.configureEffectTools({ fuse = stubTool("f", "Fuse.FilmaretoScreen"), mediaIn = goT, loader = ldS }, { data = "/d.lua", atlas = "/a.png" }, "id")
check("GlobalOut and Loader Clip read-back mismatches are warnings", #fS == 0 and #wS == 2, #fS .. "/" .. #wS)

-- current timeline guard
local function tl(id) return { GetUniqueId = function() return id end } end
check("isCurrentTimeline: same id", I.isCurrentTimeline({ GetCurrentTimeline = function() return tl("a") end }, tl("a")))
check("isCurrentTimeline: another timeline is open", not I.isCurrentTimeline({ GetCurrentTimeline = function() return tl("b") end }, tl("a")))
check("isCurrentTimeline: no current timeline", not I.isCurrentTimeline({ GetCurrentTimeline = function() return nil end }, tl("a")))

-- timeline settings: SetSettings first, then per key
local calls = {}
local tS = { SetSettings = function(self, t) calls.all = t return true end }
check("applyTimelineSettings: one SetSettings call carries everything",
	#I.applyTimelineSettings(tS, { { "timelineFrameRate", "30" } }) == 0 and calls.all.useCustomSettings == "1" and calls.all.timelineFrameRate == "30")
local per = {}
local tK = { SetSettings = function() return false end, SetSetting = function(self, k, v) per[k] = v return k ~= "timelineFrameRate" end }
local bad2 = I.applyTimelineSettings(tK, { { "timelineResolutionWidth", "1080" }, { "timelineFrameRate", "30" } })
check("applyTimelineSettings: falls back per key and names failures", per.useCustomSettings == "1" and per.timelineResolutionWidth == "1080" and #bad2 == 1 and bad2[1] == "timelineFrameRate")

-- bounded AddTrack
local nTracks, adds = 1, 0
local tT = { GetTrackCount = function() return nTracks end, AddTrack = function() adds = adds + 1 nTracks = nTracks + 1 return true end }
check("ensureTracks: adds up to the need", I.ensureTracks(tT, "video", 4) == true and nTracks == 4 and adds == 3)
local tN = { GetTrackCount = function() return 1 end, AddTrack = function() return true end }
local okN, mN = I.ensureTracks(tN, "audio", 3, "stereo")
check("ensureTracks: gives up instead of looping forever", okN == false and mN ~= nil)

-- summary
local s = I.formatSummary({ name = "Lesson 1", placed = { V1 = 1, V2 = 2, A1 = 1 }, effects = 2, effectsWanted = 3,
	failures = { { clip = "V3 'cam1' @0", reason = "AddEffect failed" } } })
check("formatSummary: counts per track, effects, failure by clip",
	s:find("A1: 1, V1: 1, V2: 2", 1, true) and s:find("2 of 3", 1, true) and s:find("V3 'cam1' @0: AddEffect failed", 1, true), s)
check("formatSummary: no problems line",
	I.formatSummary({ name = "n", placed = {}, effects = 0, effectsWanted = 0, failures = {} }):find("No problems.", 1, true) ~= nil)

-- addSourceTools: the effect comp has its own MediaIn, so the script adds the Source tools itself
do
	local added = {}
	local compA = { AddTool = function(self, id, x, yy) local t = stubTool("n_" .. id, id); added[#added + 1] = id; return t end }
	local mi, ld, err = I.addSourceTools(compA, true)
	check("addSourceTools: adds a MediaIn and a Loader", mi ~= nil and ld ~= nil and err == nil and added[1] == "MediaIn" and added[2] == "Loader")
	local mi2, ld2b = I.addSourceTools({ AddTool = function(self, id) return stubTool("m", id) end }, false)
	check("addSourceTools: no atlas adds no Loader", mi2 ~= nil and ld2b == nil)
	local _, _, e2 = I.addSourceTools({ AddTool = function() error("nope") end }, false)
	check("addSourceTools: a refused tool is reported", e2 ~= nil and e2:find("MediaIn", 1, true) ~= nil, tostring(e2))
	local _, l3, e3 = I.addSourceTools({ AddTool = function(self, id) if id == "Loader" then return nil end return stubTool("m", id) end }, true)
	check("addSourceTools: a missing Loader is reported", l3 == nil and e3 ~= nil and e3:find("Loader", 1, true) ~= nil, tostring(e3))
end

print(string.format("%d checks, %d failures", count, failures))
os.exit(failures == 0 and 0 or 1)

