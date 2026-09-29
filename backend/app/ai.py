"""Synthesis stage: testimony + regional news -> situational summary and prayer points.

This is a deliberately isolated seam. `synthesize()` is the only function that
knows how to turn context into prose; swapping the stub below for a real LLM
call later means changing this file only, not any caller.
"""

import textwrap

ANGLES = ["safety", "provision", "gospel access", "endurance", "local relationships"]

_ANGLE_FRAMES = {
    "safety": "physical safety and the practical hazards of the terrain and season",
    "provision": "provision — the material needs of the team and the people they serve",
    "gospel access": "open doors for the gospel and the relationships forming around it",
    "endurance": "endurance and the toll steady, unglamorous work takes on the team",
    "local relationships": "the local partnerships and relationships the work depends on",
}


def next_angle(seen_angles: list[str]) -> str:
    """Pick the next angle, preferring one not yet shown for this region."""
    for angle in ANGLES:
        if angle not in seen_angles:
            return angle
    return ANGLES[len(seen_angles) % len(ANGLES)]


def synthesize(region: dict, news_items: list[dict], angle: str) -> dict:
    """Combine a testimony with regional news context into a summary + prayer points."""
    frame = _ANGLE_FRAMES[angle]
    headline = news_items[0]["headline"] if news_items else None
    testimony_snippet = textwrap.shorten(region["testimony"], width=220, placeholder="...")

    summary_parts = [
        f"{region['codename']} has been serving in {region['country']} since {region['since']}, "
        f"focused on {region['field_of_ministry'].lower()}.",
        testimony_snippet,
    ]
    if headline:
        summary_parts.append(f"Recent regional news adds context: \"{headline}\".")
    summary_parts.append(f"This angle looks specifically at {frame}.")
    summary = " ".join(summary_parts)

    prayer_points = _prayer_points_for_angle(angle, region, news_items)

    return {"summary": summary, "prayer_points": prayer_points}


def _prayer_points_for_angle(angle: str, region: dict, news_items: list[dict]) -> list[str]:
    country = region["country"]
    codename = region["codename"]
    headlines = [n["headline"] for n in news_items[:2]]

    if angle == "safety":
        points = [
            f"Pray for {codename}'s physical safety as they travel {country}'s terrain, especially where recent conditions have made routes harder or slower.",
            f"Pray for wisdom in timing travel and outreach around the season's risks in {country}.",
        ]
    elif angle == "provision":
        points = [
            f"Pray for the material needs {codename} has named directly: capacity, funding, or supplies stretched thin by current demand.",
            f"Pray for provision for the families and partners {codename} serves in {country}, particularly where local conditions have tightened resources.",
        ]
    elif angle == "gospel access":
        points = [
            f"Pray for the specific openness {codename} has described in their community in {country} — that curiosity would deepen into lasting faith.",
            f"Pray for courage and clarity as {codename} responds to invitations to share more.",
        ]
    elif angle == "endurance":
        points = [
            f"Pray for the team's endurance — {codename} has described real fatigue alongside real fruit this season.",
            f"Pray for rest and encouragement for the team members carrying the heaviest load in {country} right now.",
        ]
    else:  # local relationships
        points = [
            f"Pray for the local partners and leaders {codename} depends on in {country}, that trust would keep deepening.",
            f"Pray for the emerging local leaders {codename} has mentioned, that they would be equipped to carry this work forward.",
        ]

    if headlines:
        points.append(
            "Pray in light of what's happening regionally right now: " + "; ".join(headlines) + "."
        )
    return points
