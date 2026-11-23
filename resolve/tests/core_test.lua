-- Tests for FilmaretoCore (pure Lua inside resolve/FilmaretoScreen.fuse).
-- Run: bash scripts/test-resolve-lua.sh  (fuscript -l lua, no Resolve connection).

local root = os.getenv("FILMARETO_ROOT") or "."

-- Stubs for the Fusion globals the .fuse touches at load time.
-- Under fuscript the script's own globals are not the real ones that dofile'd chunks see: use _G.
_G.CT_Tool = "CT_Tool"
_G.FuRegisterClass = function() end
dofile(root .. "/resolve/FilmaretoScreen.fuse")
local C = _G.FilmaretoCore

local failures, count = 0, 0
local function near(a, b, eps) return math.abs(a - b) <= (eps or 1e-6) end
local function check(name, cond, extra)
	count = count + 1
	if not cond then
		failures = failures + 1
		print("FAIL: " .. name .. (extra and (" -> " .. tostring(extra)) or ""))
	else
		print("ok:   " .. name)
	end
end
local function nearTable(a, b, eps)
	if #a ~= #b then return false end
	for i = 1, #b do if not near(a[i], b[i], eps) then return false end end
	return true
end
local function fmt(t) local o = {} for i, v in ipairs(t) do o[i] = string.format("%.5f", v) end return "{" .. table.concat(o, ", ") .. "}" end

