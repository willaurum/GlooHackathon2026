# Church template framework, version 1

The existing Tekton React website is the template. A future agent writes a **site blueprint JSON file**; this framework validates it and prepares the church content that the existing API accepts. It does not read websites, create churches, create accounts, import content over the network, or deploy anything.

```text
Supplied church facts → agent edits blueprint.json → validate → prepare
→ staff reviews content → operator provisions church → staff imports → verify website
```

## Try it locally

Run from the repository root with Python 3.11+ and the backend dependencies installed (`python -m pip install -r backend/requirements.txt`). Docker is not needed for these commands.

```bash
python -m templatizer validate templatizer/examples/complete.json
python -m templatizer prepare templatizer/examples/complete.json --output work/cedar-hollow
python -m templatizer validate templatizer/examples/incomplete.json
python -m templatizer validate templatizer/examples/conflicting.json
python -m unittest discover -s templatizer/tests -v
```

The complete example prepares three files:

- `church-content.json`: the normalized payload for the existing church content API.
- `review-report.json`: missing information, warnings and review decisions.
- `manifest.json`: church slug, template version, source evidence and intended import path. Contains no credentials.

Exit codes: **0** structurally valid / prepared, **2** invalid input or output error, **3** unresolved conflict or unverified claim. Preparation refuses to overwrite its output files. `ready_to_prepare` means the local package can be made; it is not factual approval or permission to publish. Missing information stays blank; conflicting or unverified information blocks preparation until a person resolves it.

## Contract

Use [the schema](schemas/site-blueprint-v1.schema.json) and [agent instructions](AGENT.md). The schema is generated from the actual backend models, rather than a second hand-maintained copy:

```bash
python -m templatizer schema --output templatizer/schemas/site-blueprint-v1.schema.json
```

The blueprint has `schema_version: 1`, `template: "tekton-church-v1"`, a stable `church_slug`, `source_urls`, `content`, `evidence`, and `review`. `content.info.name` is required. Other information can be unknown. Source URLs in examples use reserved `example.org` addresses and are illustrative, not sites to fetch. All churches, people and street addresses in these examples are fictional.

| Content section | Existing template use |
| --- | --- |
| `info` | Name, contact details, address, service times, first visit and church description |
| `faqs` | Visitor questions and chat grounding |
| `events`, `groups` | Highlights shown to visitors and supplied to chat |
| `ministries` | Serve teams and optional volunteer schedules |
| `calendar` | Dated calendar events |
| `regions` | Prayer map countries and field updates |

An omitted section is preserved when imported. An explicitly empty array replaces that section with no items. Sending `info` replaces the entire info object; omitted fields inside it become defaults, so do not use a partial info object to patch an existing church. Export and review its current content first. The API can retain ministries referenced by existing connections; inspect the returned import result rather than assuming every deletion succeeded.

The local validator also checks dates, duplicate IDs, reserved slugs, unsupported fields and evidence pointers; JSON Schema alone cannot express all these checks. Evidence must point to a nonempty field and a listed source URL. It does **not** prove that the source is truthful or that the excerpt supports the value. Human review remains necessary. Runtime defaults and generated IDs follow the backend's normalization rules. Content exceeding the API's 512 KiB request limit is rejected during preparation.

## Integration with the existing site

After an operator provisions the church internally and configures its Owner account, an authenticated church Owner or Site admin can PUT the prepared content to `/api/churches/<slug>/church/content` through the church API. The response is the saved content. The site's church route is `#/c/<slug>/`. Public church registration stays disabled. Do not place passwords or staff sessions in the blueprint or prepared files.

Owner and Site admin permissions stay in the current staff system: Owner can add/remove accounts; Site admin can manage that church's content and operational features. Blueprint files cannot assign these roles.

Verify the name, services, visit page, Serve teams, calendar and prayer map on desktop and mobile after import. Check that omitted information is shown honestly and no Grace Community demo data appears for the new church. Confirm the registry name/city and content name/city agree; this package does not update the separate church registry.

This version covers the seven existing church content sections. Theme colors, logo uploads, domain assignment, navigation customization, the demo's illustrated campus map, and bundled demo About/Beliefs/News/Directory/Connect data are not configurable through this contract. Giving funds, Stripe setup, applications, donations, guest records, member connections, sermons and staff accounts are separate runtime resources. A content package cannot provision or populate them. A new church may therefore have empty operational sections until staff configure them.

## Next agent implementation

Start with supplied facts and this contract. Once that produces reliable, reviewed packages, add website reading as a separate adapter. Keep extraction, review, package preparation, provisioning and authenticated import separate so an ambiguous source cannot silently overwrite a live church. Changes to the template contract require updated examples, a regenerated schema, compatibility tests and a version decision.
