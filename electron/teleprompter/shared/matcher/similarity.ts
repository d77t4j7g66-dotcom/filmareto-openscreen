export function levenshtein(a: string, b: string): number {
	if (a === b) return 0;
	const row = new Array<number>(b.length + 1);
	for (let j = 0; j <= b.length; j++) row[j] = j;
	for (let i = 1; i <= a.length; i++) {
		let diag = row[0];
		row[0] = i;
		for (let j = 1; j <= b.length; j++) {
			const up = row[j];
			row[j] = Math.min(row[j] + 1, row[j - 1] + 1, diag + (a[i - 1] === b[j - 1] ? 0 : 1));
			diag = up;
		}
	}
	return row[b.length];
}

/** 1 = identical. Words of two letters or fewer must match exactly. */
export function similarity(a: string, b: string): number {
	if (a === b) return a.length > 0 ? 1 : 0;
	if (!a || !b || Math.min(a.length, b.length) <= 2) return 0;
	return 1 - levenshtein(a, b) / Math.max(a.length, b.length);
}
