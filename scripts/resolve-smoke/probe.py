#!/usr/bin/env python3
"""ClipDock Resolve -nogui read-only smoke probe.

Connects to the Resolve instance the harness launched with -nogui, through the
official scripting module (DaVinciResolveScript + fusionscript.so), performs
READ-ONLY checks only (version, project manager / project-list readiness,
current project presence/name, media pool and current timeline presence when
available, plus the transferApi shape src/transfer.ts depends on), requests
Quit(), and emits exactly one bounded JSON line prefixed with
CLIPDOCK_SMOKE_JSON:.

transferApi: verifies the read-only Resolve API shape required by
src/transfer.ts. Every callable transfer.ts depends on is reported (required /
optional). Mutating APIs (AddItemListToMediaPool, AppendToTimeline,
AddSubFolder, SetCurrentFolder, OpenPage, AddMarker, SetClipColor) are checked
by CALLABLE PRESENCE ONLY and are never invoked. Safe read-only calls
(GetMediaStorage, GetProjectManager/GetCurrentProject, GetMediaPool,
GetCurrentFolder/GetRootFolder/GetSubFolderList/GetClipList, GetCurrentTimeline,
GetUniqueId, GetSetting, GetStartFrame/GetStartTimecode/GetCurrentTimecode, GetClipProperty
on an existing clip) verify the getters actually answer. When an owning object
is unreachable (no project / no timeline / no clip) its entries are reported as
"unavailable" and the probe stays valid (green); a required callable MISSING on
a reachable object fails the probe (exit 5).

Quit is ownership-gated: the probe may call Resolve.Quit() only when the
running `pgrep -x Resolve` PID set is exactly the harness child PID passed via
RESOLVE_SMOKE_CHILD_PID (closes the preflight/connect TOCTOU). When ownership
cannot be proven, Quit is skipped and a sanitized ownership error is reported
(quitError). This applies to the normal probe and the quit-only fallback
(RESOLVE_SMOKE_QUIT_ONLY=1).

Never creates, saves, closes, renames, or deletes projects, timelines, bins,
or clips. Python >= 3.6, stdlib only.

Exit codes (also mirrored in the JSON):
  0 ok; 2 DaVinciResolveScript import failed; 3 connect timeout;
  4 probe failed mid-checks; 5 checks failed (readiness or a required
  transferApi callable missing on a reachable object).
"""

import json
import os
import re
import math
import subprocess
import sys
import time

MARKER = "CLIPDOCK_SMOKE_JSON:"
POLL_INTERVAL_S = 0.5
NAME_LIMIT = 120
ERROR_LIMIT = 160

# Read-only Resolve API surface src/transfer.ts depends on.
#
# required: transfer.ts hard-depends on each callable; a callable MISSING on a
#   reachable object fails the probe (exit 5). Entries whose owning object is
#   unreachable (no project / no timeline / no clip) are recorded as
#   "unavailable" and do NOT fail: no-project/no-timeline stays valid.
# optional: transfer.ts feature-detects these and degrades gracefully
#   (markers/color/end-frame); missing optionals are recorded, never red.
# mutating: presence-only checks; the probe NEVER invokes these.
TRANSFER_REQUIRED = {
    "resolve": ("GetMediaStorage", "GetProjectManager", "OpenPage"),
    "projectManager": ("GetCurrentProject",),
    "project": ("GetCurrentTimeline", "GetMediaPool", "GetSetting", "GetUniqueId"),
    "timeline": ("GetStartFrame", "GetStartTimecode", "GetCurrentTimecode", "GetUniqueId", "GetSetting"),
    "mediaPool": ("GetCurrentFolder", "GetRootFolder", "AddSubFolder", "SetCurrentFolder", "AppendToTimeline"),
    "folder": ("GetName", "GetSubFolderList", "GetClipList", "GetUniqueId"),
    "mediaStorage": ("AddItemListToMediaPool",),
    "clip": ("GetClipProperty",),
}
TRANSFER_OPTIONAL = {
    "timeline": ("AddMarker", "GetEndFrame"),
    "clip": ("SetClipColor",),
}
TRANSFER_MUTATING = frozenset([
    "resolve.OpenPage",
    "mediaStorage.AddItemListToMediaPool",
    "mediaPool.AddSubFolder",
    "mediaPool.SetCurrentFolder",
    "mediaPool.AppendToTimeline",
    "timeline.AddMarker",
    "clip.SetClipColor",
])


