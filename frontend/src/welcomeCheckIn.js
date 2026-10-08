// Checking guests in by name on the Welcome team page (WelcomeTeam.jsx).

// Matches the backend's limit on a visit's name (VisitRequest, WalkInRequest).
export const MAX_GUEST_NAME = 100;

/** A typed name as it is saved: surrounding and repeated spaces removed. */
export function cleanGuestName(typed) {
  return String(typed ?? '').replace(/\s+/g, ' ').trim().slice(0, MAX_GUEST_NAME).trim();
}

/** A name for comparing: no case, accents or extra spaces ("  JOSÉ  lopez" and "jose lopez" match). */
export function nameKey(name) {
  return cleanGuestName(name).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
}

/** The planned guests whose name contains every word typed, in any order ("pat", "ex pat"). */
export function matchPlannedGuests(planned, typed) {
  const words = nameKey(typed).split(' ').filter(Boolean);
  if (!words.length) return [];
  return (planned || []).filter(v => {
    const key = nameKey(v.name);
    return words.every(w => key.includes(w));
  });
}

/** What the check-in box offers for a typed name: the planned guests it matches (each gets a check-in button),
 *  the guests already waiting who match (already here, no button), and whether to offer checking the name in
 *  as a new guest (when nobody planned or waiting has exactly that name). */
export function checkInChoices(planned, typed, waiting = []) {
  const name = cleanGuestName(typed);
  if (!name) return { name, matches: [], here: [], offerNew: false };
  const matches = matchPlannedGuests(planned, name), here = matchPlannedGuests(waiting, name);
  const exact = [...matches, ...here].some(v => nameKey(v.name) === nameKey(name));
  return { name, matches, here, offerNew: !exact };
}

/** What Enter in the check-in box does: check in the only guest it can mean, or nothing when it is unclear. */
export function enterAction({ matches, offerNew }) {
  if (matches.length === 1 && !offerNew) return { visit: matches[0] };
  if (!matches.length && offerNew) return { newGuest: true };
  return null;
}
