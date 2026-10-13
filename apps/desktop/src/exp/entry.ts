// Afterglow entry (experimental build only; vite.exp.mjs appends it after main.tsx's imports, so
// these styles load after styles/global.css). Nothing here runs in main's build.
import "./styles/tokens.css";
import "./styles/shell.css";
import "./styles/components.css";
import "./styles/screens.css";
import "./styles/springs.css";
import "./styles/motion.css";
import "./styles/tabs.css";
import "./styles/hosts.css";
import "./styles/connect.css";
import "./styles/toasts.css";
