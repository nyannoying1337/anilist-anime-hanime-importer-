import React, { useState, useEffect } from 'react';
import './App.css';

const STORAGE_KEYS = {
  clientId: "anilistPasteImport.clientId",
  token: "anilistPasteImport.accessToken",
  tokenCreatedAt: "anilistPasteImport.tokenCreatedAt",
  hanimeSessionToken: "anilistPasteImport.hanime.sessionToken",
  hanimeLastPlaylistUrl: "anilistPasteImport.hanime.lastPlaylistUrl",
  hanimeEmail: "anilistPasteImport.hanime.email",
  hideExisting: "anilistPasteImport.preview.hideExisting",
  filterMatched: "anilistPasteImport.preview.filter.matched",
  filterAmbiguous: "anilistPasteImport.preview.filter.ambiguous",
  filterUnmatched: "anilistPasteImport.preview.filter.unmatched",
  draftTitles: "anilistPasteImport.draft.titles",
  previewCache: "anilistPasteImport.preview.cache.v2",
};

const ANILIST = {
  authUrl: "https://anilist.co/api/v2/oauth/authorize",
  graphqlUrl: "https://graphql.anilist.co",
  graphqlLocalProxyPath: "/graphql",
};

function App() {
  const [titles, setTitles] = useState('');
  const [previewData, setPreviewData] = useState([]);
  const [isAuthenticated, setIsAuthenticated] = useState(false);
  const [showSourceDialog, setShowSourceDialog] = useState(false);
  const [showSettingsDialog, setShowSettingsDialog] = useState(false);
  const [showLogDialog, setShowLogDialog] = useState(false);
  const [activeTab, setActiveTab] = useState('paste');
  const [settingsTab, setSettingsTab] = useState('anilist');
  const [clientId, setClientId] = useState('');
  const [hanimeSessionToken, setHanimeSessionToken] = useState('');
  const [hanimeEmail, setHanimeEmail] = useState('');
  const [hanimePassword, setHanimePassword] = useState('');
  const [hanimePlaylistUrl, setHanimePlaylistUrl] = useState('');
  const [hanimeFillOnly, setHanimeFillOnly] = useState(false);
  const [log, setLog] = useState('');
  const [isWorking, setIsWorking] = useState(false);

  useEffect(() => {
    // Load settings from localStorage
    setClientId(localStorage.getItem(STORAGE_KEYS.clientId) || '');
    setHanimeSessionToken(localStorage.getItem(STORAGE_KEYS.hanimeSessionToken) || '');
    setHanimeEmail(localStorage.getItem(STORAGE_KEYS.hanimeEmail) || '');
    setHanimePlaylistUrl(localStorage.getItem(STORAGE_KEYS.hanimeLastPlaylistUrl) || '');
    setTitles(localStorage.getItem(STORAGE_KEYS.draftTitles) || '');

    // Check if authenticated
    const token = localStorage.getItem(STORAGE_KEYS.token);
    if (token) {
      setIsAuthenticated(true);
    }

    // Handle OAuth callback
    const urlParams = new URLSearchParams(window.location.search);
    const code = urlParams.get('code');
    if (code) {
      handleAuthCallback(code);
    }
  }, []);

  const handleAuthCallback = async (code) => {
    try {
      const response = await fetch('/graphql', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          query: `
            mutation {
              accessToken(code: "${code}", clientId: "${clientId}") {
                access_token
              }
            }
          `
        })
      });
      const data = await response.json();
      if (data.data?.accessToken?.access_token) {
        localStorage.setItem(STORAGE_KEYS.token, data.data.accessToken.access_token);
        localStorage.setItem(STORAGE_KEYS.tokenCreatedAt, Date.now().toString());
        setIsAuthenticated(true);
        // Clean URL
        window.history.replaceState({}, document.title, window.location.pathname);
        addLog('Successfully signed in to AniList');
      }
    } catch (error) {
      addLog('Failed to authenticate: ' + error.message);
    }
  };

  const handleSignIn = () => {
    if (!clientId) {
      alert('Please set your AniList Client ID in Settings first');
      return;
    }
    const redirectUri = encodeURIComponent(window.location.origin);
    window.location.href = `${ANILIST.authUrl}?client_id=${clientId}&redirect_uri=${redirectUri}&response_type=code`;
  };

  const handleSignOut = () => {
    localStorage.removeItem(STORAGE_KEYS.token);
    localStorage.removeItem(STORAGE_KEYS.tokenCreatedAt);
    setIsAuthenticated(false);
    addLog('Signed out from AniList');
  };

  const handleImport = async () => {
    if (!isAuthenticated) {
      alert('Please sign in to AniList first');
      return;
    }
    if (previewData.length === 0) {
      alert('Please preview some titles first');
      return;
    }
    setIsWorking(true);
    try {
      // Filter only matched items
      const matchedItems = previewData.filter(item => item.matched && item.anilistId);
      
      for (const item of matchedItems) {
        await addToAniList(item.anilistId, item.status, localStorage.getItem(STORAGE_KEYS.token));
        addLog(`Added "${item.anilistTitle}" to AniList`);
      }
      
      addLog(`Import completed: ${matchedItems.length} items added`);
    } catch (error) {
      addLog('Import failed: ' + error.message);
    } finally {
      setIsWorking(false);
    }
  };

  const handleHanimeLogin = async () => {
    if (!hanimeEmail || !hanimePassword) {
      alert('Please enter email and password');
      return;
    }
    setIsWorking(true);
    try {
      const response = await fetch('/hanime/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email: hanimeEmail,
          password: hanimePassword
        })
      });
      const data = await response.json();
      if (data.sessionToken) {
        setHanimeSessionToken(data.sessionToken);
        localStorage.setItem(STORAGE_KEYS.hanimeSessionToken, data.sessionToken);
        addLog('Successfully logged in to Hanime');
      } else {
        addLog('Hanime login failed');
      }
    } catch (error) {
      addLog('Hanime login error: ' + error.message);
    } finally {
      setIsWorking(false);
    }
  };

  const handleFetchHanime = async () => {
    if (!hanimeSessionToken && (!hanimeEmail || !hanimePassword)) {
      alert('Please provide Hanime session token or login credentials in Settings');
      return;
    }
    setIsWorking(true);
    try {
      const response = await fetch('/hanime/fetch', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          url: hanimePlaylistUrl,
          sessionToken: hanimeSessionToken,
          email: hanimeEmail,
          password: hanimePassword
        })
      });
      const data = await response.json();
      if (data.titles) {
        setTitles(data.titles.join('\n'));
        localStorage.setItem(STORAGE_KEYS.draftTitles, data.titles.join('\n'));
        localStorage.setItem(STORAGE_KEYS.hanimeLastPlaylistUrl, hanimePlaylistUrl);
        addLog(`Fetched ${data.titles.length} titles from Hanime`);
        if (!hanimeFillOnly) {
          handlePreview();
        }
      }
    } catch (error) {
      addLog('Hanime fetch failed: ' + error.message);
    } finally {
      setIsWorking(false);
    }
  };

  const handleSaveSettings = () => {
    localStorage.setItem(STORAGE_KEYS.clientId, clientId);
    localStorage.setItem(STORAGE_KEYS.hanimeSessionToken, hanimeSessionToken);
    localStorage.setItem(STORAGE_KEYS.hanimeEmail, hanimeEmail);
    addLog('Settings saved');
    setShowSettingsDialog(false);
  };

  const addLog = (message) => {
    const timestamp = new Date().toLocaleTimeString();
    setLog(prev => `${timestamp}: ${message}\n${prev}`);
  };

  return (
    <div className="app">
      {isWorking && (
        <div className="working-banner">
          <div className="working-banner-inner">
            <div className="working-banner-title">Working…</div>
            <div>Operation in progress. Don't close or refresh this page.</div>
          </div>
        </div>
      )}

      <header className="top-bar">
        <div className="top-bar-left">
          <h1 className="title">AniList Paste Import</h1>
          <p className="subtitle">Fetch/paste → preview → import</p>
        </div>
        <div className="top-bar-right">
          <button className="btn secondary" onClick={() => setShowSourceDialog(true)}>Source</button>
          <button className="btn secondary" onClick={() => setShowSettingsDialog(true)}>Settings</button>
          <button className="btn secondary" onClick={() => setShowLogDialog(true)}>Log</button>
          <select className="status-select">
            <option value="COMPLETED">Completed</option>
            <option value="PLANNING">Planning</option>
            <option value="CURRENT">Watching</option>
            <option value="PAUSED">Paused</option>
            <option value="DROPPED">Dropped</option>
            <option value="REPEATING">Repeating</option>
          </select>
          <button className="btn primary" onClick={handlePreview} disabled={isWorking}>Preview</button>
          <button className="btn secondary" onClick={handleImport} disabled={isWorking || previewData.length === 0}>Import</button>
          <button className="btn secondary" onClick={isAuthenticated ? handleSignOut : handleSignIn}>
            {isAuthenticated ? 'Sign out' : 'Sign in'}
          </button>
        </div>
      </header>

      <main className="workspace">
        <div className="workspace-header">
          <h2>Preview</h2>
          <div className="filters">
            <label>
              <input type="checkbox" /> Hide already on AniList
            </label>
            <div className="filter-group">
              <label><input type="checkbox" /> Matched</label>
              <label><input type="checkbox" /> Ambiguous</label>
              <label><input type="checkbox" /> Unmatched</label>
            </div>
          </div>
        </div>

        <div className="preview-table">
          {previewData.length === 0 ? (
            <p>No data to preview. Click "Source" to add titles.</p>
          ) : (
            <table>
              <thead>
                <tr>
                  <th>Input Title</th>
                  <th>AniList Match</th>
                  <th>Status</th>
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody>
                {previewData.map((item, index) => (
                  <tr key={index}>
                    <td>{item.title}</td>
                    <td>
                      {item.matched ? (
                        <span className="match-success">
                          ✓ {item.anilistTitle || 'Match found'}
                        </span>
                      ) : (
                        <span className="match-none">No match</span>
                      )}
                    </td>
                    <td>
                      <select defaultValue={item.status}>
                        <option value="PLANNING">Planning</option>
                        <option value="CURRENT">Watching</option>
                        <option value="COMPLETED">Completed</option>
                        <option value="PAUSED">Paused</option>
                        <option value="DROPPED">Dropped</option>
                        <option value="REPEATING">Repeating</option>
                      </select>
                    </td>
                    <td>
                      <button className="btn small">Edit</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </main>

      {/* Source Dialog */}
      {showSourceDialog && (
        <div className="modal-overlay" onClick={() => setShowSourceDialog(false)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <h3>Source</h3>
              <button onClick={() => setShowSourceDialog(false)}>×</button>
            </div>
            <div className="modal-body">
              <div className="tabs">
                <button 
                  className={activeTab === 'paste' ? 'tab active' : 'tab'} 
                  onClick={() => setActiveTab('paste')}
                >
                  Paste
                </button>
                <button 
                  className={activeTab === 'hanime' ? 'tab active' : 'tab'} 
                  onClick={() => setActiveTab('hanime')}
                >
                  Hanime
                </button>
              </div>
              {activeTab === 'paste' && (
                <div className="tab-content">
                  <label>
                    Paste titles (one per line)
                    <textarea
                      value={titles}
                      onChange={(e) => setTitles(e.target.value)}
                      rows={12}
                      placeholder="One title per line"
                    />
                  </label>
                  <p className="help">Tip: bullets/numbers are cleaned automatically.</p>
                </div>
              )}
              {activeTab === 'hanime' && (
                <div className="tab-content">
                  <label>
                    Playlist URL
                    <input 
                      type="text" 
                      value={hanimePlaylistUrl}
                      onChange={(e) => setHanimePlaylistUrl(e.target.value)}
                      placeholder="https://hanime.tv/playlists/liked-videos-…" 
                    />
                  </label>
                  <label className="checkbox-label">
                    <input 
                      type="checkbox" 
                      checked={hanimeFillOnly}
                      onChange={(e) => setHanimeFillOnly(e.target.checked)}
                    /> Only fill (don't auto-preview)
                  </label>
                  <button className="btn primary full-width" onClick={handleFetchHanime} disabled={isWorking}>
                    Fetch from Hanime
                  </button>
                  <p className="help">Requires Hanime sign-in or session token (Settings).</p>
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Settings Dialog */}
      {showSettingsDialog && (
        <div className="modal-overlay" onClick={() => setShowSettingsDialog(false)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <h3>Settings</h3>
              <button onClick={() => setShowSettingsDialog(false)}>×</button>
            </div>
            <div className="modal-body">
              <div className="tabs">
                <button 
                  className={settingsTab === 'anilist' ? 'tab active' : 'tab'} 
                  onClick={() => setSettingsTab('anilist')}
                >
                  AniList
                </button>
                <button 
                  className={settingsTab === 'hanime' ? 'tab active' : 'tab'} 
                  onClick={() => setSettingsTab('hanime')}
                >
                  Hanime
                </button>
              </div>
              {settingsTab === 'anilist' && (
                <div className="tab-content">
                  <label>
                    AniList Client ID
                    <input 
                      type="text" 
                      value={clientId}
                      onChange={(e) => setClientId(e.target.value)}
                      placeholder="e.g. 12345" 
                    />
                    <p className="help">
                      Create a client in AniList developer settings. Redirect URL should match this page URL
                      (e.g. <code>http://localhost:5173/</code>).
                    </p>
                  </label>
                  <div className="settings-actions">
                    <button className="btn danger" onClick={handleSignOut}>Sign out</button>
                    <button className="btn primary" onClick={handleSaveSettings}>Save</button>
                  </div>
                </div>
              )}
              {settingsTab === 'hanime' && (
                <div className="tab-content">
                  <label>
                    Hanime session token
                    <input 
                      type="text" 
                      value={hanimeSessionToken}
                      onChange={(e) => setHanimeSessionToken(e.target.value)}
                      placeholder="Paste x-session-token here" 
                    />
                    <p className="help">
                      Paste either the raw token or a cookie string (e.g. <code>htv3session=...</code>). Stored locally in your browser and only sent to your local server.
                    </p>
                  </label>
                  <div className="login-fields">
                    <label>
                      Hanime email
                      <input 
                        type="email" 
                        value={hanimeEmail}
                        onChange={(e) => setHanimeEmail(e.target.value)}
                        placeholder="email@example.com" 
                      />
                    </label>
                    <label>
                      Hanime password
                      <input 
                        type="password" 
                        value={hanimePassword}
                        onChange={(e) => setHanimePassword(e.target.value)}
                        placeholder="••••••••" 
                      />
                    </label>
                    <button className="btn secondary" onClick={handleHanimeLogin} disabled={isWorking}>
                      Sign in to Hanime
                    </button>
                  </div>
                  <div className="settings-actions">
                    <button className="btn primary" onClick={handleSaveSettings}>Save</button>
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Log Dialog */}
      {showLogDialog && (
        <div className="modal-overlay" onClick={() => setShowLogDialog(false)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <h3>Log</h3>
              <button onClick={() => setShowLogDialog(false)}>×</button>
            </div>
            <div className="modal-body">
              <button className="btn secondary" onClick={() => navigator.clipboard.writeText(log)}>Copy</button>
              <pre className="log-content">{log}</pre>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export default App;