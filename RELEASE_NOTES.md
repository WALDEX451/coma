# COMA 2.0.0 beta 1

This beta makes the source download usable again. The GitHub 1.0 tag contained the Python and Node servers but omitted the `public/` browser assets and tests that those servers expected.

- Restored the responsive browser interface for accounts, personal invitations, private conversations, live messages, read status, search, blocking, and reports.
- Added an isolated integration smoke test for assets, registration, invitations, messaging, and CSRF.
- Aligned the package version and documentation with the beta.

This is a beta for testing. Desktop builds need validation on Windows and macOS before they are distributed. Messages are not end-to-end encrypted. See the [README](README.md) for setup and current limitations.
