import AppKit
import PrompterCore

/// Draws the stage: header, lines with karaoke colouring, directions, optional cue labels, overlays.
final class ReadingView: NSView {
    var onScrolled: ((String, Bool) -> Void)?
    var onAtEnd: (() -> Void)?
    var onCountdownDone: (() -> Void)?
    var onFrameChanged: (() -> Void)?
    var topInset: CGFloat = 0 { didSet { rebuildLayout() } }
    var showsResizeGrip = false { didSet { needsDisplay = true } }
    var status: String? { didSet { needsDisplay = true } }

    private(set) var settings = PrompterSettings.default
    private var stage: PrompterStage?
    private var cursorLine = 0
    private var cursorWord = -1
    private var rows: [Row] = []
    private var offset: CGFloat = 0
    private var target: CGFloat = 0
    private var playing = false
    private var overlay: String?
    private var countdownLeft = 0
    private var animTimer: Timer?
    private var countdownTimer: Timer?
    private var scrollDebounce: Timer?
    private var atEndReported = false
    private var dragStart: NSPoint?
    private var startFrame: NSRect = .zero
    private var resizing = false
    private var pacer = VoicePacer()
    private var lastTick: TimeInterval?
    /// Where each word sits vertically in the text, for voice pacing. One array per script line.
    private var wordPositions: [[CGFloat]] = []
    /// Height of the guide line, measured at layout because measuring text is too slow for every frame.
    private var guideY: CGFloat = 0

    private struct Row {
        let lineIndex: Int?
        var top: CGFloat
        var height: CGFloat
        var text: NSAttributedString
    }

    override var isFlipped: Bool { true }
    override var isOpaque: Bool { false }
    override var mouseDownCanMoveWindow: Bool { false }

    override init(frame: NSRect) {
        super.init(frame: frame)
        animTimer = Timer.scheduledTimer(withTimeInterval: 1.0 / 60.0, repeats: true) { [weak self] _ in self?.tick() }
    }

    required init?(coder: NSCoder) { fatalError("not used") }

    // MARK: - Geometry

    private var padding: CGFloat { CGFloat(settings.paddingH) }
    private var paddingV: CGFloat { CGFloat(settings.paddingV) }
    private var fontSize: CGFloat { CGFloat(settings.fontSize) }
    private var gutter: CGFloat { (fontSize * 0.8).rounded() }
    private var spacing: CGFloat { (fontSize * 0.45).rounded() }
    private var headerHeight: CGFloat { Geometry.headerHeight(fontSize: fontSize) }
    private var viewport: NSRect {
        NSRect(x: 0, y: topInset + headerHeight + paddingV, width: bounds.width, height: max(0, bounds.height - topInset - headerHeight - 8 - paddingV * 2))
    }
    private var textWidth: CGFloat { max(50, bounds.width - padding * 2 - gutter) }
    private var readingFraction: CGFloat { settings.position == .notch ? 0 : CGFloat(settings.activeLine) }
    private var maxOffset: CGFloat { max(0, (rows.last?.top ?? 0) - viewport.height * readingFraction) }
    /// Manual scrolling keeps going until the last line has passed the reading line, so it can be read.
    private var manualEndOffset: CGFloat {
        guard let last = rows.last else { return 0 }
        return max(maxOffset, last.top + last.height + spacing - viewport.height * readingFraction)
    }
    private var singleLineHeight: CGFloat { measure(NSAttributedString(string: "Α", attributes: textAttributes(bold: false))) }
    private var isPacing: Bool { settings.mode == .voice && playing && overlay == nil && countdownLeft <= 0 }
    private var isUserScrolling: Bool { scrollDebounce != nil }
    private var gripRect: NSRect { NSRect(x: bounds.maxX - 18, y: bounds.maxY - 18, width: 16, height: 16) }
    private var allowsDragging: Bool { settings.position != .notch && settings.position != .fullscreen }

    // MARK: - API

    func load(stage: PrompterStage, startLineId: String, settings: PrompterSettings) {
        self.stage = stage
        self.settings = settings
        overlay = nil
        countdownLeft = 0
        countdownTimer?.invalidate()
        scrollDebounce?.invalidate()
        scrollDebounce = nil
        playing = false
        atEndReported = false
        cursorLine = stage.lines.firstIndex(where: { $0.id == startLineId }) ?? 0
        cursorWord = -1
        pacer = VoicePacer()
        rebuildLayout()
        target = targetFor(line: cursorLine)
        offset = target
        needsDisplay = true
    }

