import type { MenuItemConstructorOptions } from "electron";

/** The File-menu entry for the Resolve export: present only while the setting is on. */
export function resolveExportFileMenuItems(
	enabled: boolean,
	label: string,
	click: () => void,
): MenuItemConstructorOptions[] {
	return enabled ? [{ label, click }] : [];
}
