Recorded fixtures for tests/it1-ai.test.mjs (IT1 lane, brief section 1.3).

The AI lane talks to POST /api/import-ai and the server owns the model call,
so these files replay the server's replies. No test makes a network call.

- messy-headers.csv: a messy export with headers that match no known format
  ("Date Played, Stake, Won/Lost, Duration (h:mm)").
- messy-mapping-reply.json: a recorded {kind: 'table'} reply holding the AI's
  column mapping (roles + rules) for that CSV. The test applies the mapping to
  every row in code, like the preview screen will.
- pasted-reply.json: a recorded reply where the AI returned session rows
  directly for pasted text ("Oct 3 1/2 at Lodge +340 5h" style notes).
- tournament-reply.json: a recorded reply for a tournament list with buy-ins,
  rebuys, entries, finish places and cash-outs, including two impossible rows.

Expected values live in the test file, not here. The replies are plausible
shapes following the endpoint contract in js/import-ai.js header comments;
the server lane owns the real prompt and response schema.