    func apply(settings: PrompterSettings) {
        self.settings = settings
        rebuildLayout()
        target = targetFor(line: cursorLine)
        replacePacer(offset: isPacing ? target : offset)
        if isPacing { offset = target }
        needsDisplay = true
    }

    func setCursor(lineId: String, wordIndex: Int) {
        guard let stage, let i = stage.lines.firstIndex(where: { $0.id == lineId }) else { return }
        cursorLine = i
        cursorWord = wordIndex
        overlay = nil
        atEndReported = false
        restyle()
        needsDisplay = true
        if isPacing {
            if isUserScrolling { return }
            let position = pacingPosition(line: i, word: wordIndex)
            if wordIndex >= 0 { pacer.heard(position: position) } else { pacer.jump(to: position) }
            return
        }
        target = targetFor(line: i)
    }

    func setPlaying(_ value: Bool) {
        // Pausing during a jump must still arrive at the jump's target.
        if isPacing { target = pacer.restingOffset }
        playing = value
        if value { atEndReported = false }
        replacePacer(offset: offset)
        if value && abs(target - offset) > 0.5 { pacer.snap(to: target) }
    }

    func showOverlay(_ text: String) {
        overlay = text
        playing = false
        needsDisplay = true
    }

    func startCountdown(_ seconds: Int) {
        countdownTimer?.invalidate()
        countdownLeft = seconds
        overlay = nil
        needsDisplay = true
        countdownTimer = Timer.scheduledTimer(withTimeInterval: 1, repeats: true) { [weak self] timer in
            guard let self else { return }
            self.countdownLeft -= 1
            self.needsDisplay = true
            if self.countdownLeft <= 0 {
                timer.invalidate()
                self.onCountdownDone?()
            }
        }
    }

    // MARK: - Layout and text

    private func textAttributes(bold: Bool) -> [NSAttributedString.Key: Any] {
        let style = NSMutableParagraphStyle()
        style.lineHeightMultiple = CGFloat(settings.lineSpacing)
        return [.font: baseFont(bold: bold), .paragraphStyle: style]
    }

    private func baseFont(bold: Bool) -> NSFont { NSFont.systemFont(ofSize: fontSize, weight: bold ? .bold : .medium) }

    private func smallItalic() -> NSFont {
        NSFontManager.shared.convert(NSFont.systemFont(ofSize: (fontSize * 0.6).rounded()), toHaveTrait: .italicFontMask)
    }

    private func appendNotes(_ out: NSMutableAttributedString, directions: [String], cues: [String]) {
        let gray = NSColor(white: 0.7, alpha: 1)
        for d in directions {
            out.append(NSAttributedString(string: "\n(\(d))", attributes: [.font: smallItalic(), .foregroundColor: gray]))
        }
        if settings.showCues, !cues.isEmpty {
            let label = cues.map { "[\($0)]" }.joined(separator: "  ")
            out.append(NSAttributedString(string: "\n" + label, attributes: [.font: NSFont.systemFont(ofSize: (fontSize * 0.5).rounded()), .foregroundColor: NSColor(white: 0.55, alpha: 1)]))
        }
    }

    private func lineText(_ stage: PrompterStage, _ i: Int) -> NSAttributedString {
        let line = stage.lines[i]
        let out = NSMutableAttributedString()
        for (w, word) in line.words.enumerated() {
            let state = ReadingModel.state(lineIndex: i, wordIndex: w, cursorLine: cursorLine, cursorWord: cursorWord)
            let color = NSColor.white.withAlphaComponent(ReadingModel.alpha(state))
            var attributes = textAttributes(bold: word.bold)
            attributes[.foregroundColor] = color
            out.append(NSAttributedString(string: (w == 0 ? "" : " ") + word.text, attributes: attributes))
        }
        appendNotes(out, directions: line.directions, cues: line.cues)
        return out
    }

