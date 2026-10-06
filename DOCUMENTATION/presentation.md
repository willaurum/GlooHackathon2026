# Gloo 2026 Hackathon: Presentation and Marketing

### Track 1

- Lead with "the agent only asks what it couldn't find out.
- The agent checks it's own work before verifying
- A person always clicks Publish -> there is never an action AI takes without the aproval of a real human.

### Defined specific user

- John Smith is a student and has recently started attending his local church. John wanted to get more connected to his church so he went to his church's website to learn more about upcoming events and ministry opportunites, but when he looked at the website, the church had information about their easter service that happened last year. The site was very outdated and John felt lost. He never felt like he could find the information he needed and was too shy to ask about it.
- There are tons of churches who go months and months without ever updating their websites and younger upcoming generations increasingly look to the internet for details and help with all aspects of their lives

### Presentation

##### The live demo is what gets judged.

- it requires at least one live edge case that the agent handles.
- Edge cases in advance: 9 vs 10 AM service conflict, a site with almost no information (the agent asks more questions), and a beliefs page (the agent sends it back to the pastor).
- Open with a before/after: the outdated real site next to the generated one, built in a few minutes.

- Risks to Address
  - Scraping: the rules ban scraped congregational data. Public church-organization information is different, but the agent should leave out staff and member names and photos of minors, and the doc should say so explicitly.

- _keep a finished, cached run of the same church ready. If the live run isn't done by about 2:15, say plainly: "Here's the same church from a run this morning. The live one will be done for Q&A." Saying it openly keeps your credibility. Passing off a recording as live would destroy it, and the rules specifically mark down recorded happy paths._

| Time          | What's on screen                                     | What to say                                                                                                                                                                             |
| ------------- | ---------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **0:00–0:20** | Screenshot of a real, outdated church site           | Your named user: _"Pastor \_\_\_ runs a 90-person church on a second job. Their website still shows Easter service times."_ Use a real line from one of your interviews if you get one. |
| **0:20–0:35** | Paste the URL (a judge's pick or yours) and press go | _"Here's what Tekton. does with it."_                                                                                                                                                   |
| **0:35–1:15** | Agent progress feed                                  | Read out what it's doing. Stop on the 9 vs 10 AM conflict and answer it live. Point out it also sent the beliefs page back to the pastor instead of writing theology itself.            |
| **1:15–2:00** | The generated site                                   | It's a real site: click _Plan your visit_ and _Give_. Make one live edit request: _"Put service times above ministries."_                                                               |
| **2:00–2:30** | Hover a fact to show its source                      | _"Every fact shows where it came from. Nothing is invented. A person clicks Publish."_ Then the cost per run and the time it took.                                                      |
| **2:30–3:00** | Closing slide                                        | The bigger vision, then end on your tagline. Only use statistics you've checked.                                                                                                        |
