# Muse (Academy Build)

An unofficial build of the open-source **muse-desktop** client
(MIT — github.com/benjaminkitt/muse-desktop, v0.3.0) rebuilt on
**Electron 22.3.27**, the last Electron line that runs on
**macOS High Sierra (10.13)**, for Intel Macs. The official Muse app
requires Apple Silicon and a current macOS; this build exists so the
Academy's High Sierra machines can run a Muse client at all.

Packaged by **Detroit Automation Academy** for distribution through
**Distro**, the Academy's High Sierra app store. The application icon
in this packaging is the Academy monochrome standard rendition
(ink on paper). Nothing else in the application is changed.

- Bundle: `Muse.app` — bundle id `ai.muse.desktop`, version 0.3.0
- Unsigned test build (no Apple Developer identity) — first launch on
  the Mac requires right-click → Open.
- Not a Meta product. Not endorsed by Meta. "Muse" is Meta's product
  name, used here only to identify what this client connects to.
- Runtime status at packaging: assembled and bundle-verified;
  launch on real 10.13 hardware is the owner's verification gate.

Upstream source: https://github.com/benjaminkitt/muse-desktop
(commit c85467b, v0.3.0; sole adaptation: `app.setDesktopName` guard
for Electron 22).
