# Anthropic integration: implementation prompt

Research date: 2026-10-15. This is a task brief, not an implemented feature.

## Verified starting point

- Our working production baseline is `65c0018d`; verification documentation is
  `e4f9649d`. Preserve the existing ChatGPT provider and GLM routes.
- The user personally changed the ChatGPT model list to `gpt-6-astra` and
  `gpt-6.1-sol`. Both expose Low, Medium, High, Extra high and Max in a packaged
  isolated GUI check. Do not revert that selection to the earlier Sol 5.6 example.
- Inspected `nasone32/ZCode`, branch `feat/chatgpt-oauth`, remote HEAD
  `38a7ecce2c22f6614aad65306bf107d88bfcbbd0`. Its auth implementation adds ChatGPT,
  not a reusable Claude subscription integration. Existing Anthropic API protocol
  support is not subscription authentication. Its `docs/model-provider-presets.md`
  explicitly excludes Claude OAuth from provider settings.
- Local `claude.exe` exists at `C:\Users\user\.local\bin\claude.exe`, version
  `2.1.215`. The user reports an existing connection. A sanitized check of
  `claude auth status --json` in this shell returned exit 1, `loggedIn:false`,
  `authMethod:none`, `apiProvider:firstParty`. This does not disprove a connection
  in another profile, shell, WSL environment, or application. No login/logout,
  credential extraction, or model request was performed.

## Official references and boundaries

- [Plan access](https://support.claude.com/en/articles/15036540-use-the-claude-agent-sdk-with-your-claude-plan):
  the October 7 update says SDK, `claude -p`, and third-party app usage can still
  use subscription limits; Max/Team additionally include monthly API credits.
  These are distinct billing paths, not a reason to assume free or unlimited use.
- [Authentication and product conditions](https://code.claude.com/docs/en/legal-and-compliance):
  users can sign into the unmodified Claude Code binary themselves. Third-party
  developers must not collect/intermediate Claude credentials or implement their
  own Claude.ai login. Recheck the complete current conditions before implementation.
- [Authentication](https://code.claude.com/docs/en/authentication) and
  [programmatic operation](https://code.claude.com/docs/en/headless) document the
  official runtime, structured streams, sessions and permission integration.

## Copy-ready prompt

You are working in D:\Development\ZCode-Harness, branch dev. Implement Claude
access in our existing ZCode desktop application using the user's own authorized
Claude Code installation. Reuse our successful ChatGPT settings and selector UX,
but do not copy OpenAI OAuth endpoints, credentials, or inference transport.
Keep one maintained product; do not create another repository or permanent clone.
Use an isolated worktree only if needed, preserving the accepted production build.

First read AGENTS.md, package instructions, the implementation checklist, the
ChatGPT subscription plan, architecture guidance, and the verified notes above.
Recheck the linked official Anthropic sources. Record any changed conditions or
unresolved entitlement/billing questions before treating the route as supported.
Do not promise zero ban risk or unlimited subscription usage.

Discover the user's existing Claude Code installation and intended account context.
Use documented status commands and redact personal information. Do not read,
export, copy, log, or store Claude OAuth tokens in ZCode. Do not reset a working
login. A connection in another application is not automatically reusable. If login
is needed, let the user complete the official unmodified Claude Code flow.

Use an official Claude Code/Agent SDK runtime integration supported by the installed
version. Keep authentication and the agent loop owned by that runtime. Investigate
the documented SDK and CLI interfaces before choosing the adapter and record the
decision. Do not turn Claude Code into a disguised raw HTTP inference proxy, borrow
its client identity, call private endpoints, or bypass access controls. Do not assume
that permission to run Claude Code also permits copying its authentication flow.

Reuse our provider-panel layout, explicit model controls and composer presentation.
Use neutral UI branding consistent with Anthropic's trademark conditions. Keep API
key access visibly separate. Populate models and effort levels only from supported
runtime capabilities or explicitly labeled user configuration. Do not hardcode GPT
reasoning levels for Claude or present guessed model IDs as discovered entitlement.

Define an explicit execution-backend boundary: selecting a Claude runtime model must
dispatch to that runtime, never to our OpenAI Responses adapter or GLM gateway.
Project cwd, artifact context, attachments, permission requests, tool events, streamed
text, cancellation, final results and session resume must map into ZCode correctly.
Do not run two agent loops against the same session. Bind each session to its backend;
make cross-backend switches explicit rather than passing incompatible session IDs.
Reuse Host ownership and detached-window behavior; tools must not execute twice when
a conversation moves between windows. Drain stdout/stderr and bound process shutdown.

Identify billing from the official auth/runtime state. Keep subscription limits,
included API credits, extra usage and API-key billing distinct. Do not silently switch
to a paid route or enable extra usage. Surface uncertainty and quota errors honestly.
Preserve all existing ChatGPT, Z.ai/GLM and custom-provider routes and settings.

Implement a narrow vertical slice first: runtime detection/status, model selection,
one correctly routed session, streaming, permission handling and cancellation.
Add only focused tests for changed behavior, including auth absence, route isolation,
capability mapping, fragmented stream events, interruption and resume. Run required
type/lint/architecture checks and a packaged GUI check. Do not run unrelated broad
test sweeps. A paid live model call requires the user's explicit authorization;
fixture or UI success must not be reported as successful subscription inference.

When implemented and verified, build production into
D:\Development\ZCode-Harness\packages\desktop\dist using the existing build scripts.
Preserve the profile, the single ZCode shortcut and fork-safe update settings. Update
the English changelog and Russian acceptance checklist; separate implemented behavior
from unverified live billing/access. Commit only task files and push to origin/dev.
Report the implementation, test/build evidence, revision and remaining limitations.
