import React from "react";
import ReactDOM from "react-dom/client";
import { App as AntApp, ConfigProvider, theme as antdTheme } from "antd";
import App from "./App";
import "./styles.css";

// Dark mode only. Some antd overlays (modals / dropdowns) mount to <body>,
// outside the React tree, so the dark token class lives on <body> too.
document.body.classList.add("nbt-dark");

function Root() {
  return (
    <ConfigProvider
      theme={{
        algorithm: antdTheme.darkAlgorithm,
        token: { colorPrimary: "#737373", borderRadius: 6 },
      }}
    >
      <AntApp>
        <App />
      </AntApp>
    </ConfigProvider>
  );
}

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <Root />
  </React.StrictMode>,
);