    private func introText(_ stage: PrompterStage) -> NSAttributedString {
        let out = NSMutableAttributedString()
        appendNotes(out, directions: stage.startDirections, cues: stage.startCues)
        if out.string.hasPrefix("\n") { out.deleteCharacters(in: NSRange(location: 0, length: 1)) }
        return out
    }

    private func measure(_ s: NSAttributedString) -> CGFloat {
        ceil(s.boundingRect(with: NSSize(width: textWidth, height: .greatestFiniteMagnitude), options: [.usesLineFragmentOrigin, .usesFontLeading]).height)
    }

    private func rebuildLayout() {
        guard let stage else {
            rows = []
            needsDisplay = true
            return
        }
        var built: [Row] = []
        // Room above the first line, so it can rest on the reading line instead of the top edge.
        var y: CGFloat = (viewport.height * readingFraction).rounded()
        // Through the middle of the letters: extra line spacing goes above them, not below.
        guideY = viewport.minY + viewport.height * readingFraction + singleLineHeight - fontSize * 0.6
        let intro = introText(stage)
        if intro.length > 0 {
            let h = measure(intro)
            built.append(Row(lineIndex: nil, top: y, height: h, text: intro))
            y += h + spacing
        }
        for i in stage.lines.indices {
            let t = lineText(stage, i)
            let h = measure(t)
            built.append(Row(lineIndex: i, top: y, height: h, text: t))
            y += h + spacing
        }
        rows = built
        rebuildWordPositions(stage)
        needsDisplay = true
    }

    /// Done at layout because measuring text is too slow for every frame.
    private func rebuildWordPositions(_ stage: PrompterStage) {
        guard settings.mode == .voice else {
            wordPositions = []
            return
        }
        let single = singleLineHeight
        wordPositions = stage.lines.indices.map { i in
            guard let row = rows.first(where: { $0.lineIndex == i }) else { return [] }
            let prefix = NSMutableAttributedString()
            var tops: [CGFloat] = []
            var lengths: [Int] = []
            for (w, word) in stage.lines[i].words.enumerated() {
                prefix.append(NSAttributedString(string: (w == 0 ? "" : " ") + word.text, attributes: textAttributes(bold: word.bold)))
                tops.append(row.top + Geometry.wordLineTop(textHeightThroughWord: measure(prefix), singleLineHeight: single))
                lengths.append(word.text.count + 1)
            }
            return VoicePacer.wordPositions(wrappedTops: tops, lengths: lengths, lineHeight: single)
        }
        let all = wordPositions.flatMap { $0 }
        let perWord = all.count > 1 ? (all[all.count - 1] - all[0]) / CGFloat(all.count - 1) : single * 0.3
        pacer.configure(maxOffset: maxOffset, defaultRate: max(1, perWord) * VoicePacer.defaultWordsPerSecond, backwardThreshold: single * 0.5)
    }

    /// The offset that puts this word where the voice is. In the notch the reading line is the top edge, and a
    /// word is measured at its progress through its line, so without one line of room the line being spoken
    /// would slide out of the panel before its end is read.
    private func pacingPosition(line i: Int, word: Int) -> CGFloat {
        let base: CGFloat
        if word >= 0, i < wordPositions.count, word < wordPositions[i].count {
            base = wordPositions[i][word]
        } else {
            base = rows.first(where: { $0.lineIndex == i })?.top ?? 0
        }
        let single = singleLineHeight
        let room = readingFraction == 0 ? min(single, max(0, viewport.height - single)) : 0
        return base - viewport.height * readingFraction - room
    }

    private func replacePacer(offset value: CGFloat) {
        pacer.place(offset: value, lastHeard: pacingPosition(line: cursorLine, word: cursorWord))
    }

    /// Colours change, heights do not.
    private func restyle() {
        guard let stage else { return }
        for k in rows.indices {
            if let i = rows[k].lineIndex { rows[k].text = lineText(stage, i) }
        }
    }

    private func targetFor(line i: Int) -> CGFloat {
        guard let row = rows.first(where: { $0.lineIndex == i }) else { return 0 }
        return min(maxOffset, Geometry.targetOffset(lineTop: row.top, viewportHeight: viewport.height, readingFraction: readingFraction))
    }

