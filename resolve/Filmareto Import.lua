-- Filmareto Import (DaVinci Resolve Studio 21.2+, Workspace > Scripts > Utility > Filmareto Import)
-- Reads the export folder the Filmareto OpenScreen app wrote (timeline.lua) and builds an open
-- timeline in the CURRENT project: media bin, tracks, clips, and the "Filmareto Screen" Fusion
-- effect on every screen and camera clip. No keyframes per frame; the effect reads the data files.
--
-- Pure parts are local functions. With the global FILMARETO_IMPORT_TEST set, this file only exposes
-- them as _G.FilmaretoImport and returns, without touching any Resolve object (see
-- resolve/tests/import_test.lua).

local EFFECT_NAME = "Filmareto Screen"
local FUSE_REGID = "Fuse.FilmaretoScreen"

-- UNVERIFIED (check first in Resolve): is AppendToTimeline's endFrame inclusive or exclusive?
-- The manifest's `finish` is EXCLUSIVE (start + frames). If Resolve treats endFrame as inclusive,
-- the offset is -1; if it is exclusive, set this to 0. Everything else derives from this one value.
local FINISH_TO_END_FRAME = -1

local LAST_EXPORT_REL = "/Library/Application Support/Blackmagic Design/DaVinci Resolve/Fusion/Filmareto/last-export.lua" -- not under Scripts/, so it stays out of the Scripts menu

---------------------------------------------------------------------------------------------------
-- Pure helpers
---------------------------------------------------------------------------------------------------

-- Runs a Lua chunk file and returns its table result. `loader` defaults to dofile (tests inject one).
local function loadTable(path, loader)
	if type(path) ~= "string" or path == "" then return nil, "no path" end
	local ok, res = pcall(loader or dofile, path)
	if not ok then return nil, tostring(res) end
	if type(res) ~= "table" then return nil, "the file did not return a table: " .. path end
	return res
end

-- Returns the manifest table, or nil and a message. Checks only what the import needs.
local function validateManifest(m)
	if type(m) ~= "table" then return nil, "timeline.lua did not return a table" end
	if m.format ~= 1 then return nil, "unsupported timeline.lua format: " .. tostring(m.format) end
	for _, f in ipairs({ "width", "height", "fps" }) do
		if type(m[f]) ~= "number" or m[f] <= 0 then return nil, "timeline.lua has no valid " .. f end
	end
	if type(m.name) ~= "string" or m.name == "" then return nil, "timeline.lua has no name" end
	if type(m.media) ~= "table" or type(m.clips) ~= "table" then return nil, "timeline.lua has no media or clips" end
	local keys = {}
	for i, med in ipairs(m.media) do
		if type(med.key) ~= "string" or type(med.path) ~= "string" then
			return nil, "media entry " .. i .. " has no key or path"
		end
		keys[med.key] = true
	end
	for i, c in ipairs(m.clips) do
		if c.track ~= "video" and c.track ~= "audio" then return nil, "clip " .. i .. " has an unknown track" end
		for _, f in ipairs({ "index", "start", "finish", "record" }) do
			if type(c[f]) ~= "number" then return nil, "clip " .. i .. " has no " .. f end
		end
		if not keys[c.media] then return nil, "clip " .. i .. " uses unknown media '" .. tostring(c.media) .. "'" end
		if c.effect ~= nil and type(c.effect) ~= "table" then return nil, "clip " .. i .. " has a bad effect" end
	end
	return m
end

local function isAbsolutePath(p)
	return p:sub(1, 1) == "/" or p:sub(1, 1) == "\\" or p:match("^%a:[/\\]") ~= nil
end

-- The export writes the paths in timeline.lua relative to its folder (the folder can be moved or
-- renamed); an absolute path is kept as it is.
local function resolvePath(folder, p)
	if type(p) ~= "string" or p == "" or isAbsolutePath(p) then return p end
	return (folder:gsub("[/\\]+$", "")) .. "/" .. p
end

