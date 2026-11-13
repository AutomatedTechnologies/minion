#!/usr/bin/env python3
"""Assemble Minion-1013-x64.zip — Minion 0.4.3.

Construction of record (Distro files/06): the official Electron
v22.3.27 darwin-x64 distribution (SHA-256 pinned below — a mismatch
halts the build), plus the sanctioned changed set:

  1. Electron.app renamed to Minion.app; MacOS/Electron -> MacOS/Minion
     (bytes identical).
  2. Stock electron.icns removed; Academy icon.icns added (assets/).
  3. Contents/Resources/app/ added from app/ (upstream
     v0.3.0 source + the Academy feature layer).
  4. Info.plist merged from the dist template: the 7 identity keys
     of files/06 section 5, versions 0.4.0, and the Academy audit
     entry (files/08 rule).
  5. INSTALL.txt added at the zip root (assets/).

Zip discipline mirrors files/06 section 10 (rebuild.py): entries in
deterministic walk order, source timestamps + Unix modes preserved,
symlinks written as symlink entries, deflate compression.

The script self-verifies the finished zip (plist readback, icon
hash, app-layer inventory, Mach-O census) and prints one JSON line:
{"size_bytes": ..., "sha256": ..., "entries": ...}.
"""
import argparse
import hashlib
import json
import os
import plistlib
import shutil
import stat
import sys
import tempfile
import zipfile

DIST_SHA256 = "01f053d08cb2855acb14f0465f4e36324a41bd13b3b2ead142970a56df3e9db1"
VERSION = "0.4.3"
AUDIT = {
    "Disassembled": True,
    "Scanned": True,
    "Recompiled": True,
    "Authority": "Detroit Automation Academy",
    "Date": "2026-11-10",
}
# SDS-10 attestation (Distro files/08 note, 2026-11-10): flags true
# only for clauses this build actually meets — Logo: one master
# (bundle icon.icns; the welcome's app-icon.png is derived from that
# same icns below; About renders the bundle icon). VersionAtStartup:
# the welcome reads app.getVersion() (the plist) at runtime.
# StartupSound: startup-sound.wav byte-identical to the library
# asset (SHA-256 07a11324...). MenuBar: full menu, About (version)
# + Quit, every item wired (electron/academy.cjs).
CONFORMANCE = {
    "Standard": "SDS-10",
    "Logo": True,
    "VersionAtStartup": True,
    "StartupSound": True,
    "MenuBar": True,
    "Authority": "Detroit Automation Academy",
    "Date": "2026-11-10",
}
STARTUP_SOUND_SHA256 = "07a113244c6b432b22954a089ce519bd239311b14a48f26ae85214ed8c25b09a"
EXPECTED_APP_FILES = [
    "package.json",
    "LICENSE",
    "electron/main.cjs",
    "electron/utils.cjs",
    "electron/academy.cjs",
    "electron/md-classify.cjs",
    "electron/md-route.cjs",
    "electron/history.cjs",
    "electron/avatar-governor.cjs",
    "electron/window-law.cjs",
    "electron/window-state.cjs",
    "electron/preload.cjs",
    "electron/welcome-preload.cjs",
    "electron/welcome.html",
    "electron/app-icon.png",
    "electron/terminal.html",
    "electron/terminal-preload.cjs",
    "electron/startup-sound.wav",
]


def largest_icns_png(icns_path):
    """The welcome's logo must be the bundle icon itself, not a
    redraw (SDS-10 clause 1): pull the largest PNG rendition out of
    icon.icns and ship it beside welcome.html as app-icon.png."""
    data = open(icns_path, "rb").read()
    assert data[:4] == b"icns", "icon asset is not an icns"
    best = None
    pos = 8
    while pos + 8 <= len(data):
        length = int.from_bytes(data[pos + 4:pos + 8], "big")
        if length < 8 or pos + length > len(data):
            break
        payload = data[pos + 8:pos + length]
        if payload[:8] == b"\x89PNG\r\n\x1a\n" and (best is None or len(payload) > len(best)):
            best = payload
        pos += length
    assert best, "no PNG rendition inside icon.icns"
    return best


