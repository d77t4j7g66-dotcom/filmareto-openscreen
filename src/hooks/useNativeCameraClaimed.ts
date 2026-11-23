import { useEffect, useState } from "react";

/**
 * 1.2.0: true while the capture helper records the camera. A camera runs one format at a time,
 * so every preview in the app lets it go for the take and opens it again afterwards; otherwise the
 * previews' 1080p held the camera and the helper's 4K at a locked 30 fps got no frame.
 */
export function useNativeCameraClaimed(): boolean {
	const [claimed, setClaimed] = useState(false);
	useEffect(() => {
		let alive = true;
		void window.electronAPI?.isNativeCameraClaimed?.().then((value) => {
			if (alive) setClaimed(Boolean(value));
		});
		const off = window.electronAPI?.onNativeCameraClaim?.((value) => setClaimed(value));
		return () => {
			alive = false;
			off?.();
		};
	}, []);
	return claimed;
}
