# GitHub and ZIP reconciliation

The user confirmed that no changes had been made in Claude after downloading
the original handoff ZIP. The current local project is therefore the source
for a regenerated ZIP, reconciled with the last fetched GitHub main.

## History and conflict review

The GitHub tip reviewed was `4c1c672d901c33ab357b22bc674a7268bec78e57`.
GitHub had 18 commits absent from the local ancestry, primarily mobile release
work and a sync of fixes also present in the local files.

The local `claude-handoff` branch contains a merge acknowledging both histories.
The merge retains the local application tree, rather than restoring older
versions from GitHub:

- Mobile app and EAS release settings already match GitHub.
- Timing identity helpers retain GitHub functionality plus newer active
  transponder validation exports and tests.
- Rider portal and mobile training keep the later race-style-specific
  fastest-lap eligibility rules.
- Offline sync keeps the expanded rider profile fields.
- Live leaderboard retains analytics and adds the later reusable stream/views,
  event validation and position-change handling.
- Moto schema keeps the later durable announcer fields.
- Web PWA configuration keeps its later reload behavior.
- Local memory includes the prior production schema guidance plus newer notes.

A trial automatic merge with local conflict resolution differed from the
current source only by downgrading the filelist transitive minimatch resolution
from 5.1.9 to 5.1.2. That downgrade was rejected. No application edits were needed.

## Delivery and equality

GitHub main must remain untouched. The intended remote destination is
`claude-handoff`. A local merge or an exported ZIP is not proof of a successful
remote push; check remote access before claiming synchronization is complete.

The ZIP is a sanitized source export, not a byte-for-byte Git repository:
it excludes Git history, runtime files, secret values and generated builds.
It adds schema DDL, historical plans and export metadata. Historical demo
credentials are removed from the exported copy of replit.md.

`export-metadata/SOURCE_REVISION.json` identifies the commit used to generate
the ZIP. `FILE_MANIFEST.json` records the included file hashes. Aside from the
documented exclusions and redaction, packaged source should match that commit.

Use the regenerated ZIP instead of the previous download.
