import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { VoiceApp } from "./VoiceApp.js";
import "./voice.css";

const root = document.getElementById("root");
if (!root) throw new Error("Voice app root is missing");
createRoot(root).render(<StrictMode><VoiceApp /></StrictMode>);
