#!/usr/bin/env python3
"""Regenerates data/ports.json and icons/ from the live GitHub account.

    python tools/build_data.py

Needs the `gh` CLI (logged in, or GH_TOKEN set), Pillow, and 7-Zip for ports that
ship an archive. Only public repos are ever read.

The icon and title come from the .nro itself. A .nro is an executable followed by
an ASET block holding the icon and the NACP, so a couple of HTTP range requests
get them without downloading the whole file. Ports that ship a .zip/.7z are the
exception: those are downloaded and unpacked into a temp folder.
"""
import concurrent.futures as futures
import colorsys
import io
import json
import os
import re
import shutil
import struct
import subprocess
import sys
import tempfile
import urllib.request
import zipfile
from datetime import datetime, timezone
from pathlib import Path

from PIL import Image

OWNER = "ChanseyIsTheBest"
ROOT = Path(__file__).resolve().parent.parent
ICONS = ROOT / "icons"
DATA = ROOT / "data" / "ports.json"
ASSETS = ROOT / "assets"
UA = {"User-Agent": "switch-ports-site-builder"}

# Hand-corrected titles, "what you need" lines and groupings, keyed by port id.
OVERRIDES = json.loads((ROOT / "tools" / "overrides.json").read_text("utf-8"))
# Optional folder of release files laid out as <repo>/releases/<tag>/<file>, such as a
# backup. A copy of the right size is read instead of fetching from GitHub, which saves
# bandwidth and leaves the release's download count alone.
LOCAL_RELEASES = os.environ.get("LOCAL_RELEASES")

QUERY = """
query($cursor: String) {
  user(login: "%s") {
    bio avatarUrl url
    repositories(first: 50, after: $cursor, ownerAffiliations: OWNER, privacy: PUBLIC,
                 orderBy: {field: NAME, direction: ASC}) {
      pageInfo { hasNextPage endCursor }
      nodes {
        name description url isFork isArchived stargazerCount
        parent { nameWithOwner url }
        readme: object(expression: "HEAD:README.md") { ... on Blob { text } }
        releases(first: 40, orderBy: {field: CREATED_AT, direction: DESC}) {
          nodes {
            tagName name url publishedAt isDraft
            releaseAssets(first: 30) { nodes { name size downloadCount downloadUrl } }
          }
        }
      }
    }
  }
}""" % OWNER


def gh(*args):
    r = subprocess.run(["gh", *args], capture_output=True, text=True, encoding="utf-8")
    return r.returncode, r.stdout


def fetch_account():
    repos, cursor, user = [], None, None
    while True:
        args = ["api", "graphql", "-f", f"query={QUERY}"]
        if cursor:
            args += ["-f", f"cursor={cursor}"]
        code, out = gh(*args)
        if code:
            sys.exit("GitHub query failed")
        user = json.loads(out)["data"]["user"]
        page = user["repositories"]
        repos += page["nodes"]
        if not page["pageInfo"]["hasNextPage"]:
            return user, repos
        cursor = page["pageInfo"]["endCursor"]


def pages_url(repo):
    code, out = gh("api", f"repos/{OWNER}/{repo}/pages", "-q", ".html_url")
    return out.strip() if code == 0 and out.strip() else None


# --- reading a .nro -----------------------------------------------------------

def url_reader(url):
    def read(offset, length):
        headers = {**UA, "Range": f"bytes={offset}-{offset + length - 1}"}
        with urllib.request.urlopen(urllib.request.Request(url, headers=headers), timeout=90) as r:
            if r.status != 206:
                raise IOError(f"no range support: {r.status}")
            return r.read()
    return read


def file_reader(path):
    def read(offset, length):
        with open(path, "rb") as f:
            f.seek(offset)
            return f.read(length)
    return read


def parse_nro(read):
    """Returns (icon bytes, nacp title, nacp author) from a .nro."""
    head = read(0, 0x20)
    if head[0x10:0x14] != b"NRO0":
        raise ValueError("not an NRO")
    size = struct.unpack_from("<I", head, 0x18)[0]
    aset = read(size, 0x38)
    if aset[:4] != b"ASET":
        return None, None, None
    icon_off, icon_len, nacp_off, nacp_len = struct.unpack_from("<QQQQ", aset, 8)
    icon = read(size + icon_off, icon_len) if icon_len else None
    title = author = None
    if nacp_len:
        nacp = read(size + nacp_off, nacp_len)
        text = lambda b: b.split(b"\0", 1)[0].decode("utf-8", "replace").strip()
        title, author = text(nacp[:0x200]), text(nacp[0x200:0x300])
    return icon, title, author


