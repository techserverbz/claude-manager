import React, { useState, useEffect, useCallback } from "react";

const TARGETS = [
  { key: "claude-manager", icon: "C", accent: "--acid" },
  { key: "karpathy-personal", icon: "P", accent: "--acid" },
  { key: "karpathy-services", icon: "S", accent: "--amber" },
  { key: "excalidraw-canvas", icon: "E", accent: "--flame" },
];

export default function SyncPage({ onClose }) {
  const [status, setStatus] = useState({});
  const [checks, setChecks] = useState({}); // target -> { upToDate, remote, ... }
  const [loading, setLoading] = useState(true);
  const [actionLoading, setActionLoading] = useState(null); // target being acted on
  const [actionResult, setActionResult] = useState(null); // { target, result }
  const [serviceInstallPath, setServiceInstallPath] = useState("");

  const fetchStatus = useCallback(async () => {
    try {
      const res = await fetch("/api/sync/status");
      setStatus(await res.json());
    } catch {} finally { setLoading(false); }
  }, []);

  useEffect(() => { fetchStatus(); }, [fetchStatus]);

  const checkForUpdates = async (target) => {
    setActionLoading(target + "-check");
    try {
      const res = await fetch(`/api/sync/${target}/check`, { method: "POST" });
      const data = await res.json();
      setChecks(prev => ({ ...prev, [target]: data }));
    } catch (err) {
      setChecks(prev => ({ ...prev, [target]: { error: err.message } }));
    } finally { setActionLoading(null); }
  };

  const installOrUpdate = async (target, opts = {}) => {
    setActionLoading(target + "-install");
    setActionResult(null);
    try {
      const res = await fetch(`/api/sync/${target}/install`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(opts),
      });
      const data = await res.json();
      setActionResult({ target, ...data });
      await fetchStatus();
      // Re-check after install
      try {
        const checkRes = await fetch(`/api/sync/${target}/check`, { method: "POST" });
        const checkData = await checkRes.json();
        setChecks(prev => ({ ...prev, [target]: checkData }));
      } catch {}
    } catch (err) {
      setActionResult({ target, success: false, error: err.message });
    } finally { setActionLoading(null); }
  };

  const renderCard = (target) => {
    const s = status[target.key] || {};
    const check = checks[target.key];
    const isCheckLoading = actionLoading === target.key + "-check";
    const isInstallLoading = actionLoading === target.key + "-install";
    const result = actionResult?.target === target.key ? actionResult : null;

    return (
      <div key={target.key} className="sync-card">
        <div className="sync-card-head">
          <div className="sync-card-icon" data-accent={target.accent}>{target.icon}</div>
          <div className="sync-card-info">
            <div className="sync-card-label">{s.label || target.key}</div>
            <div className="sync-card-desc">{s.description || ""}</div>
          </div>
          <div className="sync-card-status">
            {s.installed ? (
              <span className="sync-chip sync-chip--ok">Installed</span>
            ) : (
              <span className="sync-chip sync-chip--warn">Not installed</span>
            )}
          </div>
        </div>

        {s.installed && (
          <div className="sync-card-version">
            <div className="sync-row">
              <span className="sync-label">Commit</span>
              <span className="sync-mono">{s.commit || "—"}</span>
            </div>
            {s.commitDate && (
              <div className="sync-row">
                <span className="sync-label">Date</span>
                <span className="sync-mono">{new Date(s.commitDate).toLocaleString()}</span>
              </div>
            )}
            {s.commitMessage && (
              <div className="sync-row">
                <span className="sync-label">Message</span>
                <span className="sync-msg">{s.commitMessage.slice(0, 80)}</span>
              </div>
            )}
            {s.installedAt && (
              <div className="sync-row">
                <span className="sync-label">Synced</span>
                <span className="sync-mono">{new Date(s.installedAt).toLocaleString()}</span>
              </div>
            )}
            {s.installedBy && (
              <div className="sync-row">
                <span className="sync-label">By</span>
                <span className="sync-mono">{s.installedBy}</span>
              </div>
            )}
            {s.path && (
              <div className="sync-row">
                <span className="sync-label">Path</span>
                <span className="sync-mono sync-path">{s.path}</span>
              </div>
            )}
            {s.claudePath && (
              <div className="sync-row">
                <span className="sync-label">.claude</span>
                <span className="sync-mono sync-path">{s.claudePath}</span>
              </div>
            )}
            {s.wikiPath && (
              <div className="sync-row">
                <span className="sync-label">Wiki</span>
                <span className="sync-mono sync-path">{s.wikiPath}</span>
              </div>
            )}
            {s.clonePath && (
              <div className="sync-row">
                <span className="sync-label">Clone</span>
                <span className="sync-mono sync-path">{s.clonePath}{s.hasClone === false ? " (not cloned)" : ""}</span>
              </div>
            )}
            {s.rawLogs !== undefined && (
              <div className="sync-row">
                <span className="sync-label">Raw logs</span>
                <span className="sync-mono">{s.rawLogs} pending</span>
              </div>
            )}
            {s.pageCategories !== undefined && (
              <div className="sync-row">
                <span className="sync-label">Categories</span>
                <span className="sync-mono">{s.pageCategories}</span>
              </div>
            )}
            {s.port && (
              <div className="sync-row">
                <span className="sync-label">Port</span>
                <span className="sync-mono">{s.port}</span>
              </div>
            )}
            {s.canvasDir && (
              <div className="sync-row">
                <span className="sync-label">Canvas</span>
                <span className="sync-mono sync-path">{s.canvasDir}</span>
              </div>
            )}
            {s.hasNodeModules === false && s.installed && (
              <div className="sync-row">
                <span className="sync-label">Deps</span>
                <span className="sync-mono" style={{color:"var(--amber)"}}>node_modules missing — click Update</span>
              </div>
            )}
          </div>
        )}

        {/* Services sub-list */}
        {target.key === "karpathy-services" && s.services && s.services.length > 0 && (
          <div className="sync-services">
            <div className="sync-services-head">Registered Services</div>
            {s.services.map((svc, i) => {
              const svcCheckLoading = actionLoading === `svc-check-${svc.name}`;
              const svcSyncLoading = actionLoading === `svc-sync-${svc.name}`;
              const svcCheck = checks[`svc-${svc.name}`];
              const svcResult = actionResult?.target === `svc-sync-${svc.name}` ? actionResult : null;
              return (
                <div key={i} className="sync-service-item">
                  <div className="sync-service-row">
                    <span className="sync-service-name">{svc.name}</span>
                    <span className="sync-mono">{svc.commit || "no sync"}</span>
                    {svc.wikiActive && <span className="sync-chip sync-chip--ok" style={{fontSize:9,height:16,padding:"0 6px"}}>Wiki Active</span>}
                  </div>
                  <div className="sync-service-details">
                    {svc.wikiPath && <span className="sync-mono sync-path" title={svc.wikiPath}>Wiki: {svc.wikiPath}</span>}
                    {svc.claudePath && <span className="sync-mono sync-path" title={svc.claudePath}>.claude: {svc.claudePath}</span>}
                    {svc.rawLogs !== undefined && <span className="sync-mono">{svc.rawLogs} raw logs</span>}
                    {svc.pageCategories !== undefined && <span className="sync-mono">{svc.pageCategories} categories</span>}
                    {svc.note && <span className="sync-mono" style={{color:"var(--amber)"}}>{svc.note}</span>}
                  </div>
                  {svcCheck && !svcCheck.error && (
                    <div className={`sync-check-result ${svcCheck.upToDate ? "is-ok" : "is-behind"}`} style={{margin:"6px 0 0",padding:"6px 12px",fontSize:11}}>
                      {svcCheck.upToDate
                        ? <span>Up to date on <b>{svcCheck.local?.commit}</b></span>
                        : <span>Behind: local <b>{svcCheck.local?.commit || "none"}</b> vs remote <b>{svcCheck.remote?.commit}</b>{svcCheck.remote?.commitMessage && <span className="sync-check-msg"> — {svcCheck.remote.commitMessage.slice(0, 60)}</span>}</span>
                      }
                    </div>
                  )}
                  {svcResult && (
                    <div className={`sync-action-result ${svcResult.success ? "is-ok" : "is-error"}`} style={{margin:"6px 0 0",padding:"6px 12px",fontSize:11}}>
                      {svcResult.success ? <span>Updated to <b>{svcResult.commit}</b></span> : <span>{svcResult.error}</span>}
                    </div>
                  )}
                  <div className="sync-card-actions" style={{padding:"10px 0 4px"}}>
                    <button
                      className="sync-btn"
                      disabled={!!actionLoading}
                      onClick={async () => {
                        setActionLoading(`svc-check-${svc.name}`);
                        try {
                          const res = await fetch(`/api/sync/karpathy-services/check`, {
                            method: "POST",
                            headers: { "Content-Type": "application/json" },
                            body: JSON.stringify({ localCommit: svc.commit }),
                          });
                          const data = await res.json();
                          setChecks(prev => ({ ...prev, [`svc-${svc.name}`]: data }));
                        } catch (err) {
                          setChecks(prev => ({ ...prev, [`svc-${svc.name}`]: { error: err.message } }));
                        } finally { setActionLoading(null); }
                      }}
                    >
                      {svcCheckLoading ? "Checking..." : "Check for updates"}
                    </button>
                    <button
                      className="sync-btn sync-btn--primary"
                      disabled={!!actionLoading}
                      onClick={async () => {
                        setActionLoading(`svc-sync-${svc.name}`);
                        setActionResult(null);
                        try {
                          const res = await fetch(`/api/sync/karpathy-services/install`, {
                            method: "POST",
                            headers: { "Content-Type": "application/json" },
                            body: JSON.stringify({ servicePath: svc.claudePath }),
                          });
                          const data = await res.json();
                          setActionResult({ target: `svc-sync-${svc.name}`, ...data });
                          await fetchStatus();
                          // Re-check after sync with the new commit
                          try {
                            const cr = await fetch(`/api/sync/karpathy-services/check`, {
                              method: "POST",
                              headers: { "Content-Type": "application/json" },
                              body: JSON.stringify({ localCommit: data.commit }),
                            });
                            const cd = await cr.json();
                            setChecks(prev => ({ ...prev, [`svc-${svc.name}`]: cd }));
                          } catch {}
                        } catch (err) {
                          setActionResult({ target: `svc-sync-${svc.name}`, success: false, error: err.message });
                        } finally { setActionLoading(null); }
                      }}
                    >
                      {svcSyncLoading ? "Updating..." : "Sync / Update"}
                    </button>
                    <button
                      className="sync-btn sync-btn--danger"
                      disabled={!!actionLoading}
                      onClick={async () => {
                        if (!confirm(`Remove "${svc.name}" service brain? (Wiki files on disk stay untouched.)`)) return;
                        try {
                          const brains = await (await fetch("/api/brains")).json();
                          const brain = brains.find(b => b.name === svc.name);
                          if (brain) {
                            await fetch(`/api/brains/${brain.id}`, { method: "DELETE" });
                            await fetchStatus();
                          }
                        } catch {}
                      }}
                    >
                      Remove
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        )}

        {/* Add new service */}
        {target.key === "karpathy-services" && (
          <div className="sync-service-install">
            <label className="sync-label" style={{ marginBottom: 4, display: "block" }}>Add New Service</label>
            <input
              className="sync-input"
              value={serviceInstallPath}
              onChange={e => setServiceInstallPath(e.target.value)}
              placeholder="I:/My Drive/Real Estate"
            />
            <span style={{ fontSize: 10, color: "var(--paper-3)", marginTop: 4, display: "block" }}>
              Paste the project root (e.g. I:/My Drive/Real Estate). The .claude folder will be found automatically.
            </span>
          </div>
        )}

        {/* Check result */}
        {check && !check.error && (
          <div className={`sync-check-result ${check.upToDate ? "is-ok" : "is-behind"}`}>
            {check.upToDate ? (
              <span>Up to date on <b>{check.local.commit}</b></span>
            ) : (
              <span>
                Behind: local <b>{check.local.commit || "none"}</b> vs remote <b>{check.remote.commit}</b>
                {check.remote.commitMessage && <span className="sync-check-msg"> — {check.remote.commitMessage.slice(0, 60)}</span>}
              </span>
            )}
          </div>
        )}
        {check?.error && <div className="sync-check-result is-error">{check.error}</div>}

        {/* Action result */}
        {result && (
          <div className={`sync-action-result ${result.success ? "is-ok" : "is-error"}`}>
            {result.success ? (
              <span>{result.action === "installed" ? "Installed" : "Updated"} to <b>{result.commit}</b></span>
            ) : (
              <span>Failed: {result.error}</span>
            )}
            {result.note && <div className="sync-note">{result.note}</div>}
          </div>
        )}

        <div className="sync-card-actions">
          {/* For services: hide global check/sync buttons — per-service buttons handle it.
              Only show "Install" when adding a NEW service via the path input. */}
          {target.key !== "karpathy-services" && (
            <>
              <button
                className="sync-btn"
                onClick={() => checkForUpdates(target.key)}
                disabled={!!actionLoading}
              >
                {isCheckLoading ? "Checking..." : "Check for updates"}
              </button>
              <button
                className="sync-btn sync-btn--primary"
                onClick={() => installOrUpdate(target.key)}
                disabled={!!actionLoading}
              >
                {isInstallLoading ? "Working..." : s.installed ? "Sync / Update" : "Install"}
              </button>
            </>
          )}
          {target.key === "karpathy-services" && (
            <button
              className="sync-btn sync-btn--primary"
              onClick={() => {
                if (!serviceInstallPath.trim()) return;
                installOrUpdate(target.key, { servicePath: serviceInstallPath.trim() });
              }}
              disabled={!!actionLoading || !serviceInstallPath.trim()}
            >
              {isInstallLoading ? "Installing..." : "Install New Service"}
            </button>
          )}
        </div>
      </div>
    );
  };

  return (
    <div className="sync-root">
      <div className="sync-header">
        <div>
          <div className="sync-eyebrow">System</div>
          <h2 className="sync-title">Sync</h2>
        </div>
        <button className="sync-close" onClick={onClose} aria-label="Close">&times;</button>
      </div>

      <div className="sync-scroll">
        {loading ? (
          <div className="sync-empty">Loading sync status...</div>
        ) : (
          <div className="sync-cards">
            {TARGETS.map(t => renderCard(t))}
          </div>
        )}
      </div>

      <style>{`
        .sync-root {
          flex:1; display:flex; flex-direction:column; overflow:hidden;
          font-family:var(--ff-ui); background:var(--ink-0); position:relative;
        }
        .sync-root::before {
          content:""; position:absolute; inset:0;
          background-image:var(--noise); opacity:0.45;
          pointer-events:none; z-index:0;
        }
        .sync-root > * { position:relative; z-index:1; }

        .sync-header {
          display:flex; align-items:flex-start; justify-content:space-between;
          padding:24px 28px 20px;
          box-shadow: inset 0 -1px 0 var(--rule-1);
        }
        .sync-eyebrow {
          font-family: var(--ff-mono); font-size: 9px; font-weight: 500;
          letter-spacing: var(--track-wider); text-transform: uppercase;
          color: var(--paper-3); margin-bottom: 8px;
        }
        .sync-title {
          font-family: var(--ff-serif); font-style: italic; font-weight: 400;
          font-size: 34px; letter-spacing: var(--track-editorial);
          color: var(--paper-0); margin: 0; line-height: 1;
        }
        .sync-close {
          background:transparent; border:none; color:var(--paper-3);
          font-size:24px; cursor:pointer; padding:4px 10px;
          border-radius: var(--r-1);
          transition: color var(--dur-quick) var(--ease-snap);
        }
        .sync-close:hover { color:var(--flame); }

        .sync-scroll {
          flex:1; overflow-y:auto; padding:24px 28px 40px;
        }
        .sync-scroll::-webkit-scrollbar { width:8px; }
        .sync-scroll::-webkit-scrollbar-track { background:transparent; }
        .sync-scroll::-webkit-scrollbar-thumb { background:var(--ink-4); border-radius:var(--r-pill); }

        .sync-empty {
          padding:60px; text-align:center;
          font-family:var(--ff-serif); font-style:italic;
          color:var(--paper-3); font-size:16px;
        }

        .sync-cards { display:flex; flex-direction:column; gap:16px; }

        .sync-card {
          background: var(--ink-1);
          border-radius: var(--r-3);
          box-shadow: var(--shadow-inset-hairline);
          overflow: hidden;
          position: relative;
        }
        .sync-card::before {
          content:""; position:absolute; inset:0;
          background-image:var(--noise); opacity:0.4;
          pointer-events:none; mix-blend-mode:overlay;
          border-radius:inherit;
        }
        .sync-card > * { position:relative; z-index:1; }

        .sync-card-head {
          display:flex; align-items:center; gap:16px;
          padding:20px 24px;
          box-shadow: inset 0 -1px 0 var(--rule-0);
        }
        .sync-card-icon {
          width:40px; height:40px;
          display:flex; align-items:center; justify-content:center;
          font-family:var(--ff-serif); font-style:italic; font-size:22px;
          font-weight:400;
          color:var(--acid);
          background: color-mix(in srgb, var(--acid) 10%, transparent);
          border-radius:var(--r-pill);
          box-shadow: inset 0 0 0 0.5px color-mix(in srgb, var(--acid) 40%, transparent);
          flex-shrink:0;
        }
        .sync-card-info { flex:1; min-width:0; }
        .sync-card-label {
          font-family:var(--ff-ui); font-size:15px; font-weight:var(--w-mid);
          color:var(--paper-0); letter-spacing:var(--track-tight);
        }
        .sync-card-desc {
          font-family:var(--ff-ui); font-size:11.5px;
          color:var(--paper-2); margin-top:2px;
        }
        .sync-card-status { flex-shrink:0; }

        .sync-chip {
          display:inline-flex; align-items:center; gap:5px;
          height:22px; padding:0 10px;
          font-family:var(--ff-ui); font-size:10.5px; font-weight:var(--w-mid);
          letter-spacing:var(--track-wider); text-transform:uppercase;
          border-radius:var(--r-pill); line-height:1;
        }
        .sync-chip--ok {
          color:var(--acid);
          background:color-mix(in srgb, var(--acid) 10%, transparent);
          box-shadow:inset 0 0 0 0.5px color-mix(in srgb, var(--acid) 40%, transparent);
        }
        .sync-chip--warn {
          color:var(--amber);
          background:color-mix(in srgb, var(--amber) 10%, transparent);
          box-shadow:inset 0 0 0 0.5px color-mix(in srgb, var(--amber) 40%, transparent);
        }

        .sync-card-version {
          padding:16px 24px;
          display:flex; flex-direction:column; gap:6px;
          box-shadow: inset 0 -1px 0 var(--rule-0);
        }
        .sync-row {
          display:flex; align-items:baseline; gap:12px;
          font-size:12px;
        }
        .sync-label {
          font-family:var(--ff-ui); font-size:10px; font-weight:var(--w-mid);
          letter-spacing:var(--track-wider); text-transform:uppercase;
          color:var(--paper-3); width:60px; flex-shrink:0;
        }
        .sync-mono {
          font-family:var(--ff-mono); font-variant-numeric:tabular-nums;
          font-size:12px; color:var(--paper-1);
        }
        .sync-msg {
          font-family:var(--ff-ui); font-size:12px; color:var(--paper-2);
          overflow:hidden; text-overflow:ellipsis; white-space:nowrap;
        }
        .sync-path {
          font-size:11px; color:var(--paper-2);
          overflow:hidden; text-overflow:ellipsis; white-space:nowrap;
        }

        .sync-services {
          padding:12px 24px;
          box-shadow: inset 0 -1px 0 var(--rule-0);
        }
        .sync-services-head {
          font-family:var(--ff-ui); font-size:10px; font-weight:var(--w-mid);
          letter-spacing:var(--track-wider); text-transform:uppercase;
          color:var(--paper-3); margin-bottom:8px;
        }
        .sync-service-row {
          display:flex; align-items:center; gap:12px;
          padding:6px 0;
          box-shadow: inset 0 -1px 0 var(--rule-0);
          font-size:12px;
        }
        .sync-service-item {
          padding:8px 0;
          box-shadow: inset 0 -1px 0 var(--rule-0);
        }
        .sync-service-item:last-child { box-shadow:none; }
        .sync-service-row:last-child { box-shadow:none; }
        .sync-service-name {
          font-family:var(--ff-ui); font-weight:var(--w-mid);
          color:var(--paper-0); flex:1;
        }
        .sync-service-details {
          display:flex; flex-direction:column; gap:2px;
          padding:4px 0 0 0;
          font-size:10.5px;
        }
        .sync-service-details .sync-path { font-size:10.5px; }

        .sync-service-install {
          padding:12px 24px;
          box-shadow: inset 0 -1px 0 var(--rule-0);
        }
        .sync-input {
          width:100%; padding:9px 12px;
          background:var(--ink-0); color:var(--paper-0);
          border:none; border-radius:var(--r-1);
          box-shadow:var(--shadow-inset-hairline);
          font-family:var(--ff-mono); font-size:12px;
          outline:none;
          transition:box-shadow var(--dur-quick) var(--ease-snap);
        }
        .sync-input:focus { box-shadow:inset 0 0 0 1px var(--rule-acid); }
        .sync-input::placeholder { color:var(--paper-3); }

        .sync-check-result {
          padding:10px 24px;
          font-family:var(--ff-ui); font-size:12px;
          box-shadow: inset 0 -1px 0 var(--rule-0);
        }
        .sync-check-result.is-ok {
          color:var(--acid);
          background:color-mix(in srgb, var(--acid) 4%, transparent);
        }
        .sync-check-result.is-behind {
          color:var(--amber);
          background:color-mix(in srgb, var(--amber) 6%, transparent);
        }
        .sync-check-result.is-error {
          color:var(--flame);
          background:color-mix(in srgb, var(--flame) 6%, transparent);
        }
        .sync-check-msg { color:var(--paper-2); font-size:11.5px; }

        .sync-action-result {
          padding:10px 24px;
          font-family:var(--ff-ui); font-size:12px;
          box-shadow: inset 0 -1px 0 var(--rule-0);
        }
        .sync-action-result.is-ok {
          color:var(--acid);
          background:color-mix(in srgb, var(--acid) 4%, transparent);
        }
        .sync-action-result.is-error {
          color:var(--flame);
          background:color-mix(in srgb, var(--flame) 6%, transparent);
        }
        .sync-note {
          margin-top:4px; font-size:11px; color:var(--paper-2);
        }

        .sync-card-actions {
          display:flex; gap:8px; padding:16px 24px;
        }
        .sync-btn {
          padding:8px 16px;
          font-family:var(--ff-ui); font-size:12px; font-weight:var(--w-mid);
          letter-spacing:var(--track-wide);
          color:var(--paper-0);
          background:var(--ink-2);
          border:none; border-radius:var(--r-1);
          box-shadow:var(--shadow-inset-hairline);
          cursor:pointer;
          transition:background var(--dur-quick) var(--ease-snap),
                     box-shadow var(--dur-quick) var(--ease-snap);
        }
        .sync-btn:hover:not(:disabled) {
          background:var(--ink-3);
          box-shadow:var(--shadow-inset-hairline-strong);
        }
        .sync-btn:disabled { opacity:0.5; cursor:default; }

        .sync-btn--sm {
          padding:4px 12px; font-size:10px; height:24px;
          letter-spacing:var(--track-wider); text-transform:uppercase;
          margin-left:auto; flex-shrink:0;
        }

        .sync-btn--danger {
          background:transparent;
          color:var(--flame);
          box-shadow:inset 0 0 0 0.5px color-mix(in srgb, var(--flame) 40%, transparent);
        }
        .sync-btn--danger:hover:not(:disabled) {
          background:color-mix(in srgb, var(--flame) 8%, transparent);
          box-shadow:inset 0 0 0 0.5px color-mix(in srgb, var(--flame) 60%, transparent);
        }

        .sync-btn--primary {
          background:var(--acid);
          color:#0b0a08;
          box-shadow:var(--glow-acid);
        }
        .sync-btn--primary:hover:not(:disabled) { filter:brightness(1.1); }
        .sync-btn--primary:disabled {
          background:var(--ink-3); color:var(--paper-3);
          box-shadow:var(--shadow-inset-hairline); filter:none;
        }
      `}</style>
    </div>
  );
}
