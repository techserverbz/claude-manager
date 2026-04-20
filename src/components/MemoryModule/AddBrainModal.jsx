import React, { useState } from "react";
import "./AddBrainModal.css";

export default function AddBrainModal({ onClose, onAdded }) {
  const [name, setName] = useState("");
  const [claudePath, setClaudePath] = useState("");
  const [err, setErr] = useState("");
  const [needsInit, setNeedsInit] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  const submit = async (initIfMissing = false) => {
    setErr("");
    if (!name.trim() || !claudePath.trim()) {
      setErr("Both name and path are required.");
      return;
    }
    setSubmitting(true);
    try {
      const res = await fetch("/api/brains", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: name.trim(), claude_path: claudePath.trim(), initIfMissing })
      });
      const data = await res.json();
      if (!res.ok) {
        if (res.status === 409 && data.needsInit) {
          setNeedsInit(true);
          setErr("No wiki/ folder at that path.");
        } else {
          setErr(data.error || "Failed to add brain.");
        }
        return;
      }
      if (onAdded) onAdded(data);
    } catch (e) {
      setErr(e.message || "Failed to add brain.");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="ab-overlay" onClick={onClose}>
      <div className="ab-modal" onClick={e => e.stopPropagation()}>
        <div className="ab-head">
          <div>
            <div className="ab-eyebrow">Register</div>
            <h3 className="ab-title">Service Brain</h3>
          </div>
          <button className="ab-close" onClick={onClose} aria-label="Close">×</button>
        </div>

        <div className="ab-body">
          <label className="ab-field">
            <span className="ab-label">Name</span>
            <input
              className="ab-input"
              value={name}
              onChange={e => setName(e.target.value)}
              placeholder="Real Estate"
              autoFocus
            />
          </label>

          <label className="ab-field">
            <span className="ab-label">Path to .claude folder</span>
            <input
              className="ab-input ab-input--mono"
              value={claudePath}
              onChange={e => { setClaudePath(e.target.value); setNeedsInit(false); }}
              placeholder="I:/My Drive/Real Estate/.claude"
            />
            <span className="ab-hint">
              Wiki at <code>{claudePath || "{path}"}/wiki/</code> · Skills at <code>{claudePath || "{path}"}/skills/</code>
            </span>
          </label>

          {err && (
            <div className={`ab-alert ${needsInit ? "is-warning" : "is-error"}`}>
              <div className="ab-alert-msg">{err}</div>
              {needsInit && <div className="ab-alert-prompt">Initialize a Karpathy Brain wiki structure at this path?</div>}
            </div>
          )}
        </div>

        <div className="ab-foot">
          <button className="ab-btn ab-btn--ghost" onClick={onClose}>Cancel</button>
          {needsInit ? (
            <button
              className="ab-btn ab-btn--warning"
              onClick={() => submit(true)}
              disabled={submitting}
            >{submitting ? "Initializing..." : "Initialize & Add"}</button>
          ) : (
            <button
              className="ab-btn ab-btn--primary"
              onClick={() => submit(false)}
              disabled={submitting}
            >{submitting ? "Adding..." : "Add brain"}</button>
          )}
        </div>
      </div>
    </div>
  );
}
