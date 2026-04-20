import React, { useState, useCallback } from "react";

const STATUS_ICON = { pass: "\u2713", fail: "\u2717", warn: "!" };
const STATUS_COLOR = { pass: "var(--acid)", fail: "var(--flame)", warn: "var(--amber)" };

export default function HealthCheckPage({ onClose }) {
  const [results, setResults] = useState(null);
  const [summary, setSummary] = useState(null);
  const [loading, setLoading] = useState(false);

  const runChecks = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/health/diagnostics");
      const data = await res.json();
      setResults(data.results || []);
      setSummary(data.summary || {});
    } catch (err) {
      setResults([{ name: "API Error", status: "fail", detail: err.message, category: "system" }]);
      setSummary({ total: 1, passed: 0, failed: 1, warn: 0 });
    } finally { setLoading(false); }
  }, []);

  const grouped = {};
  if (results) {
    for (const r of results) {
      const cat = r.category || "other";
      if (!grouped[cat]) grouped[cat] = [];
      grouped[cat].push(r);
    }
  }

  const CATEGORY_LABELS = {
    hooks: "Hooks Configuration",
    rawlog: "Raw Log Capture",
    session_id: "Session ID Injection",
    jsonl: "JSONL Conversation Extraction",
    sync: "Wiki \u2192 DB Sync",
    brain: "Brain Connectivity",
    db: "Database",
  };

  return (
    <div className="hc-root">
      <div className="hc-header">
        <div>
          <div className="hc-eyebrow">System</div>
          <h2 className="hc-title">Health Check</h2>
        </div>
        <div className="hc-header-right">
          <button className="hc-run-btn" onClick={runChecks} disabled={loading}>
            {loading ? "Running..." : "Run Diagnostics"}
          </button>
          <button className="hc-close" onClick={onClose}>&times;</button>
        </div>
      </div>

      <div className="hc-scroll">
        {!results && !loading && (
          <div className="hc-empty">
            <p>Click "Run Diagnostics" to check system health</p>
            <span>Checks hooks, raw logs, session ID injection, JSONL extraction, wiki sync, brain paths</span>
          </div>
        )}

        {summary && (
          <div className="hc-summary">
            <span className="hc-summary-item" style={{ color: "var(--acid)" }}>{summary.passed} passed</span>
            <span className="hc-summary-sep" />
            {summary.warn > 0 && <><span className="hc-summary-item" style={{ color: "var(--amber)" }}>{summary.warn} warnings</span><span className="hc-summary-sep" /></>}
            {summary.failed > 0 && <span className="hc-summary-item" style={{ color: "var(--flame)" }}>{summary.failed} failed</span>}
            {summary.failed === 0 && summary.warn === 0 && <span className="hc-summary-item" style={{ color: "var(--acid)" }}>All clear</span>}
          </div>
        )}

        {results && Object.entries(grouped).map(([cat, checks]) => (
          <div key={cat} className="hc-category">
            <div className="hc-category-head">{CATEGORY_LABELS[cat] || cat}</div>
            {checks.map((r, i) => (
              <div key={i} className={`hc-check hc-check--${r.status}`}>
                <span className="hc-check-icon" style={{ color: STATUS_COLOR[r.status] }}>{STATUS_ICON[r.status]}</span>
                <div className="hc-check-info">
                  <div className="hc-check-name">{r.name}</div>
                  <div className="hc-check-detail">{r.detail}</div>
                </div>
              </div>
            ))}
          </div>
        ))}

        {results && (
          <div className="hc-docs">
            <div className="hc-docs-head">What Each Check Verifies</div>
            <div className="hc-doc-item"><b>Hooks configured</b> — settings.json has SessionStart, Stop, and PostToolUse hooks registered. Without these, raw logs won't be created or finalized.</div>
            <div className="hc-doc-item"><b>Raw log capture</b> — A raw log (.md) exists in wiki/raw/ from a recent session. This is the auto-captured session journal.</div>
            <div className="hc-doc-item"><b>Session ID injection</b> — The wiki-logger hook injects session_id into the raw log frontmatter on the first tool call. Needed for JSONL lookup and cross-referencing.</div>
            <div className="hc-doc-item"><b>JSONL conversation extraction</b> — Every 5 tool calls, the wiki-logger extracts user/assistant messages from the session JSONL into the raw log. If missing, sessions were too short or the hook timed out.</div>
            <div className="hc-doc-item"><b>Wiki to DB sync</b> — Wiki pages are synced to the memory_entities table so the Second Brain UI can display and search them.</div>
            <div className="hc-doc-item"><b>Brain connectivity</b> — Each registered service brain's .claude path is accessible on disk. Fails if Google Drive is unmounted or the path moved.</div>
            <div className="hc-doc-item"><b>Brains registry</b> — At least one brain (Personal) exists and is active. Service brains are listed.</div>
          </div>
        )}
      </div>

      <style>{`
        .hc-root {
          flex:1; display:flex; flex-direction:column; overflow:hidden;
          font-family:var(--ff-ui); background:var(--ink-0); position:relative;
        }
        .hc-root::before {
          content:""; position:absolute; inset:0;
          background-image:var(--noise); opacity:0.45;
          pointer-events:none; z-index:0;
        }
        .hc-root > * { position:relative; z-index:1; }

        .hc-header {
          display:flex; align-items:flex-start; justify-content:space-between;
          padding:24px 28px 20px;
          box-shadow: inset 0 -1px 0 var(--rule-1);
        }
        .hc-eyebrow {
          font-family:var(--ff-mono); font-size:9px; font-weight:500;
          letter-spacing:var(--track-wider); text-transform:uppercase;
          color:var(--paper-3); margin-bottom:8px;
        }
        .hc-title {
          font-family:var(--ff-serif); font-style:italic; font-weight:400;
          font-size:34px; letter-spacing:var(--track-editorial);
          color:var(--paper-0); margin:0; line-height:1;
        }
        .hc-header-right { display:flex; gap:8px; align-items:center; }
        .hc-run-btn {
          padding:8px 18px;
          font-family:var(--ff-ui); font-size:12px; font-weight:var(--w-strong);
          letter-spacing:var(--track-wide);
          background:var(--acid); color:#0b0a08;
          border:none; border-radius:var(--r-pill);
          cursor:pointer;
          box-shadow:var(--glow-acid);
          transition:filter var(--dur-quick) var(--ease-snap);
        }
        .hc-run-btn:hover:not(:disabled) { filter:brightness(1.1); }
        .hc-run-btn:disabled { opacity:0.6; cursor:default; }
        .hc-close {
          background:transparent; border:none; color:var(--paper-3);
          font-size:24px; cursor:pointer; padding:4px 10px;
          border-radius:var(--r-1);
        }
        .hc-close:hover { color:var(--flame); }

        .hc-scroll {
          flex:1; overflow-y:auto; padding:20px 28px 40px;
        }
        .hc-scroll::-webkit-scrollbar { width:8px; }
        .hc-scroll::-webkit-scrollbar-track { background:transparent; }
        .hc-scroll::-webkit-scrollbar-thumb { background:var(--ink-4); border-radius:var(--r-pill); }

        .hc-empty {
          padding:80px 40px; text-align:center;
        }
        .hc-empty p {
          font-family:var(--ff-serif); font-style:italic;
          font-size:18px; color:var(--paper-2); margin:0 0 8px;
        }
        .hc-empty span {
          font-family:var(--ff-ui); font-size:12px; color:var(--paper-3);
        }

        .hc-summary {
          display:flex; align-items:center; gap:12px;
          padding:14px 20px; margin-bottom:20px;
          background:var(--ink-1); border-radius:var(--r-2);
          box-shadow:var(--shadow-inset-hairline);
        }
        .hc-summary-item {
          font-family:var(--ff-mono); font-size:13px; font-weight:var(--w-mid);
          font-variant-numeric:tabular-nums;
        }
        .hc-summary-sep { width:1px; height:14px; background:var(--rule-1); }

        .hc-category { margin-bottom:20px; }
        .hc-category-head {
          font-family:var(--ff-ui); font-size:10px; font-weight:var(--w-mid);
          letter-spacing:var(--track-wider); text-transform:uppercase;
          color:var(--paper-3); padding:0 0 8px; margin-bottom:4px;
          box-shadow:inset 0 -1px 0 var(--rule-0);
        }

        .hc-check {
          display:flex; align-items:flex-start; gap:12px;
          padding:10px 16px;
          box-shadow:inset 0 -1px 0 var(--rule-0);
        }
        .hc-check:last-child { box-shadow:none; }
        .hc-check-icon {
          font-family:var(--ff-mono); font-size:14px; font-weight:var(--w-strong);
          width:20px; text-align:center; flex-shrink:0; padding-top:1px;
        }
        .hc-check-info { flex:1; min-width:0; }
        .hc-check-name {
          font-family:var(--ff-ui); font-size:13px; font-weight:var(--w-mid);
          color:var(--paper-0); margin-bottom:2px;
        }
        .hc-check-detail {
          font-family:var(--ff-ui); font-size:11.5px; color:var(--paper-2);
          line-height:1.5; word-break:break-word;
        }
        .hc-check--fail .hc-check-detail { color:color-mix(in srgb, var(--flame) 80%, var(--paper-1)); }
        .hc-check--warn .hc-check-detail { color:color-mix(in srgb, var(--amber) 70%, var(--paper-1)); }

        .hc-docs {
          margin-top:28px; padding:20px;
          background:var(--ink-1); border-radius:var(--r-2);
          box-shadow:var(--shadow-inset-hairline);
        }
        .hc-docs-head {
          font-family:var(--ff-serif); font-style:italic;
          font-size:18px; color:var(--paper-0); margin-bottom:16px;
        }
        .hc-doc-item {
          font-family:var(--ff-ui); font-size:12px; color:var(--paper-2);
          line-height:1.6; padding:6px 0;
          box-shadow:inset 0 -1px 0 var(--rule-0);
        }
        .hc-doc-item:last-child { box-shadow:none; }
        .hc-doc-item b {
          color:var(--paper-0); font-weight:var(--w-mid);
        }
      `}</style>
    </div>
  );
}
