import React from "react";
import ReactDOM from "react-dom/client";
import { ThemeProvider } from "@proxyshard/shardx-ui-kit";
import "../dev/mock/install";
import "../app/fonts";
import "../app/styles/index.css";
import "../app/styles/app.css";
import { KitLabels } from "../app/KitLabels";
import { RaccoonPreview } from "./preview";
import { initializePreviewWorkspaces } from "./workspaces";

initializePreviewWorkspaces();
ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <ThemeProvider>
      <KitLabels><RaccoonPreview /></KitLabels>
    </ThemeProvider>
  </React.StrictMode>,
);
