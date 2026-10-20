---
name: hotwire-frontend
description: Use when building or reviewing server-rendered Rails UI with ERB, Turbo Drive, Frames, Streams and Stimulus.
---

# Hotwire frontend conventions

Read the project's AGENTS.md and the view guide. Write the failing system or request test first ([test-driven-development](../../../../skills/test-driven-development/SKILL.md)); backend tests and screenshots do not replace frontend coverage.

| Need | Default |
|---|---|
| Navigation, ordinary forms | ERB, links/forms, Turbo Drive |
| One independent region changes | Turbo Frame with a stable ID |
| Several elements change | Turbo Stream with server-rendered partials |
| Small browser behaviour | Stimulus |

Keep state and authorisation on the server; prefer standard HTML before JavaScript. No separate SPA, client router or state library.

- Forms: `form_with`; failed submissions render errors with **422** and keep values; successful state changes redirect with **303**. Test framed and full-page paths.
- Frames: `dom_id` for stable IDs; the response must contain the matching frame; use `_top` only when the whole page should navigate. Do not hide server errors behind an empty frame.
- Streams: check current tenant/user access on subscription and delivery; a stream name is not authorisation.
- Stimulus: reuse existing controllers first; declare targets and values; make `connect()` re-runnable; clean up listeners, timers and requests in `disconnect()`. Never insert untrusted HTML.
- Private pages need an explicit cache policy; test account switch, logout and back/forward.

Check labels, keyboard order, focus (and focus return from dialogs), error recovery and loading/empty/denied states. A "request accepted" indicator must not show a completed outcome before the server has evidence.
