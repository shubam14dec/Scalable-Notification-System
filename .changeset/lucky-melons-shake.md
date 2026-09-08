---
'@asyncify-hq/node': patch
---

Document the subscriber-token TTL bounds on `subscriberToken()`: 60s minimum, 6h maximum (was 24h), 1h by default. Requests above the ceiling are rejected by the server with a 400.
