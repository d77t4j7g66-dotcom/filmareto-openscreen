return {
  format = 1, name = "Lesson 1", width = 1080, height = 1920, fps = 30,
  media = {
    { key = "bg", path = "media/bg.png", kind = "still" },
    { key = "m1", path = "media/rec.mov", kind = "video" },
    { key = "cam1", path = "media/cam.mov", kind = "video" },
    { key = "v1", path = "media/mic.wav", kind = "audio" },
  },
  clips = {
    { track = "video", index = 1, media = "bg", start = 0, finish = 300, record = 0 },
    { track = "video", index = 2, media = "m1", start = 60, finish = 360, record = 0, effect = { data = "data/seg-001.lua", role = "screen", source = "m1", atlas = "cursors.png" } },
    { track = "video", index = 3, media = "cam1", start = 45, finish = 345, record = 0, effect = { data = "data/cam-001.lua", role = "camera", source = "cam1" } },
    { track = "audio", index = 1, media = "v1", start = 60, finish = 360, record = 0 },
    { track = "audio", index = 3, media = "v1", start = 0, finish = 30, record = 300 },
  },
}
