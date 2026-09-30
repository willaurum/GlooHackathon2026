# 1

- Model actual shifts
- Give each ministry one or more concrete shifts, for example:
  Welcome Team
  Sunday, October 11
  8:30–10:30 AM
  3 of 6 positions filled
  - Note that we may not need to be too specific though.

# 2

- Replace or supplement the free-text paragraph
- Replace with a couple short answer responses that ask for things like:
  Days and time windows
  Preferred service
  Frequency: one-time, weekly, monthly
  Earliest start date

# 3

- Use application logic to eliminate impossible schedules first, then ask AI to explain and rank the remaining choices. The existing prompt asks the model to respect schedule restrictions, but the server does not independently verify its result.
- A better system could be Availability filter -> requirements filter -> capacity filter -> AI ranking
