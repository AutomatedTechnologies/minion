# Minion

**Minion** is the Detroit Automation Academy's desktop client for
Intel Macs running **macOS High Sierra (10.13)**, assembled on
**Electron 22.3.27** — the last Electron line that runs on 10.13.
The hosted service's official app requires Apple Silicon and a
current macOS; Minion exists so the Academy's High Sierra machines
can run a client at all. The app connects to its API endpoint over
HTTPS; the endpoint is plumbing, never a name — every surface of
this app is Minion.

Packaged by **Detroit Automation Academy** for distribution through
**Distro**, the Academy's High Sierra app store.

- Bundle: `Minion.app` — bundle id
  `com.detroitautomationacademy.minion`, version **0.4.1**,
  identified by version alone.
- Icon: the Minion mark (the scheming side-eye dog) in the Academy
  monochrome standard rendition — white tile, ink artwork, no
  black field.
- Unsigned test build (no Apple Developer identity) — first launch
  on the Mac requires right-click → Open.
- Not a Meta product. Not endorsed by Meta.
- Application layer: open-source (MIT, v0.3.0) plus the Academy
  feature layer — see `app/LICENSE` for the license and
  attribution, and `LICENSE-ACADEMY.md` for the Academy License
  governing Academy-original works.
- Data: stored separately, outside the bundle, at
  `~/Library/Application Support/com.detroitautomationacademy.minion`.
- Runtime status at packaging: assembled and bundle-verified in
  CI; launch on real 10.13 hardware is the owner's verification
  gate.
