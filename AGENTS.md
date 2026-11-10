# WARCON Fork — Development Rules

## Scope

Development on speccycy/warcon, locally on INFH-WORK-01 only.

## Safety

- Preserve existing reserved slots, manual entries and player history.
- Protect immutable Entry IDs during updates and removals.
- Never modify or delete another owner's Entry using SteamID alone.
- Maintain existing WARCON Admin API compatibility.
- No Production access, destructive database operations or real-provider mutations.

## Engineering

- Inspect source, Git status and affected callers before editing.
- Use the existing Bun, SvelteKit, Drizzle and PostgreSQL architecture.
- Prefer minimal changes to current functions and routes.
- Avoid new queues, services and unnecessary migrations.
- Use isolated disposable databases for integration tests.
- Review actual diffs and report unverified assumptions.

## Authorization

- Local source changes and focused tests are permitted.
- No commit, push, merge, release or deployment without separate Owner authorization.
- Independent source acceptance is required before release.
