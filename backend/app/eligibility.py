"""Deterministic shift eligibility; AI never decides which shifts enter its catalog."""
from datetime import date

REQUIREMENTS = {
    'background_check': 'Background check', 'onboarding': 'Onboarding',
    'shadowing': 'Shadowing an experienced volunteer', 'audition': 'Audition',
    'midweek_rehearsal': 'Midweek rehearsal', 'care_training': 'Care training',
    'confidentiality': 'Confidentiality orientation',
}
SERVICES = {'sunday-9', 'sunday-11', 'wednesday-1830', 'outside-services'}
DAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday']


def eligible_ministries(ministries, preferences, today=None):
    today = today or date.today()
    windows = preferences.get('availability') or []
    service = preferences.get('preferred_service') or ''
    # Legacy prose cannot safely be treated as machine-checked availability.
    if preferences.get('days_and_times') or (service and service not in SERVICES):
        return [], 'Please enter your availability using day and time windows and choose a service from the list.'
    earliest = max(today, date.fromisoformat(preferences['earliest_start_date'])) if preferences.get('earliest_start_date') else today
    frequency = preferences.get('frequency')
    declined = set(preferences.get('unavailable_requirements') or [])
    eligible = []
    for ministry in ministries:
        # Availability first, including the entire shift (not merely overlapping).
        shifts = []
        for shift in ministry.get('shifts', []):
            shift_date = date.fromisoformat(shift['date'])
            if shift_date < earliest:
                continue
            if windows and not any(w['day'] == DAYS[shift_date.weekday()] and
                                   w['start_time'] <= shift['start_time'] and
                                   shift['end_time'] <= w['end_time'] for w in windows):
                continue
            if service and service not in shift.get('services', []):
                continue
            if frequency and frequency not in shift.get('frequencies', []):
                continue
            shifts.append(shift)
        # Explicitly declined requirements are hard exclusions. Unknowns need confirmation.
        requirements = ministry.get('requirements', [])
        if declined.intersection(requirements):
            continue
        # Capacity must be available on the compatible shift, not elsewhere on the team.
        shifts = [shift for shift in shifts if shift['filled'] < shift['total']]
        if not shifts:
            continue
        confirmations = []
        if not windows:
            confirmations.append('Availability was not specified; confirm the shift times with the team.')
        confirmations.extend('Confirm: ' + REQUIREMENTS.get(req, req) + '.' for req in requirements)
        if 'requirements' not in ministry:
            confirmations.append('Confirm onboarding requirements with the team.')
        if frequency in ('weekly', 'monthly'):
            confirmations.append('The team accepts this frequency; confirm future dates with the team.')
        eligible.append({**ministry, 'shifts': shifts,
                         'filled': sum(s['filled'] for s in shifts),
                         'total': sum(s['total'] for s in shifts),
                         'confirmations': confirmations})
    return eligible, 'No open shifts meet your selected availability, service, frequency, start date, and requirement choices. Try other preferences or contact a team.'
