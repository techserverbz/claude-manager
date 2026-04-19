import React from "react";
import ReactDOM from "react-dom/client";
// Design tokens first so variables are defined before anything uses them
import "./design/tokens.css";
import "./design/primitives.css";
import "./index.css";
// App (and its component CSS) — uses tokens
import App from "./App.jsx";
// Skin overrides last so they win specificity/order conflicts
import "./design/operator-skin.css";

ReactDOM.createRoot(document.getElementById("root")).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
