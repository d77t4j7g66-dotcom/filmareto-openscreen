/**
 * This tree is Filmareto OpenScreen, a private build of OpenScreen. It is not published to the
 * upstream release channel and does not report to upstream's analytics, so the two things that
 * would talk to upstream (the update check, which would offer the original app as a replacement,
 * and the anonymous usage ping) are switched off here, in one place.
 */
export const FORK_BUILD = true;
export const FORK_UPDATE_NOTICE =
	"This is Filmareto OpenScreen. It is not updated from the internet: a new version arrives as a new installer from Filmareto.";