-- Data builder. windowFn(frame) -> {u0,v0,u1,v1}; cursorFn(frame, window, box) -> {x,y,size,alpha,kind}.
local REST = { 0.1, 0.1, 0.8, 0.8 }
local CROP = { 0, 0, 1, 1 }
local function makeData(n, windowFn, cursorFn, frame0)
	local s = {}
	for f = 0, n - 1 do
		local w = windowFn(f)
		local box = C.remapBox(REST, w, CROP)
		local cur = cursorFn and cursorFn(f, w, box) or { 0, 0, 0, 0, 0 }
		for _, v in ipairs({ box[1], box[2], box[3], box[4], REST[1], REST[2], REST[3], REST[4],
			CROP[1], CROP[2], CROP[3], CROP[4], 0.02, 0.9, cur[1], cur[2], cur[3], cur[4], cur[5] }) do
			s[#s + 1] = v
		end
	end
	return {
		format = 1, role = "screen", fps = 30, frame0 = frame0 or 0, n = n, stride = 19, s = s,
		shadow = { opacity = 0.27, spread = 0.037, offsetY = 0.015 }, canvas = { w = 1080, h = 1920 },
		mirror = false,
		cursor = { atlas = "cursors.png", kinds = { { name = "arrow", rect = { 0, 0, 32, 32 }, hotspot = { 0.125, 0.125 } } } },
	}
end
local function cursorMid(f, w, b) return { b[1] + b[3] * 0.5, b[2] + b[4] * 0.5, 0.03, 1, 1 } end

-- 1. remapBox / windowOf against the Rust numbers
local box = C.remapBox(REST, { 0.25, 0.25, 0.75, 0.75 }, CROP)
check("remapBox matches Rust", nearTable(box, { -0.3, -0.3, 1.6, 1.6 }), fmt(box))
local win = C.windowOf(box, REST, CROP)
check("windowOf inverts remapBox", nearTable(win, { 0.25, 0.25, 0.75, 0.75 }), fmt(win))
local crop2 = { 0.1, 0.2, 0.9, 0.8 }
local w2 = { 0.3, 0.3, 0.6, 0.6 }
local b2 = C.remapBox(REST, w2, crop2)
check("windowOf inverts remapBox with a crop", nearTable(C.windowOf(b2, REST, crop2), w2, 1e-9), fmt(C.windowOf(b2, REST, crop2)))
local wc = C.windowOf({ 0.5, 0.5, 1.6, 1.6 }, REST, CROP)
check("windowOf result stays in 0..1", wc[1] >= 0 and wc[2] >= 0 and wc[3] <= 1 and wc[4] <= 1, fmt(wc))

-- 2. time mapping
check("frameFromTime: clip starting at source frame 1198 (GlobalStart -1198)", C.frameFromTime(1200, -1198) == 2398)
check("frameFromTime: GlobalStart 0", C.frameFromTime(15, 0) == 15)
check("frameFromTime: req.Time - GlobalStart", C.frameFromTime(10, 5) == 5)

-- 3. sampleAt: clamped to the ends, honours frame0
local data = makeData(10, function(f) local o = 0.02 * f return { 0.1 + o, 0.2, 0.6 + o, 0.7 } end, cursorMid, 100)
check("sampleAt clamps below frame0", near(C.sampleAt(data, 50).box[1], data.s[1]))
check("sampleAt clamps past the end", near(C.sampleAt(data, 500).box[1], data.s[9 * 19 + 1]))
check("sampleAt reads the right frame", near(C.sampleAt(data, 103).box[1], data.s[3 * 19 + 1]))
check("sampleAt(nil) is nil", C.sampleAt(nil, 0) == nil)
check("sampleAt exposes cursor kind", C.sampleAt(data, 103).cursor.kind == 1)

-- 4. framing modes
local zoomData = makeData(30, function(f) return { 0.25, 0.25, 0.75, 0.75 } end, cursorMid)
local smp = C.sampleAt(zoomData, 5)
local fa = C.framing(zoomData, 5, { mode = 0, zoomStrength = 1 })
check("Auto at strength 1 returns the sample unchanged", nearTable(fa.box, smp.box, 1e-9) and nearTable(fa.cut, smp.crop, 1e-9), fmt(fa.box))
local f0 = C.framing(zoomData, 5, { mode = 0, zoomStrength = 0 })
check("Strength 0 returns the rest box", nearTable(f0.box, REST, 1e-9), fmt(f0.box))
check("Strength 0 returns the rest cut", nearTable(f0.cut, CROP, 1e-9), fmt(f0.cut))
local fh = C.framing(zoomData, 5, { mode = 1 })
check("Whole screen returns rest", nearTable(fh.box, REST, 1e-9) and nearTable(fh.cut, CROP, 1e-9), fmt(fh.box))
local fm = C.framing(zoomData, 5, { mode = 2, manualZoom = 1, manualCenter = { x = 0.5, y = 0.5 } })
check("Manual at zoom 1 returns rest", nearTable(fm.box, REST, 1e-9), fmt(fm.box))
local fm2 = C.framing(zoomData, 5, { mode = 2, manualZoom = 2, manualCenter = { x = 0.5, y = 0.5 } })
check("Manual zoom 2 centred = window 0.25..0.75", nearTable(fm2.box, { -0.3, -0.3, 1.6, 1.6 }, 1e-9), fmt(fm2.box))
check("Strength 2 zooms more than 1", C.framing(zoomData, 5, { zoomStrength = 2 }).box[3] > fa.box[3])
check("Auto framing has no warning", fa.warn == nil)

local top = C.framing(zoomData, 5, { mode = 2, manualZoom = 2, manualCenter = { x = 0.5, y = 0.8 } })
local topWin = C.windowOf(top.box, REST, CROP)
check("Manual centre y is Fusion y-up (top of screen = small v)", topWin[2] < 0.25, fmt(topWin))

-- 5. Manual transition from Auto
local startF = 3
local autoStart = C.framing(zoomData, startF, { mode = 0 })
local manualEnd = C.framing(zoomData, startF, { mode = 2, manualZoom = 1, manualCenter = { x = 0.5, y = 0.5 }, transitionSec = 0 })
local half = C.framing(zoomData, startF + 15, { mode = 2, manualZoom = 1, manualCenter = { x = 0.5, y = 0.5 },
	transitionSec = 1, clipStartFrame = startF })
local wa, wm, wh = C.windowOf(autoStart.box, REST, CROP), C.windowOf(manualEnd.box, REST, CROP), C.windowOf(half.box, REST, CROP)
local mid = {}
for i = 1, 4 do mid[i] = (wa[i] + wm[i]) / 2 end
check("Manual with transition 1 s at 0.5 s is halfway between Auto and Manual", nearTable(wh, mid, 1e-9), fmt(wh) .. " vs " .. fmt(mid))
local atStart = C.framing(zoomData, startF, { mode = 2, manualZoom = 1, transitionSec = 1, clipStartFrame = startF })
check("Transition starts exactly at Auto", nearTable(atStart.box, autoStart.box, 1e-9))
local after = C.framing(zoomData, startF + 30, { mode = 2, manualZoom = 1, transitionSec = 1, clipStartFrame = startF })
check("Transition has ended after its length", nearTable(after.box, REST, 1e-9))

-- 6. Safe zone
local panData = makeData(10, function(f) return { 0.2, 0.2, 0.7, 0.7 } end,
	function(f, w, b) return { b[1] + b[3] * 0.18, b[2] + b[4] * 0.5, 0.03, 1, 1 } end)
local before = C.framing(panData, 2, { mode = 0 })
local safe = C.framing(panData, 2, { mode = 0, safe = { top = 0, bottom = 0, right = 0, left = 20 } })
check("Safe zone: cursor starts outside the zone", before.cursor.x < 0.2, before.cursor.x)
check("Safe zone moves the cut so the cursor sits inside the zone", safe.cursor.x >= 0.2 - 1e-6 and safe.cursor.x <= 0.4, safe.cursor.x)
check("Safe zone moved the window left", C.windowOf(safe.box, REST, CROP)[1] < C.windowOf(before.box, REST, CROP)[1])
local safeR = C.framing(panData, 2, { mode = 0, safe = { top = 0, bottom = 0, right = 90, left = 0 } })
check("Safe zone right inset pulls the cursor in", safeR.cursor.x <= 0.1 + 1e-6, safeR.cursor.x)
local safeT = C.framing(panData, 2, { mode = 0, safe = { top = 60, bottom = 0, right = 0, left = 0 } })
check("Safe zone top inset pushes the cursor down", safeT.cursor.y >= 0.6 - 1e-6, safeT.cursor.y)

-- 7. Smoothing
local moving = makeData(60, function(f) local o = f < 30 and 0 or 0.2 return { 0.1 + o, 0.1, 0.6 + o, 0.6 } end)
local plain = C.smoothedAt(moving, 31, 0)
local raw = C.windowOf(C.sampleAt(moving, 31).box, REST, CROP)
check("Smoothing 0 is the identity", nearTable(plain, raw, 1e-9), fmt(plain))
local fs0 = C.framing(moving, 31, { smoothing = 0 })
check("Smoothing 0 framing equals the sample", nearTable(fs0.box, C.sampleAt(moving, 31).box, 1e-9))
local sm = C.smoothedAt(moving, 31, 0.5)
check("Smoothing is centred: it leans into a jump before it, not after", sm[1] > 0.1 and sm[1] < 0.3, fmt(sm))
local smBefore = C.smoothedAt(moving, 28, 0.2)
check("Smoothing sees the jump coming (frame 28 already moved)", smBefore[1] > 0.1 + 1e-4, fmt(smBefore))
local smLate = C.smoothedAt(moving, 59, 0.2)
check("Smoothing catches up later", math.abs(smLate[1] - 0.3) < 0.01, fmt(smLate))
local smStart = C.smoothedAt(moving, 0, 1.5)
check("Smoothing of constant data (zoomData) is the constant", nearTable(C.smoothedAt(zoomData, 3, 1.5), { 0.25, 0.25, 0.75, 0.75 }, 1e-9))

-- 8. Offset: shifts the drawn box in output space, at any zoom
local offF = C.framing(zoomData, 5, { mode = 0, offset = { x = 0.5, y = 0.5 } })
check("Offset 0.5,0.5 changes nothing", nearTable(offF.box, smp.box, 1e-9))
local offR = C.framing(zoomData, 5, { mode = 0, offset = { x = 0.6, y = 0.5 } })
check("Offset x shifts the box right by 0.1", near(offR.box[1], fa.box[1] + 0.1, 1e-9), offR.box[1])
local offU = C.framing(zoomData, 5, { mode = 0, offset = { x = 0.5, y = 0.6 } })
check("Offset y (Fusion up) shifts the box up by 0.1", near(offU.box[2], fa.box[2] - 0.1, 1e-9), offU.box[2])
local offWhole = C.framing(zoomData, 5, { mode = 1, offset = { x = 0.7, y = 0.5 } })
check("Offset works at zoom 1 (Whole screen)", near(offWhole.box[1], REST[1] + 0.2, 1e-9), offWhole.box[1])
check("Cursor moves with the offset", near(offR.cursor.x, fa.cursor.x + 0.1, 1e-9))

-- 9. Cursor
check("Cursor on: kind and alpha come through", fa.cursor.kind == 1 and fa.cursor.alpha == 1)
check("Cursor stays glued to the content", near(fa.cursor.x, fa.box[1] + fa.box[3] * 0.5, 1e-9), fa.cursor.x)
check("Cursor size is scaled", near(C.framing(zoomData, 5, { cursorScale = 2 }).cursor.size, 0.06, 1e-9))
check("Cursor off: nothing drawn", C.framing(zoomData, 5, { cursorOn = false }).cursor.kind == 0)
local manC = C.framing(zoomData, 5, { mode = 2, manualZoom = 2, manualCenter = { x = 0.5, y = 0.5 } })
check("Cursor follows Manual zoom", near(manC.cursor.x, manC.box[1] + manC.box[3] * 0.5, 1e-9))
check("Shadow settings pass through", near(fa.shadow.opacity, 0.27))

-- 10. Missing or broken data
local miss = C.framing(nil, 5, {})
check("Missing data returns rest with a warning", miss.warn ~= nil and nearTable(miss.box, { 0, 0, 1, 1 }))
check("Broken data (wrong stride) returns rest with a warning", C.framing({ format = 1, stride = 5, n = 1, s = {} }, 5, {}).warn ~= nil)
check("Short sample table is invalid", not C.valid({ format = 1, stride = 19, n = 3, s = { 1, 2, 3 } }))
check("Valid data is valid", C.valid(zoomData))

-- 11. Loading: cached per path, never errors, warns once
local calls, warnings = 0, {}
C._dofile = function(path)
	calls = calls + 1
	if path == "/ok.lua" then return zoomData end
	if path == "/bad.lua" then error("syntax error near x") end
	return 42
end
C._warn = function(m) warnings[#warnings + 1] = m end
local clock = 100
C._now = function() return clock end
C.clearCache()
check("loadData returns the table", C.loadData("/ok.lua") == zoomData)
C.loadData("/ok.lua")
check("loadData caches per path", calls == 1)
local d, err = C.loadData("/bad.lua")
check("loadData: a broken file gives nil, no error", d == nil and err ~= nil)
C.loadData("/bad.lua")
check("loadData: a broken file is tried once and warned once with its path",
	calls == 2 and #warnings == 1 and warnings[1]:find("/bad.lua", 1, true) ~= nil, warnings[1])
check("loadData: not-a-table result is rejected", C.loadData("/other.lua") == nil)
check("loadData: empty path gives nil", C.loadData("") == nil and C.loadData(nil) == nil)

-- 11b. Retry and reload
local tries = 0
C._dofile = function(path) tries = tries + 1; if tries < 3 then error("not yet") end return zoomData end
C.clearCache()
clock = 100
check("failed path: first call fails", C.loadData("/late.lua") == nil)
clock = 101
C.loadData("/late.lua")
check("failed path is not retried within 2 s", tries == 1)
clock = 102
C.loadData("/late.lua")
clock = 104
check("failed path is retried after 2 s and succeeds", C.loadData("/late.lua") == zoomData and tries == 3)

C._dofile = _G.dofile
C.clearCache()
local tmp = os.tmpname()
local function writeData(n)
	local f = io.open(tmp, "w")
	local parts = {}
	for i = 1, n * 19 do parts[i] = "0.5" end
	f:write("return { format = 1, role = 'screen', fps = 30, frame0 = 0, n = " .. n .. ", stride = 19, s = { " .. table.concat(parts, ",") .. " } }")
	f:close()
end
writeData(2)
clock = 200
local d1 = C.loadData(tmp)
check("real file loads", d1 ~= nil and d1.n == 2)
writeData(3)
clock = 201
check("good entry is not re-checked within 2 s", C.loadData(tmp).n == 2)
clock = 203
check("file rewritten in place (new size) is reloaded after 2 s", C.loadData(tmp).n == 3)
os.remove(tmp)
clock = 206
local gone = C.loadData(tmp)
check("file removed later: the effect gives no data (red border)", gone == nil)

-- 11c. Glue helpers in the core
local fr = C.framing(zoomData, 5, {})
local k0 = C.toKernel(fr, false)
check("toKernel flips y once", near(k0.box[2], 1 - (fr.box[2] + fr.box[4]), 1e-12) and near(k0.cut[2], 1 - fr.cut[4], 1e-12) and near(k0.cut[4], 1 - fr.cut[2], 1e-12) and near(k0.cursorY, 1 - fr.cursor.y, 1e-12))
local cutFixture = { box = { 0, 0, 1, 1 }, cut = { 0.1, 0.2, 0.9, 0.8 }, cursor = { y = 0 } }
local km = C.toKernel(cutFixture, true)
check("mirror swaps u0/u1 after the flip", near(km.cut[1], 0.9) and near(km.cut[3], 0.1) and near(km.cut[2], 0.2) and near(km.cut[4], 0.8), fmt(km.cut))
local kn = C.toKernel(cutFixture, false)
check("no mirror keeps u0 < u1", near(kn.cut[1], 0.1) and near(kn.cut[3], 0.9))

local uv = C.cursorUV({ name = "arrow", rect = { 64, 32, 32, 32 }, hotspot = { 0.25, 0.1 } }, 256, 128)
check("cursorUV: hotspot is a fraction, y flipped", near(uv.hot[1], 0.25) and near(uv.hot[2], 0.9), fmt(uv.hot))
check("cursorUV: rect is inset half a texel, y up",
	nearTable(uv.rect, { 64.5 / 256, 1 - 63.5 / 128, 95.5 / 256, 1 - 32.5 / 128 }, 1e-9), fmt(uv.rect))
check("cursorUV: aspect", near(C.cursorUV({ rect = { 0, 0, 48, 24 }, hotspot = { 0, 0 } }, 100, 100).aspect, 2))

-- Manual transition start is in media frames: RenderStart in comp time, GlobalStart -1198
check("clipStartFrame = frameFromTime(RenderStart, GlobalStart)", C.frameFromTime(0, -1198) == 1198 and C.frameFromTime(30, -1198) == 1228)

-- Identity with a box that does not round-trip through remapBox
local oddData = makeData(5, function(f) return { 0, 0, 1, 1 } end, cursorMid)
local oddBox = { -0.2, -0.1, 1.3, 1.1 }
for i = 1, 4 do oddData.s[i] = oddBox[i] end
local oddF = C.framing(oddData, 0, { mode = 0 })
check("Auto identity returns the stored box even when it is not remapBox-shaped", nearTable(oddF.box, oddBox, 1e-12), fmt(oddF.box))

-- Zoom strength keeps the zoom's fixed point
local offCentre = makeData(5, function(f) return { 0.5, 0.5, 0.7, 0.7 } end, cursorMid)
for k = 1, 3 do
	local kk = ({ 1.5, 1.75, 2 })[k]
	local fz = C.framing(offCentre, 0, { zoomStrength = kk })
	local wz = C.windowOf(fz.box, REST, CROP)
	check("strength " .. kk .. ": the original window centre (0.6,0.6) stays inside the window",
		wz[1] <= 0.6 and wz[3] >= 0.6 and wz[2] <= 0.6 and wz[4] >= 0.6, fmt(wz))
end
local fz2 = C.framing(offCentre, 0, { zoomStrength = 2 })
check("strength 2 shrinks the window", (C.windowOf(fz2.box, REST, CROP)[3] - C.windowOf(fz2.box, REST, CROP)[1]) < 0.2 - 1e-9)

-- Data without a Source picture becomes the warning path, and is logged once
do
	local logged = {}
	local oldWarn = C._warn
	C._warn = function(m) logged[#logged + 1] = m end
	C.clearCache()
	local d = makeData(3, function() return { 0, 0, 1, 1 } end, cursorMid)
	check("dataWithSource keeps the data when there is a source", C.dataWithSource(d, {}) == d)
	check("dataWithSource: nothing logged yet", #logged == 0)
	check("dataWithSource drops the data when there is no source", C.dataWithSource(d, nil) == nil)
	C.dataWithSource(d, nil)
	check("dataWithSource logs once", #logged == 1, #logged)
	check("dataWithSource passes missing data through", C.dataWithSource(nil, nil) == nil)
	C._warn = oldWarn
end

-- 12. Performance: the smoothing loop is O(window)
local big = makeData(20000, function(f) local o = 0.0001 * (f % 1000) return { o, 0.1, 0.6 + o, 0.6 } end)
local t0 = os.clock()
for i = 1, 300 do C.framing(big, 10000 + i, { smoothing = 1.5, safe = { left = 5, top = 0, bottom = 0, right = 5 } }) end
local ms = (os.clock() - t0) * 1000 / 300
print(string.format("info: framing with smoothing 1.5 s: %.3f ms/frame", ms))
check("Framing with max smoothing is cheap (< 5 ms/frame)", ms < 5, ms)

print(string.format("%d checks, %d failures", count, failures))
os.exit(failures == 0 and 0 or 1)
