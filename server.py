import http.server
import json
import os
import re
import time
import urllib.request
import urllib.parse
import hashlib
from urllib.error import HTTPError, URLError


ANILIST_ENDPOINTS = [
    "https://graphql.anilist.co",
    "https://graphql.anilist.co/",
    "https://graphql.anilist.co/graphql",
]

DEFAULT_UA = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
    "AppleWebKit/537.36 (KHTML, like Gecko) "
    "Chrome/122.0.0.0 Safari/537.36"
)


class RateLimiter:
    """
    Simple global pacing to reduce accidental bursts.
    This is NOT a strict token bucket; it just enforces a minimum gap.
    """

    def __init__(self, min_gap_ms: int = 900):
        self.min_gap_ms = min_gap_ms
        self._last_at = 0.0

    def wait(self):
        now = time.time() * 1000.0
        wait_ms = (self._last_at + self.min_gap_ms) - now
        if wait_ms > 0:
            time.sleep(wait_ms / 1000.0)
        self._last_at = time.time() * 1000.0


rl = RateLimiter(min_gap_ms=900)

def parse_retry_after_ms(value):
    if not value:
        return None
    try:
        s = float(value)
        if s < 0:
            return None
        return min(60_000, int(s * 1000))
    except Exception:
        return None


class Handler(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        # Disable caching for local dev so refresh always loads latest JS/CSS.
        # This avoids “stale app.js” issues when iterating quickly.
        self.send_header("Cache-Control", "no-store, no-cache, must-revalidate, max-age=0")
        self.send_header("Pragma", "no-cache")
        self.send_header("Expires", "0")
        super().end_headers()

    def _send_json(self, code: int, payload):
        raw = json.dumps(payload).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.end_headers()
        self.wfile.write(raw)

    def do_OPTIONS(self):
        if self.path in ("/graphql", "/hanime/playlist", "/hanime/login"):
            self.send_response(204)
            self.send_header("Access-Control-Allow-Origin", "*")
            self.send_header("Access-Control-Allow-Methods", "POST, OPTIONS")
            self.send_header("Access-Control-Allow-Headers", "Content-Type, Authorization, Accept")
            self.end_headers()
            return
        super().do_OPTIONS()

    def do_POST(self):
        path_only = (self.path or "").split("?", 1)[0].rstrip("/")
        if "://" in path_only:
            try:
                path_only = urllib.parse.urlparse(path_only).path.rstrip("/")
            except Exception:
                pass
        if path_only == "/hanime/playlist":
            return self._handle_hanime_playlist()
        if path_only == "/hanime/login":
            return self._handle_hanime_login()
        if path_only != "/graphql":
            return self._send_json(404, {"error": "Not Found", "path": self.path, "pathOnly": path_only})
            return

        length = int(self.headers.get("Content-Length", "0") or "0")
        body = self.rfile.read(length) if length else b""
        try:
            json.loads(body.decode("utf-8") if body else "{}")
        except Exception:
            self.send_error(400, "Invalid JSON")
            return

        auth = self.headers.get("Authorization")
        content_type = self.headers.get("Content-Type", "application/json")
        accept = self.headers.get("Accept", "application/json")
        ua = self.headers.get("User-Agent") or DEFAULT_UA
        accept_lang = self.headers.get("Accept-Language") or "en-US,en;q=0.9"

        last_err = None
        for endpoint in ANILIST_ENDPOINTS:
            try:
                attempt = 0
                while attempt < 6:
                    attempt += 1
                    rl.wait()
                    req = urllib.request.Request(endpoint, data=body, method="POST")
                    req.add_header("Content-Type", content_type)
                    req.add_header("Accept", accept)
                    req.add_header("User-Agent", ua)
                    req.add_header("Accept-Language", accept_lang)
                    if auth:
                        req.add_header("Authorization", auth)

                    try:
                        with urllib.request.urlopen(req, timeout=30) as resp:
                            resp_body = resp.read()
                            if resp.status == 429 and attempt < 6:
                                ra_ms = parse_retry_after_ms(resp.headers.get("Retry-After"))
                                backoff = min(60_000, int(1500 * (2 ** (attempt - 1))))
                                time.sleep(((ra_ms or backoff) + (attempt * 125)) / 1000.0)
                                continue

                            self.send_response(resp.status)
                            self.send_header("Content-Type", resp.headers.get("Content-Type", "application/json"))
                            ra = resp.headers.get("Retry-After")
                            if ra:
                                self.send_header("Retry-After", ra)
                            self.send_header("Access-Control-Allow-Origin", "*")
                            self.end_headers()
                            self.wfile.write(resp_body)
                            return
                    except HTTPError as e:
                        if e.code == 429 and attempt < 6:
                            ra_ms = parse_retry_after_ms(e.headers.get("Retry-After"))
                            backoff = min(60_000, int(1500 * (2 ** (attempt - 1))))
                            time.sleep(((ra_ms or backoff) + (attempt * 125)) / 1000.0)
                            continue
                        raise
            except HTTPError as e:
                # Forward AniList HTTP errors with body (GraphQL errors are still 200; this is mostly 4xx/5xx).
                try:
                    err_body = e.read()
                except Exception:
                    err_body = b""
                self.send_response(e.code)
                self.send_header("Content-Type", e.headers.get("Content-Type", "text/plain"))
                ra = e.headers.get("Retry-After")
                if ra:
                    self.send_header("Retry-After", ra)
                self.send_header("Access-Control-Allow-Origin", "*")
                self.end_headers()
                self.wfile.write(err_body or str(e).encode("utf-8"))
                return
            except (URLError, TimeoutError) as e:
                last_err = e
                continue

        self.send_response(502)
        self.send_header("Content-Type", "text/plain; charset=utf-8")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.end_headers()
        self.wfile.write(f"Upstream error: {last_err}".encode("utf-8"))

    def _handle_hanime_playlist(self):
        length = int(self.headers.get("Content-Length", "0") or "0")
        body = self.rfile.read(length) if length else b""
        try:
            req_json = json.loads(body.decode("utf-8") if body else "{}")
        except Exception:
            return self._send_json(400, {"error": "Invalid JSON"})

        playlist_url = (req_json.get("playlistUrl") or "").strip()
        session_token = (req_json.get("sessionToken") or "").strip()
        debug = bool(req_json.get("debug"))
        if not playlist_url:
            return self._send_json(400, {"error": "playlistUrl is required"})
        if not session_token:
            return self._send_json(400, {"error": "sessionToken is required"})

        try:
            titles, total_hint, dbg = fetch_hanime_playlist_titles(playlist_url, session_token, debug=debug)
            payload = {"titles": titles, "totalHint": total_hint}
            if debug:
                payload["debug"] = dbg
            return self._send_json(200, payload)
        except Exception as e:
            return self._send_json(502, {"error": str(e)})

    def _handle_hanime_login(self):
        length = int(self.headers.get("Content-Length", "0") or "0")
        body = self.rfile.read(length) if length else b""
        try:
            req_json = json.loads(body.decode("utf-8") if body else "{}")
        except Exception:
            return self._send_json(400, {"error": "Invalid JSON"})

        email = (req_json.get("email") or "").strip()
        password = (req_json.get("password") or "").strip()
        if not email or not password:
            return self._send_json(400, {"error": "email and password are required"})

        try:
            token = hanime_login(email, password)
            if not token:
                return self._send_json(502, {"error": "Login succeeded but no session token returned"})
            return self._send_json(200, {"sessionToken": token})
        except Exception as e:
            return self._send_json(502, {"error": str(e)})


def main():
    port = int(os.environ.get("PORT", "5173"))
    server = http.server.ThreadingHTTPServer(("0.0.0.0", port), Handler)
    print(f"Serving on http://localhost:{port}/ (with /graphql proxy)")
    server.serve_forever()

def _hanime_web_headers(session_token: str):
    t = str(int(time.time()))
    return {
        "User-Agent": DEFAULT_UA,
        "Accept": "application/json, text/plain, */*",
        "Accept-Language": "en-US,en;q=0.9",
        "x-time": t,
        "x-signature-version": "web2",
        "x-session-token": session_token,
    }

def _hanime_app_signature(t: int) -> str:
    # Ported from @nekolab/hanime (Haniversity/hanime) getAppSignature():
    # sha256("994482" + `2${t}8${t}` + "113")
    s = f"9944822{t}8{t}113".encode("utf-8")
    return hashlib.sha256(s).hexdigest()


def hanime_login(email: str, password: str) -> str:
    t = int(time.time())
    url = "https://www.universal-cdn.com/rapi/v4/sessions"
    headers = {
        "User-Agent": DEFAULT_UA,
        "Accept": "application/json, text/plain, */*",
        "Content-Type": "application/json",
        "x-claim": str(t),
        "x-signature-version": "app2",
        "x-signature": _hanime_app_signature(t),
        "x-session-token": "",
    }
    payload = {"burger": email, "fries": password}
    req = urllib.request.Request(
        url,
        data=json.dumps(payload).encode("utf-8"),
        headers=headers,
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            raw = resp.read()
            j = _try_parse_json(raw)
            if isinstance(j, dict) and isinstance(j.get("session_token"), str):
                return j["session_token"]
            if isinstance(j, dict) and isinstance(j.get("sessionToken"), str):
                return j["sessionToken"]
            raise RuntimeError("Unexpected login response")
    except HTTPError as e:
        try:
            err_body = e.read().decode("utf-8", errors="replace")
        except Exception:
            err_body = ""
        snippet = re.sub(r"\s+", " ", err_body).strip()[:240]
        raise RuntimeError(f"Login failed (HTTP {e.code}): {snippet or 'Unknown error'}")


def _extract_hanime_session_token(token_or_cookie: str) -> str:
    v = (token_or_cookie or "").strip()
    if not v:
        return ""

    # Allow pasting "htv3session=..." or "Cookie: ...; htv3session=...; ..."
    m = re.search(r"(?:^|;\s*|cookie:\s*)htv3session=([^;]+)", v, re.I)
    if m:
        return m.group(1).strip()

    # Allow pasting "x-session-token: <token>"
    m2 = re.search(r"(?:^|\s*)x-session-token\s*:\s*([^\s]+)", v, re.I)
    if m2:
        return m2.group(1).strip()

    # Otherwise assume it's already the raw token value
    return v


def _http_get(url: str, headers: dict, timeout: int = 30):
    req = urllib.request.Request(url, method="GET")
    for k, v in (headers or {}).items():
        if v is None:
            continue
        req.add_header(k, v)
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return resp.status, resp.headers, resp.read()


def _try_parse_json(raw: bytes):
    try:
        return json.loads(raw.decode("utf-8"))
    except Exception:
        return None


def _normalize_title(s: str) -> str:
    return re.sub(r"\s+", " ", (s or "").strip())


def _dedupe_keep_order(items):
    seen = set()
    out = []
    for it in items:
        key = _normalize_title(it).lower()
        if not key or key in seen:
            continue
        seen.add(key)
        out.append(_normalize_title(it))
    return out


def _extract_playlist_id(playlist_url: str) -> str:
    u = urllib.parse.urlparse(playlist_url)
    if u.netloc and "hanime.tv" not in u.netloc:
        raise ValueError("playlistUrl must be on hanime.tv")
    parts = [p for p in u.path.split("/") if p]
    if len(parts) >= 2 and parts[0] == "playlists":
        return parts[1]
    raise ValueError("playlistUrl must look like https://hanime.tv/playlists/<playlist_id>")


def _extract_titles_from_html(html: str):
    # The playlist page contains links like:
    # <a href="https://hanime.tv/videos/hentai/<slug>?playlist_id=<id>">TitleBrand1,234 views</a>
    titles = []
    # Pull anchor text for links that include playlist_id=<id>
    for m in re.finditer(
        r'href="(?:https?://hanime\.tv)?/videos/hentai/[^"]+\?playlist_id=[^"]+"[^>]*>(.*?)</a>',
        html,
        re.I | re.S,
    ):
        inner = m.group(1) or ""
        # Strip any nested tags inside the link text.
        txt = re.sub(r"<[^>]+>", " ", inner)
        txt = re.sub(r"\s+", " ", txt).strip()
        if not txt:
            continue
        s = txt
        # Drop trailing "... views"
        s = re.sub(r"\s*\d[\d,\.]*\s*views\s*$", "", s, flags=re.I).strip()
        # Many entries look like Title + Brand stuck together; insert a separator before brand by removing a trailing brand token
        # Heuristic: if it ends with a capitalized word and no space before it, we can't reliably split; leave as-is.
        titles.append(s)
    return _dedupe_keep_order(titles)


def _extract_total_hint_from_html(html: str):
    m = re.search(r"(\d+)\s+videos\b", html, re.I)
    if not m:
        return None
    try:
        return int(m.group(1))
    except Exception:
        return None


def _discover_playlist_api_candidates_from_html(html: str, playlist_id: str):
    """
    Try to find the internal API endpoints used for the playlist "Show more" button.
    Returns list of URL templates that may accept offset/count or page params.
    """
    candidates = []
    # Look for any rapi/api URLs mentioning playlists and this playlist id.
    # We accept both absolute and relative URLs and later normalize to absolute.
    patterns = [
        r'(?:"|\')((?:https?:)?//[^"\']+/(?:rapi|api)/[^"\']*playlists[^"\']*' + re.escape(playlist_id) + r'[^"\']*)(?:"|\')',
        r'(?:"|\')(/(?:rapi|api)/[^"\']*playlists[^"\']*' + re.escape(playlist_id) + r'[^"\']*)(?:"|\')',
    ]
    for pat in patterns:
        for m in re.finditer(pat, html, re.I):
            u = m.group(1)
            if not u:
                continue
            u = u.strip()
            # Normalize protocol-relative URLs
            if u.startswith("//"):
                u = "https:" + u
            candidates.append(u)

    # If nothing explicit found, add a few more common endpoint guesses tied to playlist_id.
    if not candidates:
        candidates.extend([
            f"/rapi/v7/playlists/{playlist_id}",
            f"/rapi/v7/playlists/{playlist_id}/items",
            f"/rapi/v7/playlists/{playlist_id}/hentai_videos",
        ])

    # Deduplicate while keeping order
    out = []
    seen = set()
    for u in candidates:
        key = u.lower()
        if key in seen:
            continue
        seen.add(key)
        out.append(u)
    return out


def _normalize_hanime_api_url(u: str):
    if u.startswith("http://") or u.startswith("https://"):
        return u
    # Prefer hanime.tv for relative URLs
    if u.startswith("/"):
        return "https://hanime.tv" + u
    return "https://hanime.tv/" + u


def fetch_hanime_playlist_titles(playlist_url: str, session_token: str, debug: bool = False):
    playlist_id = _extract_playlist_id(playlist_url)
    token = _extract_hanime_session_token(session_token)
    if not token:
        raise ValueError("Missing Hanime session token")

    headers = _hanime_web_headers(token)
    # Some endpoints may also require the cookie form.
    headers["Cookie"] = f"htv3session={token}"

    def _extract_titles_from_json_payload(j: dict):
        def _collect_from_list(arr):
            out = []
            for it in arr:
                if isinstance(it, str):
                    out.append(it)
                    continue
                if isinstance(it, dict):
                    # Direct flattened fields sometimes appear in hanime payloads
                    for k in ("hentai_video_name", "hentai_video_title", "video_name", "video_title", "name", "title"):
                        if isinstance(it.get(k), str):
                            out.append(it[k])
                            break
                    else:
                        pass

                    hv = it.get("hentai_video")
                    if isinstance(hv, dict):
                        nm = hv.get("name") or hv.get("title")
                        if isinstance(nm, str):
                            out.append(nm)
                            continue
                    if isinstance(hv, str):
                        out.append(hv)
                        continue
                    # Sometimes the video object is under "video" or "hentaiVideo"
                    for k in ("video", "hentaiVideo", "hentai_video"):
                        v = it.get(k)
                        if isinstance(v, dict):
                            nm2 = v.get("name") or v.get("title")
                            if isinstance(nm2, str):
                                out.append(nm2)
                                break
            return out

        def _collect_from_any(value):
            if isinstance(value, list):
                return _collect_from_list(value)
            if isinstance(value, dict):
                # Common pagination containers
                for k in (
                    "results",
                    "items",
                    "records",
                    "data",
                    "hentai_videos",
                    "playlist_hentai_videos",
                    "like_dislike_playlist_hentai_videos",
                    "watch_later_playlist_hentai_videos",
                    "videos",
                    # observed in debug (truncated in UI): x_playlist_hent...
                    "x_playlist_hentai_videos",
                    "x_playlist_hentais",
                ):
                    v = value.get(k)
                    if isinstance(v, list):
                        got = _collect_from_list(v)
                        if got:
                            return got
                # Last resort: scan for any list-like child
                for v in value.values():
                    if isinstance(v, list):
                        got = _collect_from_list(v)
                        if got:
                            return got
            return []

        # Prefer known playlist item arrays from hanime.tv responses.
        priority_keys = (
            "like_dislike_playlist_hentai_videos",
            "playlist_hentai_videos",
            "watch_later_playlist_hentai_videos",
            "playlist_videos",  # often a dict container, not a list
        )
        found = []

        for k in priority_keys:
            found.extend(_collect_from_any(j.get(k)))

        # Fallback: check more generic keys.
        for key in ("items", "hentaiVideos", "hentai_videos", "videos", "results", "data"):
            found.extend(_collect_from_any(j.get(key)))

        pl = j.get("playlist")
        if isinstance(pl, dict):
            for key in ("items", "hentaiVideos", "hentai_videos", "videos"):
                found.extend(_collect_from_any(pl.get(key)))

        return _dedupe_keep_order(found)

    def _extract_total_hint_from_json_payload(j: dict):
        # Try a few common keys.
        for k in ("total", "totalCount", "total_count", "count"):
            if isinstance(j.get(k), int):
                return j.get(k)
        # Some playlist endpoints include a paging container with a more reliable record count.
        pv = j.get("playlist_videos")
        if isinstance(pv, dict):
            for k in ("num_records", "numRecords", "total", "total_count", "totalCount", "count"):
                if isinstance(pv.get(k), int):
                    return pv.get(k)
        pl = j.get("playlist")
        if isinstance(pl, dict):
            if isinstance(pl.get("count"), int):
                return pl.get("count")
            for k in ("total", "totalCount", "total_count", "count"):
                if isinstance(pl.get(k), int):
                    return pl.get(k)
        return None

    # 1) Try likely JSON endpoints (preferred for pagination)
    # Hanime seems to page playlists with either offset/count or page params depending on endpoint.
    # We try multiple variants to be resilient.
    url_templates = [
        # Most likely to page videos:
        f"https://hanime.tv/rapi/v7/playlists/{playlist_id}/hentai_videos?offset={{offset}}&count={{count}}",
        f"https://hanime.tv/rapi/v7/playlists/{playlist_id}/items?offset={{offset}}&count={{count}}",
        # offset/count variants
        f"https://hanime.tv/rapi/v7/playlists/{playlist_id}?offset={{offset}}&count={{count}}",
        f"https://www.universal-cdn.com/api/v8/playlists/{playlist_id}?offset={{offset}}&count={{count}}",
        f"https://www.universal-cdn.com/rapi/v4/playlists/{playlist_id}?offset={{offset}}&count={{count}}",
        # page variants
        f"https://hanime.tv/rapi/v7/playlists/{playlist_id}?page={{page}}&count={{count}}",
        f"https://hanime.tv/rapi/v7/playlists/{playlist_id}?p={{page}}&count={{count}}",
    ]

    dbg = {
        "playlistId": playlist_id,
        "attempts": [],
        "htmlDiscoveredCandidates": [],
        "urlTemplates": url_templates[:],
    } if debug else None

    titles = []
    total_hint = None
    for tpl in url_templates:
        try:
            offset = 0
            page = 0
            count = 48
            collected = []
            first_page = None
            # Hard cap to avoid infinite loops if the endpoint ignores offset/count.
            for _ in range(0, 20):
                url = tpl.format(offset=offset, count=count, page=page)
                status, _hdrs, raw = _http_get(url, headers=headers)
                if status != 200:
                    if debug:
                        dbg["attempts"].append({"url": url, "status": status, "note": "non-200"})
                    break
                j = _try_parse_json(raw)
                if not isinstance(j, dict):
                    if debug:
                        dbg["attempts"].append({"url": url, "status": status, "note": "non-json"})
                    break
                if debug:
                    # Record a small structural summary to adapt the parser without leaking huge payloads.
                    keys = list(j.keys())[:40]
                    shape = {}
                    for k in (
                        "items",
                        "hentaiVideos",
                        "hentai_videos",
                        "videos",
                        "results",
                        "data",
                        "playlist",
                        # hanime.tv playlist-specific arrays
                        "playlist_videos",
                        "playlist_hentai_videos",
                        "like_dislike_playlist_hentai_videos",
                        "watch_later_playlist_hentai_videos",
                    ):
                        v = j.get(k)
                        if isinstance(v, list):
                            shape[k] = {"type": "list", "len": len(v)}
                            if v and isinstance(v[0], dict):
                                shape[k]["itemKeys"] = list(v[0].keys())[:20]
                        elif isinstance(v, dict):
                            shape[k] = {"type": "dict", "keys": list(v.keys())[:25]}
                        elif v is not None:
                            shape[k] = {"type": type(v).__name__}
                if total_hint is None:
                    th = _extract_total_hint_from_json_payload(j)
                    if isinstance(th, int):
                        total_hint = th

                # If available, use Hanime's own pagination metadata to drive the loop.
                pv = j.get("playlist_videos")
                pv_page = pv.get("page") if isinstance(pv, dict) else None
                pv_pages = pv.get("num_pages") if isinstance(pv, dict) else None
                pv_size = pv.get("page_size") if isinstance(pv, dict) else None
                if isinstance(pv_size, int) and pv_size > 0:
                    count = pv_size

                page_titles = _extract_titles_from_json_payload(j)
                if not page_titles:
                    if debug:
                        dbg["attempts"].append({
                            "url": url,
                            "status": status,
                            "note": "no-titles",
                            "jsonKeys": keys if debug else None,
                            "shape": shape if debug else None,
                        })
                    break

                # Detect endpoints that ignore paging and just repeat the first page.
                if first_page is None:
                    first_page = page_titles[:]
                elif page_titles == first_page:
                    if debug:
                        dbg["attempts"].append({
                            "url": url,
                            "status": status,
                            "note": "repeats-first-page",
                            "returnedCount": len(page_titles),
                        })
                    # Consider this endpoint non-pageable; stop and try next template.
                    collected = []
                    break

                before = len(collected)
                collected = _dedupe_keep_order(collected + page_titles)
                if len(collected) == before:
                    if debug:
                        dbg["attempts"].append({
                            "url": url,
                            "status": status,
                            "note": "no-growth",
                            "returnedCount": len(page_titles),
                            "first": page_titles[0] if page_titles else None,
                            "last": page_titles[-1] if page_titles else None,
                        })
                    break
                if debug:
                    dbg["attempts"].append({
                        "url": url,
                        "status": status,
                        "note": "ok",
                        "returnedCount": len(page_titles),
                        "collected": len(collected),
                        "first": page_titles[0] if page_titles else None,
                        "last": page_titles[-1] if page_titles else None,
                    })
                # Stop if we've likely got everything.
                if total_hint is not None and len(collected) >= int(total_hint):
                    break
                # Prefer explicit pagination info when present.
                if isinstance(pv_page, int) and isinstance(pv_pages, int) and pv_pages > 0:
                    if pv_page >= pv_pages - 1:
                        break
                    page = pv_page + 1
                    offset = page * (count if isinstance(count, int) else 0)
                    continue

                # Fallback increments (when pv metadata is missing)
                offset += count
                page += 1
            if collected:
                titles = collected
                break
        except Exception:
            continue

    # 2) Fallback: fetch HTML and parse titles visible in markup.
    if not titles:
        status, _hdrs, raw = _http_get(
            playlist_url,
            headers={
                "User-Agent": DEFAULT_UA,
                "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
                "Accept-Language": "en-US,en;q=0.9",
            },
        )
        if status != 200:
            raise RuntimeError(f"Failed to load playlist page (HTTP {status})")
        html = raw.decode("utf-8", errors="replace")
        total_hint = _extract_total_hint_from_html(html)
        titles = _extract_titles_from_html(html)

        # If the playlist clearly has more than the first-page HTML, try to discover and call the
        # same API the "Show more" button uses.
        if total_hint and len(titles) and len(titles) < int(total_hint):
            api_candidates = _discover_playlist_api_candidates_from_html(html, playlist_id)
            if debug:
                dbg["htmlDiscoveredCandidates"] = api_candidates[:]
            # Convert candidates into URL templates that we can page.
            discovered_templates = []
            for c in api_candidates:
                u = _normalize_hanime_api_url(c)
                # If it already has offset/count, replace numeric values with placeholders.
                u2 = re.sub(r"([?&]offset=)\d+", r"\g<1>{offset}", u, flags=re.I)
                u2 = re.sub(r"([?&]count=)\d+", r"\g<1>{count}", u2, flags=re.I)
                u2 = re.sub(r"([?&]page=)\d+", r"\g<1>{page}", u2, flags=re.I)
                u2 = re.sub(r"([?&]p=)\d+", r"\g<1>{page}", u2, flags=re.I)
                # Ensure we have some paging params; if not, append offset/count.
                if "{offset}" not in u2 and "{page}" not in u2:
                    sep = "&" if "?" in u2 else "?"
                    u2 = f"{u2}{sep}offset={{offset}}&count={{count}}"
                elif "{count}" not in u2:
                    sep = "&" if "?" in u2 else "?"
                    u2 = f"{u2}{sep}count={{count}}"
                discovered_templates.append(u2)

            # Try paging each discovered template.
            for tpl in discovered_templates:
                try:
                    offset = 0
                    page = 0
                    count = 48
                    collected = titles[:]  # start with first page
                    for _ in range(0, 40):
                        url = tpl.format(offset=offset, count=count, page=page)
                        status2, _hdrs2, raw2 = _http_get(url, headers=headers)
                        if status2 != 200:
                            if debug:
                                dbg["attempts"].append({"url": url, "status": status2, "note": "discovered-non-200"})
                            break
                        j2 = _try_parse_json(raw2)
                        if not isinstance(j2, dict):
                            if debug:
                                dbg["attempts"].append({"url": url, "status": status2, "note": "discovered-non-json"})
                            break
                        page_titles2 = _extract_titles_from_json_payload(j2)
                        if not page_titles2:
                            if debug:
                                dbg["attempts"].append({"url": url, "status": status2, "note": "discovered-no-titles"})
                            break
                        before2 = len(collected)
                        collected = _dedupe_keep_order(collected + page_titles2)
                        if len(collected) == before2:
                            if debug:
                                dbg["attempts"].append({
                                    "url": url,
                                    "status": status2,
                                    "note": "discovered-no-growth",
                                    "returnedCount": len(page_titles2),
                                    "first": page_titles2[0] if page_titles2 else None,
                                    "last": page_titles2[-1] if page_titles2 else None,
                                })
                            break
                        if debug:
                            dbg["attempts"].append({
                                "url": url,
                                "status": status2,
                                "note": "discovered-ok",
                                "returnedCount": len(page_titles2),
                                "collected": len(collected),
                                "first": page_titles2[0] if page_titles2 else None,
                                "last": page_titles2[-1] if page_titles2 else None,
                            })
                        if total_hint is not None and len(collected) >= int(total_hint):
                            break
                        offset += count
                        page += 1
                    if len(collected) > len(titles):
                        titles = collected
                        break
                except Exception:
                    continue

        # Final fallback: some environments render additional playlist pages server-side via query params
        # (even if the main UI uses a "Show more" button). Try common paging params on the HTML page itself.
        if total_hint and len(titles) and len(titles) < int(total_hint):
            def _with_query(url: str, extra: dict):
                u = urllib.parse.urlparse(url)
                q = dict(urllib.parse.parse_qsl(u.query, keep_blank_values=True))
                q.update(extra)
                new_q = urllib.parse.urlencode(q)
                return urllib.parse.urlunparse((u.scheme, u.netloc, u.path, u.params, new_q, u.fragment))

            html_headers = {
                "User-Agent": DEFAULT_UA,
                "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
                "Accept-Language": "en-US,en;q=0.9",
            }

            collected = titles[:]
            # Try page-based, then offset-based.
            page_param_sets = [
                {"page": "0"},
                {"p": "0"},
            ]
            # If page 0 already matches base, start from 1.
            for page in range(1, 50):
                grew = False
                for base_params in page_param_sets:
                    params = dict(base_params)
                    # overwrite page value
                    k = "page" if "page" in params else "p"
                    params[k] = str(page)
                    paged_url = _with_query(playlist_url, params)
                    try:
                        st, _h, rawp = _http_get(paged_url, headers=html_headers)
                        if st != 200:
                            continue
                        htmlp = rawp.decode("utf-8", errors="replace")
                        more = _extract_titles_from_html(htmlp)
                        before = len(collected)
                        collected = _dedupe_keep_order(collected + more)
                        if len(collected) > before:
                            grew = True
                        if total_hint is not None and len(collected) >= int(total_hint):
                            break
                    except Exception:
                        continue
                if total_hint is not None and len(collected) >= int(total_hint):
                    break
                if not grew:
                    # No new titles found on this page across param styles; stop.
                    break

            if len(collected) > len(titles):
                titles = collected

    return titles, total_hint, dbg


if __name__ == "__main__":
    main()

