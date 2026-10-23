import { Router } from "express";
import path from "path";

// Embeddable booking widget (item 8) — a real JS snippet + API endpoints
// (publicApi.ts), not an iframe redirect. Meant to be dropped onto
// vcpeer.com's active-call and post-call screens as a "Turn this into a
// recurring booking link" CTA (STRATEGY-2026-10-23.md section 5, move 3).
// That drop-in itself is cross-repo work in `vcpeer`, tracked in
// BUILD-LOG-2026-10-23.md as a remaining item — this is the widget + the
// endpoint it calls, both real and live here.

export const widgetRouter = Router();

widgetRouter.get("/widget.js", (_req, res) => {
  res.setHeader("content-type", "application/javascript; charset=utf-8");
  res.setHeader("cache-control", "public, max-age=300");
  res.sendFile(path.join(__dirname, "..", "..", "public", "assets", "widget.js"));
});

widgetRouter.get("/widget.css", (_req, res) => {
  res.setHeader("content-type", "text/css; charset=utf-8");
  res.setHeader("cache-control", "public, max-age=300");
  res.sendFile(path.join(__dirname, "..", "..", "public", "assets", "widget.css"));
});

widgetRouter.get("/widget/demo", (_req, res) => {
  res.sendFile(path.join(__dirname, "..", "..", "public", "widget-demo", "index.html"));
});
