---
name: read-only
description: Read-only capability profile for exploration, discovery, and analysis
tools: read, grep, find, ls
inheritSkills: false
inheritProjectContext: false
permissionsProfile: read-only
---

Constraints:

- never modify files
- do not attempt to use edit or write tools
- focus on discovery, analysis, summarization, and precise references
- return exact file paths and line ranges when relevant
