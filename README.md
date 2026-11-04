# ChanseyIsTheBest · Switch Ports

A static page listing every Nintendo Switch port on this account, using the icon
from each port's `.nro`. Plain HTML, CSS and JavaScript with no build step.

## Refreshing the list

```bash
python tools/build_data.py
```

This reads the account's public repos and latest releases, then rewrites
`data/ports.json` and `icons/`. It needs the `gh` CLI, Pillow, and 7-Zip for ports
that ship a `.7z`. New repos are picked up automatically.

Icons come from the `.nro` itself, read with HTTP range requests so the whole file
isn't downloaded. Ports that ship an archive are downloaded and unpacked to a temp
folder. A repo with no release has no icon yet, so it joins the page once it has one.

Only new releases are read. To read them from a local backup instead of GitHub, which
also leaves their download counts alone, point `LOCAL_RELEASES` at a folder laid out as
`<repo>/releases/<tag>/<file>`:

```bash
LOCAL_RELEASES=path/to/backup/repositories python tools/build_data.py
```

## Adding, removing or correcting a port

Edit `tools/overrides.json`, then run the script again:

| Key | Purpose |
| --- | --- |
| `hide` | Repos to leave off the page. Remove a name to show it. |
| `games_in_one_repo` | For a repo whose releases are different games: port id to a piece of text in the release name. Each game gets its own tile, using its newest matching release. |
| `titles` | Display name, if the one in the `.nro` isn't right. Keyed by port id. |
| `descriptions` | Replaces the GitHub description. Keyed by port id. |
| `needs` | Replaces the "What you need" line taken from the README. Keyed by port id. |
| `family` | Group: `recomp`, `android` or `native`. Keyed by repo. |

A port's id is its repo name, unless `games_in_one_repo` gives it another.

## Local preview

```bash
python -m http.server 8765
```
