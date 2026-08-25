---
name: Production schema smoke tests
description: Why production API checks must follow database/schema changes even when the bundle builds.
---

Run a small read-only production smoke suite against the high-traffic organizer and public endpoints after any schema-affecting release, and before calling a production release verified.

**Why:** esbuild accepts undefined properties in a Drizzle select object. The API can build and start cleanly, then throw at runtime when a route selects a column omitted from the shared schema. The converse is also possible: application schema changes can make queries select a column that a production migration has not created.

**How to apply:** Include at least the event roster, check-in list, bib availability, and public event schedule in release verification. Investigate every unexpected 500; distinguish expected unauthenticated 401 responses from failures. Confirm the deployed database columns and shared schema agree before publishing.