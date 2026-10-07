### Agent Build Doc

*	The user and the burden. 
    * Yatta yatta small church with no tech team, plenty of nights fighting WP, updating website to be consistent and visually modern is last priority
    *	We looked at X churches on maps, Y% did not have websites and Z% had outdated/contradictory information
*	Architecture. 
    * Jaron + Eric problem
    * How the agent is composed: single agent, orchestrator with subagents, or a pipeline. A diagram or clear description of the control flow and where decisions get made.
*	Prompts, verbatim. 
    * Jaron + Eric problem
    * Full system prompt and any subagent or tool prompts, as text, not screenshots. Include at least one earlier version and what was wrong with it.
*	Platform and stack. 
    * Cost effective model X for building, cheaper for summarization blah blah
    * Are we including subagents for website scraping? Describe agents
    * Actual cost data for build
    * Models used and why, framework or SDK, orchestration and memory, retrieval and data layer, hosting, cost per run at realistic volume.
*	Tools and permissions. 
    * JSON stuff? If we are giving tool calls only to change it then do that
    * The tool, API, or data source the agent can reach, what it is allowed to do with each, and what it is explicitly blocked from doing.
*	Evaluation. 
    * Created synthetic test websites, looked at output. Include build story
    * How you knew it worked. Test cases, pass criteria, failure modes you found, and what you changed in response. Even a hand-built set of twenty cases counts, and stating that it is twenty hand-built cases counts more than implying you had a benchmark.  
    * Include a session log that can be audited, to demonstrate that it behaved the way you expected it to.  What the frick are they talking about
*	Guardrails and human handoff. 
    * Gloo Model Guardrails + hardcoded manual ones?
    * What the agent will not do, how it detects those situations, and where control returns to a person.
*	Reproduction. 
    * README, open source everything (especially build doc, give bonus pts)
    * What another team needs to run this: repo, credentials required, setup steps, known gaps.

