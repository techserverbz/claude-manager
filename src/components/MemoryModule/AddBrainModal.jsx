import React, { useState } from "react";

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
    <div
      style={{
        position: "fixed", inset: 0, background: "rgba(0,0,0,0.6)",
        display: "flex", alignItems: "center", justifyContent: "center", zIndex: 1000
      }}
      onClick={onClose}
    >
      <div
        style={{
          background: "#1e1e2e", color: "#e2e8f0", borderRadius: 10,
          padding: 24, width: 520, maxWidth: "90vw", border: "1px solid #333"
        }}
        onClick={e => e.stopPropagation()}
      >
        <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 16 }}>
          <h3 style={{ margin: 0 }}>Add Service Brain</h3>
          <button onClick={onClose} style={{ background: "transparent", color: "#94a3b8", border: "none", fontSize: 20, cursor: "pointer" }}>&times;</button>
        </div>

        <div style={{ marginBottom: 14 }}>
          <label style={{ display: "block", fontSize: 12, color: "#94a3b8", marginBottom: 4 }}>Name</label>
          <input
            value={name}
            onChange={e => setName(e.target.value)}
            placeholder="Real Estate"
            style={{ width: "100%", padding: "8px 10px", borderRadius: 6, background: "#0f0f17", color: "#e2e8f0", border: "1px solid #333" }}
          />
        </div>

        <div style={{ marginBottom: 14 }}>
          <label style={{ display: "block", fontSize: 12, color: "#94a3b8", marginBottom: 4 }}>
            Path to .claude folder
          </label>
          <input
            value={claudePath}
            onChange={e => { setClaudePath(e.target.value); setNeedsInit(false); }}
            placeholder="G:/My Drive/Services/Real Estate/.claude"
            style={{ width: "100%", padding: "8px 10px", borderRadius: 6, background: "#0f0f17", color: "#e2e8f0", border: "1px solid #333", fontFamily: "Consolas, monospace", fontSize: 13 }}
          />
          <div style={{ fontSize: 11, color: "#64748b", marginTop: 6 }}>
            The wiki lives at <code>{claudePath || "{path}"}/wiki/</code>; skills at <code>{claudePath || "{path}"}/skills/</code>.
          </div>
        </div>

        {err && (
          <div style={{ padding: "8px 12px", background: needsInit ? "#3f2a15" : "#3b1d1d", border: "1px solid " + (needsInit ? "#eab308" : "#ef4444"), borderRadius: 6, marginBottom: 14, fontSize: 13 }}>
            {err}
            {needsInit && (
              <div style={{ marginTop: 8 }}>
                Initialize a Karpathy Brain wiki structure at this path?
              </div>
            )}
          </div>
        )}

        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
          <button
            onClick={onClose}
            style={{ padding: "8px 14px", background: "transparent", color: "#94a3b8", border: "1px solid #333", borderRadius: 6, cursor: "pointer" }}
          >Cancel</button>
          {needsInit ? (
            <button
              onClick={() => submit(true)}
              disabled={submitting}
              style={{ padding: "8px 14px", background: "#eab308", color: "#000", border: 0, borderRadius: 6, cursor: submitting ? "default" : "pointer", fontWeight: 600 }}
            >{submitting ? "Initializing..." : "Initialize & Add"}</button>
          ) : (
            <button
              onClick={() => submit(false)}
              disabled={submitting}
              style={{ padding: "8px 14px", background: "#7c6aef", color: "#fff", border: 0, borderRadius: 6, cursor: submitting ? "default" : "pointer", fontWeight: 600 }}
            >{submitting ? "Adding..." : "Add Brain"}</button>
          )}
        </div>
      </div>
    </div>
  );
}
