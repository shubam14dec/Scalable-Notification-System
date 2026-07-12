# @asyncify-hq/agent

## 0.3.0

### Minor Changes

- a35c0a2: Adds `resolved` lifecycle events: `onResolve(ctx)` now fires when a conversation is resolved (by the agent, an operator, or the inactivity sweep), with a read-only ResolveContext carrying the conversation summary and metadata. Also fixes unknown event types incorrectly falling through to onMessage.

## 0.2.1

### Patch Changes

- 9a8f27a: Document the buttons + onAction API (shipped in 0.2.0) in the README — tappable choices with `ctx.reply(text, { buttons })`, clicks handled in `onAction`, per-channel rendering notes.
