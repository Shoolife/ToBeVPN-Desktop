import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
// Twemoji Country Flags font is registered via @font-face in App.css so the
// flag glyphs are guaranteed available before any first paint, including
// when the WebView has no outbound network yet (jsDelivr is unreachable
// before the VPN tunnel is up).

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