    private func lineAtReadingLine() -> Int? {
        let y = offset + viewport.height * readingFraction + 1
        return rows.last(where: { $0.lineIndex != nil && $0.top <= y })?.lineIndex ?? rows.first(where: { $0.lineIndex != nil })?.lineIndex
    }

    override func setFrameSize(_ newSize: NSSize) {
        super.setFrameSize(newSize)
        rebuildLayout()
        target = targetFor(line: cursorLine)
        offset = target
        replacePacer(offset: offset)
    }

    // MARK: - Animation

    private func tick() {
        let now = ProcessInfo.processInfo.systemUptime
        let dt = CGFloat(min(0.1, now - (lastTick ?? now)))
        lastTick = now
        guard let stage else { return }
        if isPacing && !isUserScrolling {
            let next = pacer.step(dt: dt)
            target = next
            if next != offset {
                offset = next
                needsDisplay = true
            }
            return
        }
        if settings.mode == .manual && playing && overlay == nil && countdownLeft <= 0 {
            let pxPerSecond = CGFloat(settings.speed) * 10 * (fontSize / 28)
            let end = manualEndOffset
            target = min(end, target + pxPerSecond / 60)
            if let i = lineAtReadingLine(), i != cursorLine {
                cursorLine = i
                cursorWord = -1
                restyle()
                onScrolled?(stage.lines[i].id, false)
            }
            if offset >= end - 0.5 && !atEndReported {
                atEndReported = true
                playing = false
                onAtEnd?()
            }
        }
        let diff = target - offset
        if abs(diff) > 0.3 {
            offset += diff * 0.2
            needsDisplay = true
        } else if diff != 0 {
            offset = target
            needsDisplay = true
        }
    }

    // MARK: - Input

    override func scrollWheel(with event: NSEvent) {
        guard stage != nil else { return }
        let delta = event.hasPreciseScrollingDeltas ? event.scrollingDeltaY : event.scrollingDeltaY * 10
        offset = max(0, min(maxOffset, offset - delta))
        target = offset
        needsDisplay = true
        scrollDebounce?.invalidate()
        scrollDebounce = Timer.scheduledTimer(withTimeInterval: 0.35, repeats: false) { [weak self] _ in
            guard let self else { return }
            self.scrollDebounce = nil
            guard let stage = self.stage, let i = self.lineAtReadingLine() else { return }
            self.cursorLine = i
            self.cursorWord = -1
            self.replacePacer(offset: self.offset)
            self.restyle()
            self.needsDisplay = true
            self.onScrolled?(stage.lines[i].id, true)
        }
    }

    override func mouseDown(with event: NSEvent) {
        guard allowsDragging, let window else { return }
        dragStart = NSEvent.mouseLocation
        startFrame = window.frame
        resizing = showsResizeGrip && gripRect.contains(convert(event.locationInWindow, from: nil))
    }

    override func mouseDragged(with event: NSEvent) {
        guard let start = dragStart, let window else { return }
        let now = NSEvent.mouseLocation
        let dx = now.x - start.x
        let dy = now.y - start.y
        if resizing {
            let w = max(320, startFrame.width + dx)
            let h = max(120, startFrame.height - dy)
            window.setFrame(NSRect(x: startFrame.minX, y: startFrame.maxY - h, width: w, height: h), display: true)
        } else {
            window.setFrameOrigin(NSPoint(x: startFrame.minX + dx, y: startFrame.minY + dy))
        }
    }

    override func mouseUp(with event: NSEvent) {
        if dragStart != nil { onFrameChanged?() }
        dragStart = nil
        resizing = false
    }

    // MARK: - Drawing

    private func backgroundPath() -> NSBezierPath {
        let b = bounds
        if settings.position == .fullscreen { return NSBezierPath(rect: b) }
        guard settings.position == .notch else { return NSBezierPath(roundedRect: b, xRadius: 14, yRadius: 14) }
        let r: CGFloat = 18
        let p = NSBezierPath()
        p.move(to: NSPoint(x: b.minX, y: b.minY))
        p.line(to: NSPoint(x: b.maxX, y: b.minY))
        p.line(to: NSPoint(x: b.maxX, y: b.maxY - r))
        p.appendArc(withCenter: NSPoint(x: b.maxX - r, y: b.maxY - r), radius: r, startAngle: 0, endAngle: 90, clockwise: false)
        p.line(to: NSPoint(x: b.minX + r, y: b.maxY))
        p.appendArc(withCenter: NSPoint(x: b.minX + r, y: b.maxY - r), radius: r, startAngle: 90, endAngle: 180, clockwise: false)
        p.close()
        return p
    }

