"""3.0 screen share (docs/screen-share.md) — the decisions the native player makes about the three
socket events, with no Qt in them so tests/test_screen_share.py can hold them to the server's contract.

The receiving itself is the server's own /player/screen-share.js running in the WebRTC host page
(ui/rtc_page.py), exactly as Talk runs /player/talk.js there: QtWebEngine is Chromium, so the panel
speaks the web player's protocol byte for byte. This module only turns the events into what that page
and the QML corner badge need.

    device:screenshare-start {session_id, shared_by, guest, max_seconds, ice_servers}
    device:screenshare-stop  {session_id, reason}
    device:screenshare-code  {code, url, qr} | {code: None}
"""

import base64
import re

_SESSION_ID = re.compile(r"^[A-Za-z0-9_-]{1,128}$")
_QR = re.compile(r"^data:image/png;base64,([A-Za-z0-9+/=]+)$")
_PNG_MAGIC = b"\x89PNG\r\n\x1a\n"
_MAX_QR_BYTES = 256 * 1024


def start_opts(d):
    """The options for STScreenShare.start (minus the device credentials, which app.py adds), or None
    when the payload is not a share this player should open."""
    if not isinstance(d, dict):
        return None
    sid = d.get("session_id")
    if not isinstance(sid, str) or not _SESSION_ID.match(sid):
        return None
    shared_by = d.get("shared_by") if isinstance(d.get("shared_by"), str) else ""
    ice = d.get("ice_servers") if isinstance(d.get("ice_servers"), list) else []
    try:
        max_s = int(d.get("max_seconds") or 3600)
    except (TypeError, ValueError):
        max_s = 3600
    return {"sessionId": sid, "sharedBy": shared_by, "guest": bool(d.get("guest")),
            "maxSeconds": max_s, "iceServers": ice}


def stop_applies(current_id, stop_id):
    """A stop for an OLDER share must not end a newer one; a stop with no id ends whatever is up."""
    if not current_id:
        return False
    return not stop_id or stop_id == current_id


def parse_code(d):
    """(code, shown_url, qr_png_bytes or None) for the corner badge, or None to hide it. Only a
    data: PNG is accepted as the QR — the badge never fetches anything."""
    if not isinstance(d, dict):
        return None
    code = d.get("code")
    if not isinstance(code, str) or not code.strip() or len(code) > 32:
        return None
    url = d.get("url") if isinstance(d.get("url"), str) and d.get("url").strip() else "/share"
    shown = re.sub(r"^https?://", "", url, flags=re.I)
    qr = None
    m = _QR.match(d.get("qr") or "") if isinstance(d.get("qr"), str) else None
    if m:
        try:
            raw = base64.b64decode(m.group(1), validate=True)
            if raw.startswith(_PNG_MAGIC) and len(raw) <= _MAX_QR_BYTES:
                qr = raw
        except (ValueError, TypeError):
            qr = None
    return code, shown, qr
