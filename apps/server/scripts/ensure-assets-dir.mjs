// Wrangler refuses to start if the static assets folder is missing, and the web
// app may not have been built yet during development. Works on Windows too.
import { mkdirSync } from "node:fs";
mkdirSync(new URL("../../web/dist", import.meta.url), { recursive: true });