def find_7z():
    for candidate in ("7z", "7zz", r"C:\Program Files\7-Zip\7z.exe"):
        found = shutil.which(candidate)
        if found:
            return found
    return None


def nro_from_archive(url, name, local=None):
    """Unpacks an archive into its own empty folder and returns the largest .nro's metadata."""
    workdir = Path(tempfile.mkdtemp(prefix="nro-archive-"))
    try:
        archive = local
        if not archive:
            archive = workdir / Path(name).name
            with urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=600) as r, open(archive, "wb") as f:
                shutil.copyfileobj(r, f)
        out = workdir / "x"
        out.mkdir()
        if name.lower().endswith(".zip"):
            with zipfile.ZipFile(archive) as z:
                members = [m for m in z.namelist() if m.lower().endswith(".nro")]
                z.extractall(out, members)
        else:
            exe = find_7z()
            if not exe:
                raise RuntimeError("7-Zip is needed for " + name)
            subprocess.run([exe, "x", "-y", f"-o{out}", str(archive), "*.nro", "-r"],
                           check=True, capture_output=True)
        nros = sorted(out.rglob("*.nro"), key=lambda p: p.stat().st_size, reverse=True)
        if not nros:
            return None, None, None
        return parse_nro(file_reader(nros[0]))
    finally:
        shutil.rmtree(workdir, ignore_errors=True)


def pick_release(releases):
    """Newest published release with something to run: (release, asset) or (None, None)."""
    for rel in releases:
        if rel["isDraft"]:
            continue
        assets = rel["releaseAssets"]["nodes"]
        for suffix in (".nro", ".7z", ".zip"):
            for asset in assets:
                if asset["name"].lower().endswith(suffix):
                    return rel, asset
    return None, None


def read_release_file(repo_name, rel, asset):
    """(icon, title, author) from a release's .nro, or from the .nro inside its archive."""
    local = None
    if LOCAL_RELEASES:
        candidate = Path(LOCAL_RELEASES) / repo_name / "releases" / rel["tagName"] / asset["name"]
        if candidate.is_file() and candidate.stat().st_size == asset["size"]:
            local = candidate
    if asset["name"].lower().endswith(".nro"):
        return parse_nro(file_reader(local) if local else url_reader(asset["downloadUrl"]))
    return nro_from_archive(asset["downloadUrl"], asset["name"], local)


def games_of(repo):
    """(port id, release-name filter) per game. Usually one, the repo itself; a repo whose
    releases are different games gets a tile each, via games_in_one_repo in overrides.json."""
    games = OVERRIDES["games_in_one_repo"].get(repo["name"])
    return list(games.items()) if games else [(repo["name"], None)]


# --- turning release data into what the page shows ----------------------------

def accent_of(img):
    """The icon's strongest colour, used to tint its detail panel."""
    buckets = {}
    raw = img.convert("RGB").resize((40, 40)).tobytes()
    for i in range(0, len(raw), 3):
        h, s, v = colorsys.rgb_to_hsv(raw[i] / 255, raw[i + 1] / 255, raw[i + 2] / 255)
        weight = s * s * v
        bucket = buckets.setdefault(int(h * 18), [0.0, 0.0])
        bucket[0] += weight
        bucket[1] += h * weight
    weight, total = max(buckets.values(), key=lambda b: b[0])
    if weight < 8:  # greyscale icon
        return "#8a94a6"
    r, g, b = colorsys.hsv_to_rgb(total / weight, 0.72, 0.92)
    return f"#{int(r * 255):02x}{int(g * 255):02x}{int(b * 255):02x}"


def plain(md):
    md = re.sub(r"\[([^\]]+)\]\([^)]*\)", r"\1", md)
    md = re.sub(r"[`*]{1,3}", "", md)
    md = re.sub(r"(?<!\w)_{1,2}|_{1,2}(?!\w)", "", md)  # emphasis, not the _ in file_name.apk
    return md.strip()