-- Makes every path of the manifest absolute against `folder`, in place: the media paths and each
-- effect's data file and atlas.
local function absolutizeManifest(m, folder)
	for _, med in ipairs(m.media) do med.path = resolvePath(folder, med.path) end
	for _, c in ipairs(m.clips) do
		if c.effect then
			c.effect.data = resolvePath(folder, c.effect.data)
			if c.effect.atlas then c.effect.atlas = resolvePath(folder, c.effect.atlas) end
		end
	end
	return m
end

-- Reads <folder>/timeline.lua through last-export.lua's { folder = ... }. The returned manifest has
-- absolute paths.
local function readManifestFromLastExport(lastExportPath, loader)
	local last, err = loadTable(lastExportPath, loader)
	if not last then return nil, "Could not read the last export pointer (" .. tostring(lastExportPath) .. "): " .. tostring(err) end
	if type(last.folder) ~= "string" or last.folder == "" then
		return nil, "last-export.lua has no folder"
	end
	local m, err2 = loadTable(last.folder .. "/timeline.lua", loader)
	if not m then return nil, "Could not read timeline.lua in " .. last.folder .. ": " .. tostring(err2) end
	local ok, err3 = validateManifest(m)
	if not ok then return nil, err3 end
	absolutizeManifest(m, last.folder)
	return m, nil, last.folder
end

-- "Name", then "Name 2", "Name 3"... `exists(name)` says whether a name is taken.
local function uniqueName(base, exists)
	if not exists(base) then return base end
	local n = 2
	while exists(base .. " " .. n) do n = n + 1 end
	return base .. " " .. n
end

local function lastPathComponent(p)
	return (tostring(p):match("([^/]+)$")) or tostring(p)
end

