---
'@asyncify-hq/react': patch
---

Chat widget: tell the user when a send was rate limited instead of blaming their connection. A 429 from the agent message/action routes now surfaces as "too many messages — try again in Ns" (using the server's `retryAfterSeconds`) through the existing error line; other failures keep the connection wording.