def tech_of(readme):
    """'# Papers, Please — Nintendo Switch port (Unity 2022.3 / IL2CPP wrapper)' -> the bracket."""
    for line in (readme or "").splitlines():
        if line.startswith("# ") and "ARCHIVED" not in line:
            m = re.search(r"\(([^()]+)\)\s*$", line)
            return m.group(1) if m else None
    return None


def needs_of(readme):
    """The README's own one-line answer to 'what do I need?'."""
    lines = (readme or "").splitlines()
    for i, line in enumerate(lines):
        line = line.strip().lstrip("> ").strip()
        if not re.match(r"You (?:need|must own|must have)\b", line):
            continue
        paragraph = [line]
        for following in lines[i + 1:]:
            following = following.strip().lstrip("> ").strip()
            if not following or following.startswith(("```", "#", "|", "-", "*")):
                break
            paragraph.append(following)
        text = plain(" ".join(paragraph))
        text = re.split(r"\s+[—–�]\s+", text, maxsplit=1)[0]  # stop at a dash clause
        text = re.sub(r"\s*\(?Content/[^)\s]*\)?", "", text)                   # Xbox content paths
        m = re.match(r"(.+?)(?<!\bVs)(?<!\bV)\.(?:\s|$)", text)                 # "Pizza Vs. Skeletons"
        text = (m.group(1) if m else text).rstrip(":,; ")
        return text + "."
    return None


def archived_note(readme):
    """'# ARCHIVED - Support the official release...' -> the sentence after the dash."""
    m = re.search(r"^#*\s*ARCHIVED\s*[-:—]\s*(.+)$", readme or "", re.M)
    return m.group(1).strip() if m else None


def family_of(repo):
    if repo["name"] in OVERRIDES["family"]:
        return OVERRIDES["family"][repo["name"]]
    text = f"{repo['name']} {repo['description'] or ''}".lower()
    if re.search(r"xbox|recomp|rexglue", text):
        return "recomp"
    readme = (repo["readme"] or {}).get("text") or ""
    if re.search(r"\bandroid\b|\.apk\b|\bapk\b", readme, re.I):
        return "android"
    return "other"


def build_port(repo, port_id, release_filter, installers, previous):
    name = repo["name"]
    readme = (repo["readme"] or {}).get("text") or ""
    releases = [r for r in repo["releases"]["nodes"] if not release_filter or release_filter in (r["name"] or "")]
    rel, asset = pick_release(releases)
    downloads = sum(a["downloadCount"] for r in releases for a in r["releaseAssets"]["nodes"])
    dates = [r["publishedAt"] for r in releases if not r["isDraft"] and r["publishedAt"]]

    icon_path = ICONS / f"{port_id}.webp"
    nacp_title = nacp_author = None
    accent = None
    source = asset["downloadUrl"] if asset else None
    old = previous.get(port_id)

    if source and old and old.get("iconFrom") == source and icon_path.exists():
        nacp_title, nacp_author, accent = old.get("nacpTitle"), old.get("nacpAuthor"), old.get("accent")
    elif source:
        icon, nacp_title, nacp_author = read_release_file(name, rel, asset)
        if icon:
            img = Image.open(io.BytesIO(icon)).convert("RGB")
            if img.size != (256, 256):
                img = img.resize((256, 256), Image.LANCZOS)
            accent = accent_of(img)
            img.save(icon_path, "WEBP", quality=84, method=6)

    has_icon = icon_path.exists() and source is not None
    return {
        "id": port_id,
        "repo": name,
        "title": OVERRIDES["titles"].get(port_id) or nacp_title or port_id,
        "family": family_of(repo),
        "description": OVERRIDES["descriptions"].get(port_id, repo["description"]),
        "tech": tech_of(readme),
        "needs": OVERRIDES["needs"].get(port_id, needs_of(readme)),
        "stars": repo["stargazerCount"],
        "downloads": downloads,
        "version": rel["tagName"] if rel else None,
        "released": rel["publishedAt"] if rel else None,
        "firstReleased": min(dates) if dates else None,
        "repoUrl": repo["url"],
        "releaseUrl": rel["url"] if rel else None,
        "assetName": asset["name"] if asset else None,
        "assetUrl": asset["downloadUrl"] if asset else None,
        "assetSize": asset["size"] if asset else None,
        "installer": installers.get(name),
        "archived": repo["isArchived"],
        "archivedNote": archived_note(readme) if repo["isArchived"] else None,
        "upstream": repo["parent"]["nameWithOwner"] if repo["parent"] else None,
        "icon": f"icons/{port_id}.webp" if has_icon else None,
        "accent": accent,
        "iconFrom": source if has_icon else None,
        "nacpTitle": nacp_title,
        "nacpAuthor": nacp_author,
    }