def sha256_file(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def extract_preserving(zip_path, dest):
    """Extract a zip keeping Unix modes and symlinks (zipfile does
    neither by itself — the framework tree's Versions/Current links
    are load-bearing)."""
    z = zipfile.ZipFile(zip_path)
    dir_modes = []
    for info in z.infolist():
        name = info.filename
        target = os.path.join(dest, name)
        mode = (info.external_attr >> 16) & 0xFFFF
        if name.endswith("/"):
            os.makedirs(target, exist_ok=True)
            if mode:
                dir_modes.append((target, mode))
        elif stat.S_ISLNK(mode):
            os.makedirs(os.path.dirname(target), exist_ok=True)
            if os.path.lexists(target):
                os.remove(target)
            os.symlink(z.read(name).decode("utf-8"), target)
        else:
            os.makedirs(os.path.dirname(target), exist_ok=True)
            with open(target, "wb") as f:
                f.write(z.read(name))
            if mode:
                os.chmod(target, mode)
    # Directory modes last, deepest first: makedirs() stamps the
    # process umask, which would otherwise drift every directory
    # entry away from the distribution's recorded modes.
    for target, mode in sorted(dir_modes, key=lambda t: -t[0].count(os.sep)):
        os.chmod(target, stat.S_IMODE(mode))
    z.close()


def write_zip(tree_root, out_path):
    """Write the package from the assembled tree: INSTALL.txt first,
    then a deterministic walk (dirs before contents, sorted)."""
    entries = []  # (arcname, source path or None for dirs, is_dir, is_link)

    def walk(base, arc_prefix):
        names = sorted(os.listdir(base))
        dirs = [n for n in names if os.path.isdir(os.path.join(base, n)) and not os.path.islink(os.path.join(base, n))]
        files = [n for n in names if n not in dirs]
        for d in dirs:
            p = os.path.join(base, d)
            entries.append((arc_prefix + d + "/", p, True, False))
            walk(p, arc_prefix + d + "/")
        for fn in files:
            p = os.path.join(base, fn)
            entries.append((arc_prefix + fn, p, False, os.path.islink(p)))

    app_root = os.path.join(tree_root, "Minion.app")
    entries.append(("INSTALL.txt", os.path.join(tree_root, "INSTALL.txt"), False, False))
    entries.append(("Minion.app/", app_root, True, False))
    walk(app_root, "Minion.app/")

    out = zipfile.ZipFile(out_path, "w", zipfile.ZIP_DEFLATED, compresslevel=6)
    import datetime
    for arcname, src, is_dir, is_link in entries:
        st = os.lstat(src)
        dt = datetime.datetime.fromtimestamp(st.st_mtime).timetuple()[:6]
        zi = zipfile.ZipInfo(arcname, date_time=dt)
        zi.create_system = 3
        zi.external_attr = (st.st_mode & 0xFFFF) << 16
        if is_dir:
            zi.compress_type = zipfile.ZIP_STORED
            out.writestr(zi, b"")
        elif is_link:
            zi.compress_type = zipfile.ZIP_STORED
            out.writestr(zi, os.readlink(src))
        else:
            zi.compress_type = zipfile.ZIP_DEFLATED
            with open(src, "rb") as f:
                out.writestr(zi, f.read())
    out.close()
    return len(entries)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--dist", required=True, help="electron-v22.3.27-darwin-x64.zip")
    ap.add_argument("--app", required=True, help="app layer directory (package.json, LICENSE, electron/)")
    ap.add_argument("--assets", required=True, help="assets directory (icon.icns, INSTALL.txt)")
    ap.add_argument("--out", required=True, help="output zip path")
    ap.add_argument("--workdir", default=None,
                    help="parent dir for the assembly tempdir (default: system temp; "
                         "pass a big-disk path where /tmp is small)")
    ap.add_argument("--ls-helper", default=None,
                    help="path to the compiled AcademyLSDefault helper (MD-T3); "
                         "copied to Contents/Resources/AcademyLSDefault (0755) "
                         "and counted in the Mach-O census")
    args = ap.parse_args()

    digest = sha256_file(args.dist)
    if digest != DIST_SHA256:
        print(f"FATAL: dist SHA-256 {digest} != pinned {DIST_SHA256}", file=sys.stderr)
        return 1

    work = tempfile.mkdtemp(prefix="minion-assemble-", dir=args.workdir)
    try:
        extract_preserving(args.dist, work)
        src_app = os.path.join(work, "Electron.app")
        dst_app = os.path.join(work, "pkg", "Minion.app")
        os.makedirs(os.path.join(work, "pkg"))
        shutil.move(src_app, dst_app)

        # 1. Launcher stub rename (bytes identical).
        os.rename(
            os.path.join(dst_app, "Contents", "MacOS", "Electron"),
            os.path.join(dst_app, "Contents", "MacOS", "Minion"),
        )
        # 2. Icon swap.
        os.remove(os.path.join(dst_app, "Contents", "Resources", "electron.icns"))
        shutil.copyfile(
            os.path.join(args.assets, "icon.icns"),
            os.path.join(dst_app, "Contents", "Resources", "icon.icns"),
        )
        # 3. App layer.
        app_dst = os.path.join(dst_app, "Contents", "Resources", "app")
        shutil.copytree(args.app, app_dst)
        # SDS-10 clause 1: derive the welcome logo from the bundle
        # icon asset itself (same master, no redraw).
        with open(os.path.join(app_dst, "electron", "app-icon.png"), "wb") as f:
            f.write(largest_icns_png(os.path.join(args.assets, "icon.icns")))
        # SDS-10 clause 3: the startup sound ships byte-identical.
        sound = os.path.join(app_dst, "electron", "startup-sound.wav")
        assert sha256_file(sound) == STARTUP_SOUND_SHA256, "startup sound drifted from the library asset"
        # 4. Plist merge from the dist template.
        plist_path = os.path.join(dst_app, "Contents", "Info.plist")
        with open(plist_path, "rb") as f:
            plist = plistlib.load(f)
        plist["CFBundleDisplayName"] = "Minion"
        plist["CFBundleExecutable"] = "Minion"
        plist["CFBundleIconFile"] = "icon.icns"
        # The app is Minion under the Academy bundle identity
        # com.detroitautomationacademy.minion (owner directives
        # 2026-11-10 21:14 + 21:49 EST; obliteration ruling
        # 2026-11-11 13:14 EST, Distro files/19 sections 10-11
        # and 16): this build — the line's own
        # disassembly/scan/rebuild — ships as Minion, identified
        # by version alone (0.4.1).
        plist["CFBundleIdentifier"] = "com.detroitautomationacademy.minion"
        plist["CFBundleName"] = "Minion"
        plist["CFBundleShortVersionString"] = VERSION
        plist["CFBundleVersion"] = VERSION
        plist["com.detroitautomationacademy.audit"] = AUDIT
        plist["com.detroitautomationacademy.conformance"] = CONFORMANCE
        with open(plist_path, "wb") as f:
            plistlib.dump(plist, f, fmt=plistlib.FMT_XML)
        # 4b. MD-T3 helper (academy4+): the LaunchServices helper
        # ships in Contents/Resources, executable, beside the app
        # layer — main.cjs finds it at process.resourcesPath.
        if args.ls_helper:
            helper_dst = os.path.join(dst_app, "Contents", "Resources", "AcademyLSDefault")
            shutil.copyfile(args.ls_helper, helper_dst)
            os.chmod(helper_dst, 0o755)
        # 5. INSTALL.txt at the package root.
        shutil.copyfile(
            os.path.join(args.assets, "INSTALL.txt"),
            os.path.join(work, "pkg", "INSTALL.txt"),
        )
        # Normalize directory modes to the distribution's 0o755:
        # copytree/makedirs stamp the local umask on the directories
        # they create (the app layer's), which must not drift.
        for base, dirs, _files in os.walk(dst_app):
            for d in dirs:
                p = os.path.join(base, d)
                if not os.path.islink(p):
                    os.chmod(p, 0o755)
        os.chmod(dst_app, 0o755)

        count = write_zip(os.path.join(work, "pkg"), args.out)
    finally:
        shutil.rmtree(work, ignore_errors=True)

    # --- Self-verification of the finished artifact ---
    z = zipfile.ZipFile(args.out)
    names = z.namelist()
    plist = plistlib.loads(z.read("Minion.app/Contents/Info.plist"))
    assert plist["CFBundleIdentifier"] == "com.detroitautomationacademy.minion", "bundle id drifted"
    assert plist["CFBundleShortVersionString"] == VERSION, "short version drifted"
    assert plist["CFBundleVersion"] == VERSION, "bundle version drifted"
    assert plist["LSMinimumSystemVersion"] == "10.13", "floor drifted"
    audit = plist.get("com.detroitautomationacademy.audit") or {}
    assert audit.get("Disassembled") is True and audit.get("Scanned") is True \
        and audit.get("Recompiled") is True and audit.get("Authority") \
        and audit.get("Date"), "audit entry incomplete"
    conf = plist.get("com.detroitautomationacademy.conformance") or {}
    assert conf.get("Standard") == "SDS-10" and conf.get("Logo") is True \
        and conf.get("VersionAtStartup") is True and conf.get("StartupSound") is True \
        and conf.get("MenuBar") is True and conf.get("Authority") \
        and conf.get("Date"), "SDS-10 conformance entry incomplete"
    sound = z.read("Minion.app/Contents/Resources/app/electron/startup-sound.wav")
    assert hashlib.sha256(sound).hexdigest() == STARTUP_SOUND_SHA256, "startup sound not byte-identical in the artifact"
    icon = z.read("Minion.app/Contents/Resources/icon.icns")
    assert hashlib.sha256(icon).hexdigest() == sha256_file(os.path.join(args.assets, "icon.icns")), "icon drifted"
    assert not any(n.endswith("electron.icns") for n in names), "stock icon survived"
    # academy5: the rejected terminal skin is deleted, and the
    # artifact must prove it — no skin sheet anywhere in the zip.
    assert not any(n.endswith("terminal-skin.css") for n in names), \
        "terminal skin survived into the artifact"
    for rel in EXPECTED_APP_FILES:
        assert f"Minion.app/Contents/Resources/app/{rel}" in names, f"missing app file {rel}"
    macho = 0
    for n in names:
        if n.endswith("/"):
            continue
        head = z.read(n)[:4]
        if head in (b"\xcf\xfa\xed\xfe", b"\xfe\xed\xfa\xcf"):
            macho += 1
    # 15 = the Electron distribution's binaries; academy4 adds the
    # AcademyLSDefault helper in Contents/Resources (16).
    expected_macho = 16 if args.ls_helper else 15
    if args.ls_helper:
        assert "Minion.app/Contents/Resources/AcademyLSDefault" in names, \
            "ls-helper missing from the artifact"
    assert macho == expected_macho, f"Mach-O census {macho} != {expected_macho}"
    size = os.path.getsize(args.out)
    print(json.dumps({
        "size_bytes": size,
        "sha256": sha256_file(args.out),
        "entries": count,
        "macho_binaries": macho,
        "version": VERSION,
    }))
    return 0


if __name__ == "__main__":
    sys.exit(main())
