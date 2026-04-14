## AniList Paste Import

Local, paste-based importer for AniList:

- Paste raw anime titles (one per line)
- Preview AniList matches (flag ambiguous/unmatched)
- Sign in with AniList
- Import to your AniList list (creates/updates entries)

### Setup (AniList)

1. Go to AniList Developer settings and **create a new client app**.
2. Set the **redirect URL** to whichever URL you will use to open this tool, for example:
   - `http://localhost:5173/` (recommended if you serve it locally), or
   - `http://127.0.0.1:5173/`
3. Copy your **Client ID**.

Important: for the **implicit** OAuth flow AniList redirects to the URL configured in your AniList app settings (this tool does not send a `redirect_uri` query param).

### Run locally

AniList’s GraphQL endpoint does **not** allow browser CORS, so you need a tiny local server that also proxies `/graphql`.

If you have Python:

```bash
cd anilist-paste-import
python server.py
```

Then open:
- `http://localhost:5173/`

### Configure

Open the app, click **Settings**, and paste your **AniList Client ID**.

### Notes

- This uses AniList OAuth **implicit flow** (token stored in `localStorage`).
- The app never sees your password; authentication happens on AniList.
- Ambiguous titles are *not* imported until you choose the correct match.

