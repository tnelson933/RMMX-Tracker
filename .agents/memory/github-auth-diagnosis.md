---
name: GitHub authentication diagnosis
description: Avoid repeating misleading reconnection guidance when Git writes fail.
---

Do not treat successful public repository reads or a healthy integration status as proof of Git write authentication.

**Why:** Reconnecting through Integrations produced a new source-control connection, yet CLI pushes still rejected authentication. A read with token environment variables unset succeeded while a push using the same environment failed; that does not establish that the saved token caused the problem.

**How to apply:** Verify actual write access before claiming authentication is repaired. Do not repeatedly send the user to “Git Providers” or “Connected Services”: their settings UI did not contain these menus, and Advanced → Source control settings only contained workspace policies. Use their visible UI and current documentation, and distinguish connection status from Git CLI access.