def emit(payload):
    """Emit the bounded JSON result as one marked line."""
    sys.stdout.write(MARKER + json.dumps(payload) + "\n")
    sys.stdout.flush()


def safe_text(value, limit=NAME_LIMIT):
    """Bounded string: None-safe, whitespace-stripped, length-capped."""
    if value is None:
        return None
    try:
        text = str(value)
    except Exception:
        return None
    text = text.strip()
    return text if len(text) <= limit else text[:limit]


def sanitize_exc(exc, limit=ERROR_LIMIT):
    """Bounded, single-line exception text (never raw tracebacks)."""
    text = str(exc) if exc is not None else ""
    text = " ".join(text.split())
    return text if len(text) <= limit else text[:limit]


def request_quit(resolve):
    """Request app shutdown. Read-only: quits the instance, touches no project."""
    try:
        return bool(resolve.Quit())
    except Exception:
        return False


def resolve_pids():
    """Exact-comm `pgrep -x Resolve` PID set; None when pgrep itself fails
    (fail safe: unknown process state can never prove ownership)."""
    try:
        out = subprocess.check_output(["pgrep", "-x", "Resolve"], stderr=subprocess.DEVNULL)
    except subprocess.CalledProcessError as exc:
        if exc.returncode == 1:
            return set()  # pgrep exit 1 = no match
        return None
    except Exception:
        return None
    pids = set()
    for token in out.decode("utf-8", "replace").split():
        if not token.isdigit():
            return None
        pids.add(int(token))
    return pids


def quit_state(resolve):
    """Ownership-gated Quit.

    Quits only when the running `pgrep -x Resolve` PID set is exactly the
    harness child PID from RESOLVE_SMOKE_CHILD_PID. Otherwise skips Quit and
    returns a sanitized ownership error so the harness reports it; parent
    cleanup may signal only its own child.
    """
    raw = os.environ.get("RESOLVE_SMOKE_CHILD_PID", "")
    child_pid = int(raw) if raw.isdigit() else None
    if child_pid is None:
        return {
            "requested": False,
            "error": {
                "code": "quit-ownership-unproven",
                "message": "RESOLVE_SMOKE_CHILD_PID not set; cannot prove this Resolve instance belongs to the harness",
            },
        }
    pids = resolve_pids()
    if pids is None:
        return {
            "requested": False,
            "error": {
                "code": "quit-ownership-unproven",
                "message": "pgrep -x Resolve failed; cannot prove this Resolve instance belongs to the harness",
            },
        }
    if pids != {child_pid}:
        listing = ", ".join(str(pid) for pid in sorted(pids)) or "none"
        return {
            "requested": False,
            "error": {
                "code": "quit-ownership-unproven",
                "message": "running Resolve pid set (%s) does not exactly match harness child pid %d; refusing to quit" % (listing, child_pid),
            },
        }
    return {"requested": request_quit(resolve), "error": None}


def project_manager_ready(resolve):
    """Poll the ProjectManager list, not just scriptapp, as readiness evidence."""
    try:
        pm = resolve.GetProjectManager()
        plist = pm.GetProjectListInCurrentFolder() if pm is not None else None
        return isinstance(plist, list)
    except Exception:
        return False


def presence(api, bucket, group, obj, name):
    """Record callable presence of `name` on `obj` under `group`.

    Inspects callable-ness only (never invokes the method — this is how every
    mutating API is checked). When the owning object is unreachable, the entry
    is recorded as "unavailable" and does not fail the check.
    """
    key = "%s.%s" % (group, name)
    if obj is None:
        api["unavailable"].append(key)
        bucket[key] = "unavailable"
        return
    try:
        found = callable(getattr(obj, name, None))
    except Exception:
        found = False
    bucket[key] = found


def transfer_api_checks(resolve, storage, pm, project, timeline, media_pool, folder, clip):
    """Compact transfer.ts API shape: required/optional callable presence.

    ok is True when every REQUIRED callable is present on its reachable owner
    ("unavailable" entries are not failures). Mutating callables appear in the
    bounded `mutating` list; they are never invoked here.
    """
    api = {
        "ok": False,
        "mutating": sorted(TRANSFER_MUTATING),
        "required": {},
        "optional": {},
        "unavailable": [],
        "callErrors": {},
    }
    scopes = {
        "resolve": resolve,
        "mediaStorage": storage,
        "projectManager": pm,
        "project": project,
        "timeline": timeline,
        "mediaPool": media_pool,
        "folder": folder,
        "clip": clip,
    }
    for group, names in TRANSFER_REQUIRED.items():
        for name in names:
            presence(api, api["required"], group, scopes[group], name)
    for group, names in TRANSFER_OPTIONAL.items():
        for name in names:
            presence(api, api["optional"], group, scopes[group], name)
    api["ok"] = all(value is True or value == "unavailable" for value in api["required"].values())
    return api