-- Maps imported items back to manifest media keys. `pathOf(item)` returns the item's File Path.
-- One path may carry several keys (e.g. voice pieces that fall back to the screen file): the item is
-- assigned to ALL of them. Exact path first, then (when unique among the manifest paths) by file name.
local function mapItemsToKeys(items, media, pathOf)
	local byPath, byBase, basePaths = {}, {}, {}
	for _, m in ipairs(media) do
		byPath[m.path] = byPath[m.path] or {}
		table.insert(byPath[m.path], m.key)
		local b = lastPathComponent(m.path)
		byBase[b] = byBase[b] or {}
		table.insert(byBase[b], m.key)
		basePaths[b] = basePaths[b] or {}
		basePaths[b][m.path] = true
	end
	local result, unmatched = {}, {}
	for _, item in ipairs(items) do
		local p = pathOf(item)
		local keys = byPath[p]
		if not keys and p then
			local b = lastPathComponent(p)
			local n = 0
			for _ in pairs(basePaths[b] or {}) do n = n + 1 end
			if n == 1 then keys = byBase[b] end
		end
		if keys then
			for _, key in ipairs(keys) do result[key] = item end
		else
			unmatched[#unmatched + 1] = p or "?"
		end
	end
	return result, unmatched
end

-- Highest video / audio track index the manifest uses.
local function requiredTracks(clips)
	local v, a = 0, 0
	for _, c in ipairs(clips) do
		if c.track == "video" then if c.index > v then v = c.index end
		else if c.index > a then a = c.index end end
	end
	return v, a
end

-- The AppendToTimeline clipInfo for one manifest clip (frame maths in one place).
local function buildClipInfo(clip, mediaPoolItem, timelineStartFrame)
	return {
		mediaPoolItem = mediaPoolItem,
		startFrame = clip.start,
		endFrame = clip.finish + FINISH_TO_END_FRAME,
		trackIndex = clip.index,
		recordFrame = timelineStartFrame + clip.record,
		mediaType = (clip.track == "audio") and 2 or 1, -- 1 = video only (no screen-file audio), 2 = audio only
	}
end

-- Finds the "Filmareto Screen" entry in a GetEffectsList("video") result. Returns the info or nil.
local function findEffectInfo(list)
	if type(list) ~= "table" then return nil end
	local fallback
	for _, e in pairs(list) do
		if type(e) == "table" then
			if e.name == EFFECT_NAME and (e.category == nil or e.category == "fusion") then return e end
			if not fallback and (e.id == EFFECT_NAME) then fallback = e end
		end
	end
	return fallback
end

-- Finds { fuse=, mediaIn=, loader= } in an effect comp. The Fuse is found by TOOLS_RegID (names inside an
-- effect comp may be prefixed, so never by name). MediaIn and Loader are the ones actually connected to the
-- Fuse's Source / Atlas inputs when that can be read; otherwise the first of their RegID.
local function connectedTool(fuse, inputName)
	local ok, tool = pcall(function()
		local inp = fuse[inputName]
		local out = inp and inp:GetConnectedOutput()
		return out and out:GetTool()
	end)
	if ok and type(tool) ~= "nil" and tool then return tool end
	return nil
end

local function findTools(comp)
	local found = {}
	local list = comp:GetToolList(false)
	if type(list) ~= "table" then return found end
	local firstMediaIn, firstLoader
	for _, tool in pairs(list) do
		local okA, attrs = pcall(function() return tool:GetAttrs() end)
		local reg = okA and type(attrs) == "table" and attrs.TOOLS_RegID or nil
		if reg == FUSE_REGID then found.fuse = found.fuse or tool
		elseif reg == "MediaIn" then firstMediaIn = firstMediaIn or tool
		elseif reg == "Loader" then firstLoader = firstLoader or tool end
	end
	local function regOf(t)
		local ok, a = pcall(function() return t:GetAttrs() end)
		return ok and type(a) == "table" and a.TOOLS_RegID or nil
	end
	local cm = found.fuse and connectedTool(found.fuse, "Source")
	local cl = found.fuse and connectedTool(found.fuse, "Atlas")
	found.mediaIn = (cm and regOf(cm) == "MediaIn") and cm or firstMediaIn
	found.loader = (cl and regOf(cl) == "Loader") and cl or firstLoader
	return found
end

-- The effect comp already has a MediaIn of its own (the clip the effect sits on), so the full-resolution
-- Source and the cursor atlas get tools added by the script: a second MediaIn named like the macro's own
-- (MediaIn1) inside the template crashed Resolve 21.2 the moment the effect was added. Returns
-- mediaIn, loader (nil without an atlas), and a message when a tool could not be added.
local function addSourceTools(comp, wantLoader)
	local okM, mi = pcall(function() return comp:AddTool("MediaIn", -110, 55) end)
	if not okM or not mi then return nil, nil, "could not add the Source MediaIn: " .. tostring(mi) end
	if not wantLoader then return mi, nil end
	local okL, ld = pcall(function() return comp:AddTool("Loader", -110, 110) end)
	if not okL or not ld then return mi, nil, "could not add the cursor Loader: " .. tostring(ld) end
	return mi, ld
end

-- Sets a tool input and reads it back. Returns true, or false and a reason.
local function setInput(tool, name, value)
	local ok, err = pcall(function() tool:SetInput(name, value) end)
	if not ok then return false, tostring(err) end
	local okR, got = pcall(function() return tool:GetInput(name) end)
	if okR and got ~= nil then
		if type(value) == "number" then
			if tonumber(got) ~= value then return false, name .. " reads back " .. tostring(got) end
		elseif tostring(got) ~= tostring(value) then
			return false, name .. " reads back " .. tostring(got)
		end
	end
	return true
end

-- Applies the effect settings to the found tools. Returns a list of failure strings (empty = all ok).
-- Returns failures, warnings. A read-back mismatch on GlobalOut or the Loader Clip is only a warning
-- (Resolve may normalise those values); every other problem is a failure.
local SOFT = { GlobalOut = true, Atlas = true }
local function configureEffectTools(tools, effect, mediaId, clipStart)
	local fails, warns = {}, {}
	local function step(label, tool, fn)
		if not tool then fails[#fails + 1] = label .. ": tool not found in the effect"; return end
		local ok, a, b = pcall(fn)
		local msg
		if not ok then fails[#fails + 1] = label .. ": " .. tostring(a); return
		elseif a == false then msg = label .. ": " .. tostring(b) end
		if msg then
			if SOFT[label] and tostring(b):find("reads back", 1, true) then warns[#warns + 1] = msg
			else fails[#fails + 1] = msg end
		end
	end
	step("DataFile", tools.fuse, function() return setInput(tools.fuse, "DataFile", effect.data) end)
	step("FetchByFrame", tools.fuse, function() return setInput(tools.fuse, "FetchByFrame", 1) end)
	-- The effect's own time is the clip's (0 at its first frame): the Fuse adds the clip's source start to it.
	if type(clipStart) == "number" and clipStart >= 0 then
		step("ClipStartFrame", tools.fuse, function() return setInput(tools.fuse, "ClipStartFrame", clipStart) end)
	end
	step("MediaSource", tools.mediaIn, function() return setInput(tools.mediaIn, "MediaSource", "MediaPool") end)
	if mediaId == nil or mediaId == "" then
		fails[#fails + 1] = "MediaID: the media pool item has no id"
	else
		step("MediaID", tools.mediaIn, function() return setInput(tools.mediaIn, "MediaID", mediaId) end)
	end
	step("GlobalIn", tools.mediaIn, function() return setInput(tools.mediaIn, "GlobalIn", 0) end)
	step("ClipTimeStart", tools.mediaIn, function() return setInput(tools.mediaIn, "ClipTimeStart", 0) end)
	step("GlobalOut", tools.mediaIn, function() return setInput(tools.mediaIn, "GlobalOut", 1000000) end)
	if effect.atlas and effect.atlas ~= "" then
		step("Atlas", tools.loader, function() return setInput(tools.loader, "Clip", effect.atlas) end)
	end
	-- Connect LAST. The template ships the Fuse's Source and Atlas unconnected: a MediaIn with no MediaID
	-- crashed Resolve (SIGBUS in the Fusion render thread) the moment the effect was added. With Source
	-- unconnected the Fuse just passes the clip through, so nothing renders until the chain is complete.
	if #fails == 0 then
		local function connect(label, input, from)
			step(label, tools.fuse, function()
				if not from then return false, "tool to connect is missing" end
				local ok = tools.fuse:ConnectInput(input, from)
				if ok == false or ok == nil then return false, input .. " did not connect" end
				return true
			end)
		end
		connect("ConnectSource", "Source", tools.mediaIn)
		if effect.atlas and effect.atlas ~= "" then connect("ConnectAtlas", "Atlas", tools.loader) end
	end
	return fails, warns
end

local function clipLabel(clip)
	local prefix = (clip.track == "video") and "V" or "A"
	return string.format("%s%d '%s' @%d", prefix, clip.index, tostring(clip.media), clip.record)
end

-- report = { name, placed = {["V2"]=n,...}, effects = n, effectsWanted = n, failures = { {clip=, reason=} } }
local function formatSummary(report)
	local L = {}
	L[#L + 1] = "Timeline: " .. tostring(report.name)
	local names = {}
	for k in pairs(report.placed) do names[#names + 1] = k end
	table.sort(names)
	local parts = {}
	for _, k in ipairs(names) do parts[#parts + 1] = k .. ": " .. report.placed[k] end
	L[#L + 1] = "Clips placed: " .. (#parts > 0 and table.concat(parts, ", ") or "none")
	L[#L + 1] = string.format("Filmareto Screen applied: %d of %d", report.effects, report.effectsWanted)
	if #report.failures == 0 then
		L[#L + 1] = "No problems."
	else
		L[#L + 1] = #report.failures .. " problem(s):"
		for _, f in ipairs(report.failures) do L[#L + 1] = "  - " .. f.clip .. ": " .. f.reason end
	end
	if report.warnings and #report.warnings > 0 then
		L[#L + 1] = #report.warnings .. " warning(s) (values read back differently, probably harmless):"
		for _, w in ipairs(report.warnings) do L[#L + 1] = "  - " .. w end
	end
	return table.concat(L, "\n")
end

-- True when the project's current timeline is `timeline` (compared by GetUniqueId). Never write into
-- the user's open timeline: callers stop when this is false.
local function isCurrentTimeline(project, timeline)
	local ok, cur = pcall(function() return project:GetCurrentTimeline() end)
	if not ok or not cur then return false end
	local ok1, a = pcall(function() return cur:GetUniqueId() end)
	local ok2, b = pcall(function() return timeline:GetUniqueId() end)
	return ok1 and ok2 and a ~= nil and a == b
end

-- Applies timeline settings { {key, value}, ... } with useCustomSettings first. Tries SetSettings({...}) first,
-- then per-key SetSetting. Returns the list of keys that did not apply.
local function applyTimelineSettings(timeline, pairsList)
	local function setOne(key, value)
		local ok, r = pcall(function() return timeline:SetSetting(key, value) end)
		return ok and r and true or false
	end
	local all = { useCustomSettings = "1" }
	for _, kv in ipairs(pairsList) do all[kv[1]] = kv[2] end
	local failed = {}
	local okAll, r = pcall(function() return timeline:SetSettings(all) end)
	if okAll and r then return failed end
	if not setOne("useCustomSettings", "1") then failed[#failed + 1] = "useCustomSettings" end
	for _, kv in ipairs(pairsList) do
		if not setOne(kv[1], kv[2]) then failed[#failed + 1] = kv[1] end
	end
	return failed
end

-- Adds tracks until `kind` has at least `need`; gives up after need+4 attempts. Returns ok, message.
local function ensureTracks(timeline, kind, need, subType)
	local tries, limit = 0, need + 4
	while (timeline:GetTrackCount(kind) or 0) < need do
		tries = tries + 1
		if tries > limit then return false, "could not add " .. kind .. " tracks up to " .. need end
		local ok, r = pcall(function() return timeline:AddTrack(kind, subType) end)
		if not (ok and r) then return false, "AddTrack(" .. kind .. ") failed" end
	end
	return true
end

local pure = {
	isCurrentTimeline = isCurrentTimeline,
	applyTimelineSettings = applyTimelineSettings,
	ensureTracks = ensureTracks,
	loadTable = loadTable,
	resolvePath = resolvePath,
	absolutizeManifest = absolutizeManifest,
	validateManifest = validateManifest,
	readManifestFromLastExport = readManifestFromLastExport,
	uniqueName = uniqueName,
	mapItemsToKeys = mapItemsToKeys,
	requiredTracks = requiredTracks,
	buildClipInfo = buildClipInfo,
	findEffectInfo = findEffectInfo,
	findTools = findTools,
	addSourceTools = addSourceTools,
	setInput = setInput,
	configureEffectTools = configureEffectTools,
	clipLabel = clipLabel,
	formatSummary = formatSummary,
	FINISH_TO_END_FRAME = FINISH_TO_END_FRAME,
	LAST_EXPORT_REL = LAST_EXPORT_REL,
}

if rawget(_G, "FILMARETO_IMPORT_TEST") then
	_G.FilmaretoImport = pure
	return
end

---------------------------------------------------------------------------------------------------
-- Resolve side (everything below touches Resolve objects)
---------------------------------------------------------------------------------------------------

local resolveRef -- set in run(), used for the Fusion fallback of the UI
local function showMessage(title, text)
	print(text)
	local okUi = pcall(function()
		local f = rawget(_G, "fu") or rawget(_G, "fusion") or (resolveRef and resolveRef:Fusion())
		local ui = f.UIManager
		local disp = bmd.UIDispatcher(ui)
		local win = disp:AddWindow({
			ID = "FilmaretoImportWin", WindowTitle = title, Geometry = { 200, 200, 560, 320 },
			ui:VGroup({
				ui:TextEdit({ ID = "Msg", Text = text, ReadOnly = true, Weight = 1 }),
				ui:Button({ ID = "OkBtn", Text = "OK", Weight = 0 }),
			}),
		})
		win.On.OkBtn.Clicked = function() disp:ExitLoop() end
		win.On.FilmaretoImportWin.Close = function() disp:ExitLoop() end
		win:Show()
		disp:RunLoop()
		win:Hide()
	end)
	if not okUi then print("(could not open the summary window; the text above is the summary)") end
end

local function run()
	local resolve = rawget(_G, "resolve") or Resolve()
	if not resolve then showMessage("Filmareto Import", "Could not reach DaVinci Resolve."); return end
	resolveRef = resolve

	-- 1. The export
	local home = os.getenv("HOME") or ""
	local manifest, err, folder = readManifestFromLastExport(home .. LAST_EXPORT_REL)
	if not manifest then
		showMessage("Filmareto Import", "Nothing to import.\n" .. tostring(err) ..
			"\n\nExport from Filmareto OpenScreen (Export για Resolve) first, then run this again.")
		return
	end

	-- 2. The effect must exist before anything changes
	local effInfo = findEffectInfo(resolve:GetEffectsList("video"))
	if not effInfo then
		showMessage("Filmareto Import",
			"Restart DaVinci Resolve once so it loads the Filmareto Screen effect, then run Filmareto Import again.")
		return
	end
	local effectId = effInfo.id or effInfo.name

	local pm = resolve:GetProjectManager()
	local project = pm and pm:GetCurrentProject()
	if not project then showMessage("Filmareto Import", "Open a project first."); return end
	local pool = project:GetMediaPool()
	local failures = {}
	local function fail(clip, reason) failures[#failures + 1] = { clip = clip, reason = reason } end

	-- 3. Bin + media
	local root = pool:GetRootFolder()
	local userFolder = pool:GetCurrentFolder()
	local taken = {}
	for _, f in ipairs(root:GetSubFolderList() or {}) do taken[f:GetName()] = true end
	local binName = uniqueName(manifest.name, function(n) return taken[n] end)
	local bin = pool:AddSubFolder(root, binName)
	if not bin then showMessage("Filmareto Import", "Could not create the media bin '" .. binName .. "'."); return end
	pool:SetCurrentFolder(bin)
	local paths = {}
	-- Plain path strings: the { FilePath = ... } form is for image sequences and imports nothing for a video file.
	for _, m in ipairs(manifest.media) do paths[#paths + 1] = m.path end
	local imported = pool:ImportMedia(paths) or {}
	local itemByKey, unmatched = mapItemsToKeys(imported, manifest.media, function(it)
		local ok, p = pcall(function() return it:GetClipProperty("File Path") end)
		return ok and p or nil
	end)
	for _, m in ipairs(manifest.media) do
		if not itemByKey[m.key] then fail("media '" .. m.key .. "'", "not imported: " .. m.path) end
	end
	for _, p in ipairs(unmatched) do fail("media", "imported item matches no manifest path: " .. tostring(p)) end

	-- 4. Timeline
	local tlTaken = {}
	for i = 1, (project:GetTimelineCount() or 0) do
		local t = project:GetTimelineByIndex(i)
		if t then tlTaken[t:GetName()] = true end
	end
	local tlName = uniqueName(manifest.name, function(n) return tlTaken[n] end)
	local timeline = pool:CreateEmptyTimeline(tlName)
	if not timeline then showMessage("Filmareto Import", "Could not create the timeline '" .. tlName .. "'."); return end
	project:SetCurrentTimeline(timeline)
	if not isCurrentTimeline(project, timeline) then
		if userFolder then pcall(function() pool:SetCurrentFolder(userFolder) end) end
		showMessage("Filmareto Import", "Could not switch to the new timeline '" .. tlName ..
			"', so nothing was placed (your open timeline was not touched). Open the timeline '" ..
			tlName .. "' and run Filmareto Import again.")
		return
	end
	local badKeys = applyTimelineSettings(timeline, {
		{ "timelineResolutionWidth", tostring(manifest.width) },
		{ "timelineResolutionHeight", tostring(manifest.height) },
		{ "timelineFrameRate", tostring(manifest.fps) },
	})
	if #badKeys > 0 then
		if userFolder then pcall(function() pool:SetCurrentFolder(userFolder) end) end
		showMessage("Filmareto Import", "The timeline '" .. tlName .. "' was created, but these settings did not apply: " ..
			table.concat(badKeys, ", ") .. ". No clips were placed. Delete that timeline and try again.")
		return
	end

	local needV, needA = requiredTracks(manifest.clips)
	local okV, mV = ensureTracks(timeline, "video", needV)
	if not okV then fail("timeline", mV) end
	local okA, mA = ensureTracks(timeline, "audio", needA, "stereo")
	if not okA then fail("timeline", mA) end

	-- 5. Clips
	local startFrame = timeline:GetStartFrame() or 0
	local placed, report = {}, { name = tlName, placed = {}, effects = 0, effectsWanted = 0, failures = failures, warnings = {} }
	for i, clip in ipairs(manifest.clips) do
		local label = clipLabel(clip)
		local mpi = itemByKey[clip.media]
		if not mpi then
			fail(label, "its media was not imported")
		else
			local ok, res = pcall(function() return pool:AppendToTimeline({ buildClipInfo(clip, mpi, startFrame) }) end)
			local item = ok and type(res) == "table" and res[1] or nil
			if item then
				placed[i] = item
				local k = ((clip.track == "video") and "V" or "A") .. clip.index
				report.placed[k] = (report.placed[k] or 0) + 1
			else
				fail(label, ok and "AppendToTimeline returned no item" or tostring(res))
			end
		end
	end

	-- 6. Effects
	for i, clip in ipairs(manifest.clips) do
		local item = placed[i]
		if clip.effect and item then
			report.effectsWanted = report.effectsWanted + 1
			local label = clipLabel(clip)
			local okFx, fx = pcall(function() return item:AddEffect("fusion", effectId) end)
			if not okFx or not fx then
				fail(label, "AddEffect failed" .. (okFx and "" or (": " .. tostring(fx))))
			else
				local okC, comp = pcall(function() return fx:GetFusionComp() end)
				if not okC or not comp then
					fail(label, "effect has no Fusion comp" .. (okC and "" or (": " .. tostring(comp))))
				else
					local okT, tools = pcall(findTools, comp)
					if not okT then
						fail(label, "reading the effect tools failed: " .. tostring(tools))
					else
						local srcKey = (clip.effect.source and itemByKey[clip.effect.source]) and clip.effect.source or clip.media
						local okId, mediaId = pcall(function() return itemByKey[srcKey]:GetMediaId() end)
						pcall(function() comp:Lock() end) -- no render while the chain is half set up
						local mi, ld, addErr = addSourceTools(comp, clip.effect.atlas ~= nil and clip.effect.atlas ~= "")
						tools.mediaIn, tools.loader = mi, ld
						local okCfg, fails, warns
						if addErr then
							okCfg, fails, warns = true, { addErr }, {}
						else
							okCfg, fails, warns = pcall(configureEffectTools, tools, clip.effect, okId and mediaId or nil, clip.start)
						end
						pcall(function() comp:Unlock() end)
						if not okCfg then fails, warns = { "configuring the effect stopped: " .. tostring(fails) }, {} end
						for _, f in ipairs(fails) do fail(label, f) end
						for _, w in ipairs(warns) do report.warnings[#report.warnings + 1] = label .. ": " .. w end
						if #fails == 0 then report.effects = report.effects + 1 end
					end
				end
			end
		elseif clip.effect and not item then
			report.effectsWanted = report.effectsWanted + 1
		end
	end

	if userFolder then pcall(function() pool:SetCurrentFolder(userFolder) end) end
	showMessage("Filmareto Import", formatSummary(report))
end

local okRun, errRun = pcall(run)
if not okRun then showMessage("Filmareto Import", "The import stopped with an error:\n" .. tostring(errRun)) end
