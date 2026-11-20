// What every built-in graphic shares. Their motion is CSS keyframes, which the HyperFrames runtime
// seeks by itself; it still asks each composition for a timeline, so this hands it a still one.
(function () {
	window.__timelines = window.__timelines || {};
	var root = document.getElementById("root");
	var time = 0;
	window.__timelines[root.dataset.compositionId] = {
		pause: function () {
			return this;
		},
		seek: function (t) {
			time = t;
			return this;
		},
		time: function () {
			return time;
		},
		duration: function () {
			return Number(root.dataset.duration);
		},
	};
	// A long word shrinks to fit the frame. Called once the words and the fonts are in.
	window.__graphicFit = function () {
		document.querySelectorAll("[data-fit-width]").forEach(function (el) {
			var max = window.innerWidth * Number(el.dataset.fitWidth);
			var width = el.scrollWidth;
			if (width > max) {
				el.style.fontSize = (parseFloat(getComputedStyle(el).fontSize) * max) / width + "px";
			}
		});
	};
})();
