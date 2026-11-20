import CoreGraphics
import Foundation

/// Voice steers a continuous scroll. Words arrive about a second late, so the scroll aims at where the speaker
/// is now rather than at what was heard. Everything is in points of scroll offset; time comes only from `step`.
public struct VoicePacer {
    public static let defaultWordsPerSecond: CGFloat = 2.5

    public struct Config {
        public var recognizerLag: CGFloat = 1.0
        public var silenceAfter: CGFloat = 1.2
        public var stopDuration: CGFloat = 1.0
        public var rateWindow: CGFloat = 4.0
        public var minRateSpan: CGFloat = 1.5
        /// Extra speed, per second, for each point of distance from the aim.
        public var correctionGain: CGFloat = 1.0
        public var maxSpeedFactor: CGFloat = 3.0
        public var rateClamp: ClosedRange<CGFloat> = 0.3...3.0
        public var speedSmoothing: CGFloat = 0.25
        public var snapSmoothing: CGFloat = 0.08
        public init() {}
    }

    public private(set) var offset: CGFloat = 0
    public private(set) var velocity: CGFloat = 0

    private let config: Config
    private var maxOffset: CGFloat = .greatestFiniteMagnitude
    private var defaultRate: CGFloat = 100
    private var backwardThreshold: CGFloat = 20
    private var now: CGFloat = 0
    private var listening = false
    private var lastHeard: CGFloat?
    private var lastHeardAt: CGFloat = 0
    private var samples: [(t: CGFloat, position: CGFloat)] = []
    private var measuredRate: CGFloat?
    private var snapTarget: CGFloat?

    public init(config: Config = Config()) {
        self.config = config
    }

    /// Where the text is going to rest: the target of a move still under way, else where it is.
    public var restingOffset: CGFloat { snapTarget ?? offset }

    /// Pixels per second at the moment: measured over the last few seconds, or the default until there is data.
    public var rate: CGFloat { measuredRate ?? defaultRate }

    public mutating func configure(maxOffset: CGFloat, defaultRate: CGFloat, backwardThreshold: CGFloat) {
        self.maxOffset = max(0, maxOffset)
        self.defaultRate = max(1, defaultRate)
        self.backwardThreshold = backwardThreshold
        measuredRate = nil
        samples = []
    }

    /// Stops and waits for words from this offset: at play, pause, a user scroll or a new layout.
    public mutating func place(offset value: CGFloat, lastHeard heard: CGFloat?) {
        offset = clamped(value)
        lastHeard = heard
        snapTarget = nil
        velocity = 0
        listening = false
        samples = []
    }

    /// A word was heard at this position.
    public mutating func heard(position: CGFloat) {
        if let last = lastHeard, position < last {
            samples = []
            if last - position >= backwardThreshold {
                snapTarget = clamped(position)
                velocity = 0
            }
        }
        if listening && now - lastHeardAt >= config.silenceAfter { samples = [] }
        samples.append((now, position))
        samples.removeAll { now - $0.t > config.rateWindow }
        if let first = samples.first, now - first.t >= config.minRateSpan {
            let measured = (position - first.position) / (now - first.t)
            measuredRate = min(defaultRate * config.rateClamp.upperBound, max(defaultRate * config.rateClamp.lowerBound, measured))
        }
        lastHeard = position
        lastHeardAt = now
        listening = true
    }

    /// Moves there quickly, leaving what was heard alone.
    public mutating func snap(to position: CGFloat) {
        snapTarget = clamped(position)
        velocity = 0
    }

    /// Goes there at once, then waits for words.
    public mutating func jump(to position: CGFloat) {
        snapTarget = clamped(position)
        lastHeard = position
        velocity = 0
        listening = false
        samples = []
    }

    public mutating func step(dt: CGFloat) -> CGFloat {
        now += dt
        if let snap = snapTarget {
            offset += (snap - offset) * (1 - exp(-dt / config.snapSmoothing))
            if abs(snap - offset) < 0.5 {
                offset = snap
                snapTarget = nil
            }
            return offset
        }
        guard listening, let heard = lastHeard else { return offset }
        let since = now - lastHeardAt
        let r = rate
        let aim = heard + r * (config.recognizerLag + min(since, config.silenceAfter))
        var goal = max(0, min(r * config.maxSpeedFactor, r + config.correctionGain * (aim - offset)))
        velocity += (goal - velocity) * (1 - exp(-dt / config.speedSmoothing))
        if since >= config.silenceAfter {
            goal = r * max(0, 1 - (since - config.silenceAfter) / config.stopDuration)
            velocity = min(velocity, goal)
        }
        offset = clamped(offset + velocity * dt)
        return offset
    }

    private func clamped(_ value: CGFloat) -> CGFloat { max(0, min(maxOffset, value)) }

    /// A word's vertical position: the top of its wrapped line plus how far through that line it ends.
    /// `wrappedTops` holds each word's wrapped-line top, `lengths` its characters.
    public static func wordPositions(wrappedTops: [CGFloat], lengths: [Int], lineHeight: CGFloat) -> [CGFloat] {
        var out = [CGFloat](repeating: 0, count: wrappedTops.count)
        var start = 0
        while start < wrappedTops.count {
            var end = start
            while end + 1 < wrappedTops.count && wrappedTops[end + 1] == wrappedTops[start] { end += 1 }
            let total = max(1, lengths[start...end].reduce(0, +))
            var done = 0
            for k in start...end {
                done += lengths[k]
                out[k] = wrappedTops[k] + lineHeight * CGFloat(done) / CGFloat(total)
            }
            start = end + 1
        }
        return out
    }
}
