/**
 * How many hues the tint may pick from. Kept coarse on purpose: hues taken from
 * the whole circle produce neighbours that are the same colour with extra steps.
 */
const TINT_HUES = 12;

/**
 * The hue a note is tinted with — from its path, not from its position, so that a
 * card keeps its colour when the base is re-sorted, re-filtered or reopened. A
 * colour that moved between notes would look like it meant something.
 */
export function hueFor(path: string): number {
	// FNV-1a. Sequential paths ("note 1", "note 2") differ in one low bit, and any
	// hash that carries that difference straight into the result would hand a whole
	// folder the same two colours. This one avalanches.
	let hash = 0x811c9dc5;
	for (let index = 0; index < path.length; index++) {
		hash ^= path.charCodeAt(index);
		hash = Math.imul(hash, 0x01000193);
	}

	return ((hash >>> 0) % TINT_HUES) * (360 / TINT_HUES);
}