    override func draw(_ dirtyRect: NSRect) {
        let bg = settings.position == .screen ? settings.screenOpacity : settings.opacity
        NSColor.black.withAlphaComponent(CGFloat(bg)).setFill()
        backgroundPath().fill()
        guard let stage else { return }

        NSGraphicsContext.saveGraphicsState()
        if settings.mirror {
            let t = NSAffineTransform()
            t.translateX(by: bounds.width, yBy: 0)
            t.scaleX(by: -1, yBy: 1)
            t.concat()
        }

        let headerFont = NSFont.systemFont(ofSize: min(16, max(11, (fontSize * 0.42).rounded())), weight: .semibold)
        let headerColor = NSColor(white: 0.6, alpha: 1)
        NSAttributedString(string: "Segment \(stage.index + 1)/\(stage.count)", attributes: [.font: headerFont, .foregroundColor: headerColor])
            .draw(at: NSPoint(x: padding, y: topInset + 4))
        if let status {
            let s = NSAttributedString(string: status, attributes: [.font: headerFont, .foregroundColor: headerColor])
            s.draw(at: NSPoint(x: bounds.width - padding - s.size().width, y: topInset + 4))
        }

        let vp = viewport
        if settings.showGuide && settings.position != .notch {
            NSColor.white.withAlphaComponent(0.3).setFill()
            NSBezierPath(rect: NSRect(x: 0, y: guideY, width: bounds.width, height: 1)).fill()
        }
        NSGraphicsContext.saveGraphicsState()
        NSBezierPath(rect: vp).addClip()
        for row in rows {
            if settings.mode == .bullets && row.lineIndex != cursorLine { continue }
            let y = vp.minY + row.top - offset
            if y + row.height < vp.minY || y > vp.maxY { continue }
            if row.lineIndex == cursorLine {
                var marker = textAttributes(bold: false)
                marker[.foregroundColor] = NSColor.white
                NSAttributedString(string: "▸", attributes: marker).draw(with: NSRect(x: padding, y: y, width: gutter + 4, height: singleLineHeight + 4), options: [.usesLineFragmentOrigin, .usesFontLeading])
            }
            row.text.draw(with: NSRect(x: padding + gutter, y: y, width: textWidth, height: row.height + 4), options: [.usesLineFragmentOrigin, .usesFontLeading])
        }
        NSGraphicsContext.restoreGraphicsState()

        let overlayText: String? = countdownLeft > 0 ? "\(countdownLeft)" : overlay
        if let o = overlayText {
            NSColor.black.withAlphaComponent(0.75).setFill()
            NSBezierPath(rect: vp).fill()
            let size = countdownLeft > 0 ? fontSize * 2 : fontSize * 0.8
            let para = NSMutableParagraphStyle()
            para.alignment = .center
            let a = NSAttributedString(string: o, attributes: [.font: NSFont.systemFont(ofSize: size, weight: .bold), .foregroundColor: NSColor.white, .paragraphStyle: para])
            let width = vp.width - 2 * padding
            let h = a.boundingRect(with: NSSize(width: width, height: .greatestFiniteMagnitude), options: [.usesLineFragmentOrigin]).height
            a.draw(with: NSRect(x: vp.minX + padding, y: vp.midY - h / 2, width: width, height: h + 4), options: [.usesLineFragmentOrigin])
        }
        NSGraphicsContext.restoreGraphicsState()

        if showsResizeGrip {
            NSColor(white: 0.5, alpha: 1).setStroke()
            let g = gripRect
            for k in 0..<3 {
                let o = CGFloat(k) * 5
                let p = NSBezierPath()
                p.move(to: NSPoint(x: g.maxX - 2 - o, y: g.maxY - 2))
                p.line(to: NSPoint(x: g.maxX - 2, y: g.maxY - 2 - o))
                p.stroke()
            }
        }
    }
}
