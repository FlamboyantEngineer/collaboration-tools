---
'@flamboyantengineer/collaboration-tools': patch
---

Fix authorization expiry and rapid refresh loops and incomplete-update checks, stop processing frames after refusal,
and make shutdown wait for pending room loads while closing pending connections. Recover from
failed room rules and socket creation, time out unopened sockets, reject incomplete stored
states and seeds, bound awareness counts, prevent retries after cancellation, resolve receipts
after refusal, and handle reserved URL parameters and prototype-named keys correctly.
