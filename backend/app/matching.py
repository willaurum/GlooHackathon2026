"""Rule-based ministry ranking for the chat agent's search tool."""

SKILLS = ['Hospitality', 'Teaching', 'Technology', 'Creativity', 'Music', 'Organization', 'Listening', 'Encouragement']
STYLES = ['Working with people', 'Behind the scenes', 'Hands-on service']
DAYS = ['Sunday mornings', 'Saturday mornings', 'Weekday evenings']


def rank(ministries, skills, style=None, day=None, limit=3):
    """Score open ministries by skill overlap, serving style and availability."""
    ranked = []
    for ministry in ministries:
        if ministry['filled'] >= ministry['total']:
            continue
        overlap = sorted(set(skills).intersection(ministry['skills']))
        score = len(overlap) * 3 + (3 if ministry['style'] == style else 0) + (4 if ministry['day'] == day else 0)
        score += (ministry['total'] - ministry['filled']) / ministry['total']
        ranked.append({**ministry, 'overlap': overlap, 'score': score})
    ranked.sort(key=lambda m: (-m['score'], m['id']))
    return ranked[:limit]