def main():
    try:
        deadline_ms = int(os.environ.get("RESOLVE_SMOKE_DEADLINE_MS", "120000"))
    except ValueError:
        deadline_ms = 120000
    quit_only = os.environ.get("RESOLVE_SMOKE_QUIT_ONLY") == "1"
    deadline = time.time() + max(1, deadline_ms / 1000.0)

    try:
        import DaVinciResolveScript as bmd
    except Exception as exc:
        emit({
            "ok": False,
            "error": {
                "code": "probe-import-failed",
                "message": sanitize_exc("DaVinciResolveScript import failed: %s" % (exc,)),
            },
        })
        return 2

    # Phase A: bounded scriptapp + ProjectManager readiness polling.
    resolve = None
    poll_started = time.time()
    while time.time() < deadline:
        if resolve is None:
            try:
                resolve = bmd.scriptapp("Resolve")
            except Exception:
                resolve = None
        if resolve is not None and (quit_only or project_manager_ready(resolve)):
            break
        time.sleep(POLL_INTERVAL_S)
    poll_ms = int((time.time() - poll_started) * 1000)

    if resolve is None:
        emit({
            "ok": False,
            "error": {
                "code": "connect-timeout",
                "message": "Resolve scripting API did not become reachable within the deadline",
            },
        })
        return 3
    if quit_only:
        state = quit_state(resolve)
        emit({"ok": True, "checks": None, "quitRequested": state["requested"], "quitError": state["error"]})
        return 0

    # Phase B: read-only checks (never mutates anything).
    readiness = {"scriptapp": True, "projectManagerReady": True, "pollMs": poll_ms}
    checks = {}
    storage = pm = project = timeline = media_pool = folder = clip = None
    project_rate = None
    call_errors = {}
    observed = {}

    def valid_id(value):
        return isinstance(value, str) and bool(value.strip())

    def valid_rate(value):
        if isinstance(value, bool) or not isinstance(value, (str, int, float)):
            return False
        # Match transfer.ts: decimal syntax, optional DF suffix, inclusive bounds.
        parsed = re.fullmatch(r"([0-9]+(?:\.[0-9]+)?)(?:\s*DF)?", str(value).strip(), re.IGNORECASE)
        return parsed is not None and 1 <= float(parsed.group(1)) <= 240

    def valid_custom_settings(value):
        # Transfer handles the observed scalar; do not assume a particular
        # Resolve version's spelling or coerce "0" to a truthy Python bool.
        return value is None or isinstance(value, (str, bool, int)) or isinstance(value, float) and math.isfinite(value)
    try:
        checks["version"] = safe_text(resolve.GetVersionString())
    except Exception as exc:
        checks["version"] = None
        checks["versionError"] = sanitize_exc(exc)

    def valid_timecode(value):
        return isinstance(value, str) and re.fullmatch(r"\d{2,}:[0-5]\d:[0-5]\d[:;]\d{2}", value) is not None

    def safe_call(key, fn, valid=lambda value: value is not None):
        """Read-only invocation; errors and invalid required answers fail the check."""
        try:
            value = fn()
            if not valid(value):
                call_errors[key] = "invalid required getter result"
            return value
        except Exception as exc:
            call_errors[key] = sanitize_exc(exc)
            return None

    try:
        pm = resolve.GetProjectManager()
        checks["projectManager"] = pm is not None
        if pm is not None:
            plist = pm.GetProjectListInCurrentFolder()
            checks["projectList"] = {
                "ready": isinstance(plist, list),
                "count": len(plist) if isinstance(plist, list) else None,
            }
            project = pm.GetCurrentProject()
            checks["currentProject"] = {"present": project is not None}
            if project is not None:
                checks["currentProject"]["name"] = safe_text(project.GetName())
                try:
                    media_pool = project.GetMediaPool()
                    checks["mediaPool"] = {"present": media_pool is not None}
                    if media_pool is None:
                        call_errors["project.GetMediaPool"] = "invalid required getter result"
                except Exception as exc:
                    checks["mediaPool"] = {"present": False, "error": sanitize_exc(exc)}
                    call_errors["project.GetMediaPool"] = sanitize_exc(exc)
                try:
                    timeline = project.GetCurrentTimeline()
                    checks["currentTimeline"] = {"present": timeline is not None}
                    if timeline is not None:
                        checks["currentTimeline"]["name"] = safe_text(timeline.GetName())
                except Exception as exc:
                    checks["currentTimeline"] = {"present": False, "error": sanitize_exc(exc)}
                    call_errors["project.GetCurrentTimeline"] = sanitize_exc(exc)

        # transferApi: the read-only API shape src/transfer.ts depends on.
        # Presence of every callable (mutating APIs are NEVER invoked); the
        # safe read-only calls below verify getters actually answer.
        storage = safe_call("resolve.GetMediaStorage", lambda: resolve.GetMediaStorage())
        if project is not None:
            observed["project.GetUniqueId"] = safe_text(safe_call("project.GetUniqueId", lambda: project.GetUniqueId(), valid_id))
            project_rate = safe_call("project.GetSetting", lambda: project.GetSetting("timelineFrameRate"), valid_rate)
        if media_pool is not None:
            folder = safe_call("mediaPool.GetCurrentFolder", lambda: media_pool.GetCurrentFolder())
            safe_call("mediaPool.GetRootFolder", lambda: media_pool.GetRootFolder())
        if folder is not None:
            observed["folder.GetUniqueId"] = safe_text(safe_call("folder.GetUniqueId", lambda: folder.GetUniqueId(), valid_id))
            safe_call("folder.GetName", lambda: folder.GetName())
            safe_call("folder.GetSubFolderList", lambda: folder.GetSubFolderList(), lambda value: isinstance(value, list))
            cliplist = safe_call("folder.GetClipList", lambda: folder.GetClipList(), lambda value: isinstance(value, list))
            if isinstance(cliplist, list) and len(cliplist) > 0:
                clip = cliplist[0]
        if clip is not None:
            safe_call("clip.GetClipProperty", lambda: clip.GetClipProperty("File Path"))
        if timeline is not None:
            observed["timeline.GetUniqueId"] = safe_text(safe_call("timeline.GetUniqueId", lambda: timeline.GetUniqueId(), valid_id))
            # Validate the effective rate only after reading explicit inheritance.
            # Getter exceptions still remain errors; a missing value may inherit.
            rate = safe_call("timeline.GetSetting.timelineFrameRate", lambda: timeline.GetSetting("timelineFrameRate"), lambda value: True)
            observed["timeline.GetSetting.timelineFrameRate"] = rate if valid_rate(rate) else None
            custom = safe_call("timeline.GetSetting.useCustomSettings", lambda: timeline.GetSetting("useCustomSettings"), valid_custom_settings)
            observed["timeline.GetSetting.useCustomSettings"] = custom[:NAME_LIMIT] if isinstance(custom, str) else custom if valid_custom_settings(custom) else None
            inherits = custom == "0" or custom is False or type(custom) in (int, float) and custom == 0
            effective_rate = rate if valid_rate(rate) else project_rate if inherits else None
            if not valid_rate(effective_rate):
                call_errors.setdefault("timeline.GetSetting.timelineFrameRate", "invalid required getter result")
            safe_call("timeline.GetStartFrame", lambda: timeline.GetStartFrame(), lambda value: isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value))
            safe_call("timeline.GetStartTimecode", lambda: timeline.GetStartTimecode(), valid_timecode)
            safe_call("timeline.GetCurrentTimecode", lambda: timeline.GetCurrentTimecode(), valid_timecode)

        transfer_api = transfer_api_checks(resolve, storage, pm, project, timeline, media_pool, folder, clip)
        transfer_api["observed"] = observed
        transfer_api["callErrors"] = call_errors
        transfer_api["ok"] = transfer_api["ok"] and not call_errors
        checks["transferApi"] = transfer_api
    except Exception as exc:
        emit({
            "ok": False,
            "checks": checks,
            "readiness": readiness,
            "error": {"code": "probe-failed", "message": sanitize_exc(exc)},
        })
        return 4

    ok = (
        bool(checks.get("version"))
        and bool(checks.get("projectManager"))
        and bool(checks.get("projectList", {}).get("ready"))
        and bool(checks.get("transferApi", {}).get("ok"))
    )
    state = quit_state(resolve)
    emit({
        "ok": ok,
        "checks": checks,
        "readiness": readiness,
        "quitRequested": state["requested"],
        "quitError": state["error"],
    })
    return 0 if ok else 5


if __name__ == "__main__":
    sys.exit(main())