def write_share_image(ports):
    """A mosaic of the most-downloaded icons for link previews (Discord, etc)."""
    tile, gap = 148, 8
    canvas = Image.new("RGB", (1200, 630), (28, 29, 33))
    tiles = [p for p in sorted(ports, key=lambda p: -p["downloads"]) if p["icon"]]
    for row in range(4):
        for col in range(8):
            index = row * 8 + col
            if index >= len(tiles):
                continue
            img = Image.open(ROOT / tiles[index]["icon"]).convert("RGB").resize((tile, tile), Image.LANCZOS)
            canvas.paste(img, (col * (tile + gap) - 4, row * (tile + gap) + 3))
    canvas.save(ASSETS / "share.jpg", quality=86)


def main():
    ICONS.mkdir(exist_ok=True)
    ASSETS.mkdir(exist_ok=True)
    DATA.parent.mkdir(exist_ok=True)
    previous = {}
    if DATA.exists():
        previous = {p["id"]: p for p in json.loads(DATA.read_text("utf-8"))["ports"]}

    user, repos = fetch_account()
    by_name = {r["name"]: r for r in repos}

    installer_repos = {
        re.sub(r"-(?:web)?installer$", "", n): n
        for n in by_name if re.search(r"-(?:web)?installer$", n)
    }
    with futures.ThreadPoolExecutor(8) as pool:
        urls = dict(zip(installer_repos, pool.map(pages_url, installer_repos.values())))
    installers = {port: url for port, url in urls.items() if url}

    port_repos = [
        r for r in repos
        if r["name"] not in OVERRIDES["hide"] and not re.search(r"-(?:web)?installer$", r["name"])
    ]
    jobs = [(r, port_id, release_filter) for r in port_repos for port_id, release_filter in games_of(r)]
    with futures.ThreadPoolExecutor(8) as pool:
        built = list(pool.map(lambda j: build_port(j[0], j[1], j[2], installers, previous), jobs))

    # A repo with no release has no icon yet, so it joins the page when it gets one.
    ports = [p for p in built if p["icon"]]
    waiting = [p["id"] for p in built if not p["icon"]]

    # Icons of repos that have gone away shouldn't linger.
    keep = {Path(p["icon"]).name for p in ports}
    for stale in ICONS.glob("*.webp"):
        if stale.name not in keep:
            stale.unlink()

    with urllib.request.urlopen(urllib.request.Request(user["avatarUrl"], headers=UA), timeout=60) as r:
        Image.open(io.BytesIO(r.read())).convert("RGB").resize((160, 160), Image.LANCZOS).save(
            ASSETS / "avatar.webp", "WEBP", quality=88)
    write_share_image(ports)

    payload = {
        "generated": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "owner": {"login": OWNER, "bio": user["bio"], "url": user["url"]},
        "totals": {
            "ports": len(ports),
            "downloads": sum(p["downloads"] for p in ports),
            # Per repo, so a repo holding several games counts its stars once.
            "stars": sum({p["repo"]: p["stars"] for p in ports}.values()),
        },
        "ports": ports,
    }
    DATA.write_text(json.dumps(payload, indent=1, ensure_ascii=False) + "\n", "utf-8")

    print(f"{len(ports)} ports, {payload['totals']['downloads']} downloads, {payload['totals']['stars']} stars")
    print("no release to show yet:", waiting)
    for p in sorted(ports, key=lambda p: p["id"].lower()):
        print(f"{p['id']:26} {p['family']:8} icon={'Y' if p['icon'] else '-'} inst={'Y' if p['installer'] else '-'} "
              f"{p['version'] or '-':16} title={p['title']!r} nacp={p['nacpTitle']!r}/{p['nacpAuthor']!r}")
        print(f"{'':24} tech={p['tech']!r} needs={p['needs']!r}")


if __name__ == "__main__":
    main()
