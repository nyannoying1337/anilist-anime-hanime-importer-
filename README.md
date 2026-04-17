## AniList Paste Import

Local, paste-based importer for AniList:

- Paste raw anime titles (one per line)
- Fetch from Hanime.tv playlists
- Preview AniList matches (flag ambiguous/unmatched)
- Sign in with AniList
- Import to your AniList list (creates/updates entries)

### Setup (AniList)

1. Go to AniList Developer settings and **create a new client app**.
2. Set the **redirect URL** to `http://localhost:5173/` (the React dev server URL).
3. Copy your **Client ID**.

### Run locally

1. Install dependencies:
   ```bash
   npm install
   ```

2. Start the Python backend server:
   ```bash
   python server.py
   ```
   This runs on http://localhost:8000/

3. In another terminal, start the React front-end:
   ```bash
   npm run dev
   ```
   This runs on http://localhost:5173/

4. Open http://localhost:5173/ in your browser.

### Features

- **Modern React UI** with animations and responsive design
- **AniList OAuth** authentication
- **Hanime.tv integration** for fetching playlists
- **Real-time preview** of AniList matches
- **Batch import** to your AniList list

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

