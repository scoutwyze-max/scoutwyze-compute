#!/usr/bin/env node
// Stand-in for scripts/outreach/run.mjs in tests — same final-line
// shape OutreachRunner parses for its completion summary, but zero
// real I/O (no GitHub API calls). A short delay keeps a real OS
// process alive long enough for the "already running" 409 guard to be
// testable against a real spawn, not just asserted against a mock.
await new Promise((resolve) => setTimeout(resolve, 150));
console.error("3 kit(s) written under scripts/outreach/kits/. Review before sending anything, anywhere.");
