# claude-context-bar

## This is a private fork

`JayYa/claude-context-bar` is a fork of `edenaion/claude-context-bar`, used only by its owner: not published to the marketplace, no PRs back upstream. Breaking changes — removing a setting, changing a default — need no deprecation window. The cost paid instead is a merge conflict the next time upstream `main` is merged in.

**CHANGELOG `(#N)` references point at the upstream tracker**, not this one. GitHub shares a number space, so `gh issue view <N>` here returns a real but unrelated issue. Read those numbers against `edenaion/claude-context-bar`.

## Writing multi-line bodies

Write issue bodies, specs and commit messages to a temp file with the Write tool, then pass `--body-file` / `-F` to `gh`. Bash heredocs fail on this machine's Git Bash once the body contains CJK text and quotes, and the whole payload has to be resent.

## Agent skills

### Issue tracker

Issues live in GitHub Issues on `JayYa/claude-context-bar`, managed with the `gh` CLI. See `docs/agents/issue-tracker.md`.

### Triage labels

The five canonical triage roles, each using its default label string. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: `CONTEXT.md` and `docs/adr/` at the repo root. See `docs/agents/domain.md`.
