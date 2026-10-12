// Generated from lucide-static 1.47.0 (ISC License, Copyright (c) 2026 Lucide Icons and Contributors).
// Bundled as inline SVG so no icon is ever fetched at run time. Regenerate with scripts/gen-icons.py
// (list in src/components/ui/icons.list) rather than hand-editing. See NOTICE for the license text.

import type { SVGProps } from "react";

export type IconProps = Omit<SVGProps<SVGSVGElement>, "children"> & { size?: number };

function svg(body: string[]) {
  return function Icon({ size = 16, ...rest }: IconProps) {
    return (
      <svg
        xmlns="http://www.w3.org/2000/svg"
        width={size}
        height={size}
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth={1.75}
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
        focusable="false"
        {...rest}
      >
        {body.map((d, i) => (
          // Fixed geometry from the generated list; position is the identity.
          <Shape key={i} d={d} />
        ))}
      </svg>
    );
  };
}

/** Shapes are encoded as `tag|attr=value|attr=value` so only path/circle/rect/line/polyline/ellipse are possible. */
function Shape({ d }: { d: string }) {
  const [tag, ...pairs] = d.split("|");
  const attrs = Object.fromEntries(pairs.map((p) => { const i = p.indexOf("="); return [p.slice(0, i), p.slice(i + 1)]; }));
  switch (tag) {
    case "path": return <path d={attrs.d} />;
    case "circle": return <circle cx={attrs.cx} cy={attrs.cy} r={attrs.r} />;
    case "rect": return <rect x={attrs.x} y={attrs.y} width={attrs.width} height={attrs.height} rx={attrs.rx} ry={attrs.ry} />;
    case "line": return <line x1={attrs.x1} y1={attrs.y1} x2={attrs.x2} y2={attrs.y2} />;
    case "polyline": return <polyline points={attrs.points} />;
    case "polygon": return <polygon points={attrs.points} />;
    case "ellipse": return <ellipse cx={attrs.cx} cy={attrs.cy} rx={attrs.rx} ry={attrs.ry} />;
    default: return null;
  }
}

export const IconHouse = svg(["path|d=M15 21v-8a1 1 0 0 0-1-1h-4a1 1 0 0 0-1 1v8", "path|d=M3 10a2 2 0 0 1 .709-1.528l7-6a2 2 0 0 1 2.582 0l7 6A2 2 0 0 1 21 10v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"]);
export const IconServer = svg(["rect|width=20|height=8|x=2|y=2|rx=2|ry=2", "rect|width=20|height=8|x=2|y=14|rx=2|ry=2", "line|x1=6|x2=6.01|y1=6|y2=6", "line|x1=6|x2=6.01|y1=18|y2=18"]);
export const IconTerminal = svg(["path|d=M12 19h8", "path|d=m4 17 6-6-6-6"]);
export const IconSquareTerminal = svg(["path|d=m7 11 2-2-2-2", "path|d=M11 13h4", "rect|width=18|height=18|x=3|y=3|rx=2|ry=2"]);
export const IconKeyRound = svg(["path|d=M2.586 17.414A2 2 0 0 0 2 18.828V21a1 1 0 0 0 1 1h3a1 1 0 0 0 1-1v-1a1 1 0 0 1 1-1h1a1 1 0 0 0 1-1v-1a1 1 0 0 1 1-1h.172a2 2 0 0 0 1.414-.586l.814-.814a6.5 6.5 0 1 0-4-4z", "circle|cx=16.5|cy=7.5|r=.5|fill=currentColor"]);
export const IconShieldCheck = svg(["path|d=M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z", "path|d=m9 12 2 2 4-4"]);
export const IconSettings = svg(["path|d=M9.671 4.136a2.34 2.34 0 0 1 4.659 0 2.34 2.34 0 0 0 3.319 1.915 2.34 2.34 0 0 1 2.33 4.033 2.34 2.34 0 0 0 0 3.831 2.34 2.34 0 0 1-2.33 4.033 2.34 2.34 0 0 0-3.319 1.915 2.34 2.34 0 0 1-4.659 0 2.34 2.34 0 0 0-3.32-1.915 2.34 2.34 0 0 1-2.33-4.033 2.34 2.34 0 0 0 0-3.831A2.34 2.34 0 0 1 6.35 6.051a2.34 2.34 0 0 0 3.319-1.915", "circle|cx=12|cy=12|r=3"]);
export const IconLock = svg(["rect|width=18|height=11|x=3|y=11|rx=2|ry=2", "path|d=M7 11V7a5 5 0 0 1 10 0v4"]);
export const IconLockOpen = svg(["rect|width=18|height=11|x=3|y=11|rx=2|ry=2", "path|d=M7 11V7a5 5 0 0 1 9.9-1"]);
export const IconSearch = svg(["path|d=m21 21-4.34-4.34", "circle|cx=11|cy=11|r=8"]);
export const IconPlus = svg(["path|d=M5 12h14", "path|d=M12 5v14"]);
export const IconX = svg(["path|d=M18 6 6 18", "path|d=m6 6 12 12"]);
export const IconChevronDown = svg(["path|d=m6 9 6 6 6-6"]);
export const IconChevronRight = svg(["path|d=m9 18 6-6-6-6"]);
export const IconChevronLeft = svg(["path|d=m15 18-6-6 6-6"]);
export const IconEllipsis = svg(["circle|cx=12|cy=12|r=1", "circle|cx=19|cy=12|r=1", "circle|cx=5|cy=12|r=1"]);
export const IconPencil = svg(["path|d=M21.174 6.812a1 1 0 0 0-3.986-3.987L3.842 16.174a2 2 0 0 0-.5.83l-1.321 4.352a.5.5 0 0 0 .623.622l4.353-1.32a2 2 0 0 0 .83-.497z", "path|d=m15 5 4 4"]);
export const IconCopy = svg(["rect|width=14|height=14|x=8|y=8|rx=2|ry=2", "path|d=M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"]);
export const IconTrash2 = svg(["path|d=M10 11v6", "path|d=M14 11v6", "path|d=M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6", "path|d=M3 6h18", "path|d=M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"]);
export const IconPlay = svg(["path|d=M5 5a2 2 0 0 1 3.008-1.728l11.997 6.998a2 2 0 0 1 .003 3.458l-12 7A2 2 0 0 1 5 19z"]);
export const IconClipboardPaste = svg(["path|d=M11 14h10", "path|d=M16 4h2a2 2 0 0 1 2 2v1.344", "path|d=m17 18 4-4-4-4", "path|d=M8 4H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 1.793-1.113", "rect|x=8|y=2|width=8|height=4|rx=1"]);
export const IconFolder = svg(["path|d=M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"]);
export const IconFolderOpen = svg(["path|d=m6 14 1.5-2.9A2 2 0 0 1 9.24 10H20a2 2 0 0 1 1.94 2.5l-1.54 6a2 2 0 0 1-1.95 1.5H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h3.9a2 2 0 0 1 1.69.9l.81 1.2a2 2 0 0 0 1.67.9H18a2 2 0 0 1 2 2v2"]);
export const IconFolderPlus = svg(["path|d=M12 10v6", "path|d=M9 13h6", "path|d=M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"]);
export const IconFileCode = svg(["path|d=M6 22a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h8a2.4 2.4 0 0 1 1.704.706l3.588 3.588A2.4 2.4 0 0 1 20 8v12a2 2 0 0 1-2 2z", "path|d=M14 2v5a1 1 0 0 0 1 1h5", "path|d=M10 12.5 8 15l2 2.5", "path|d=m14 12.5 2 2.5-2 2.5"]);
export const IconColumns2 = svg(["rect|width=18|height=18|x=3|y=3|rx=2", "path|d=M12 3v18"]);
export const IconRows2 = svg(["rect|width=18|height=18|x=3|y=3|rx=2", "path|d=M3 12h18"]);
export const IconPanelRightOpen = svg(["rect|width=18|height=18|x=3|y=3|rx=2", "path|d=M15 3v18", "path|d=m10 15-3-3 3-3"]);
export const IconPanelRightClose = svg(["rect|width=18|height=18|x=3|y=3|rx=2", "path|d=M15 3v18", "path|d=m8 9 3 3-3 3"]);
export const IconCommand = svg(["path|d=M15 6v12a3 3 0 1 0 3-3H6a3 3 0 1 0 3 3V6a3 3 0 1 0-3 3h12a3 3 0 1 0-3-3"]);
export const IconSun = svg(["circle|cx=12|cy=12|r=4", "path|d=M12 2v2", "path|d=M12 20v2", "path|d=m4.93 4.93 1.41 1.41", "path|d=m17.66 17.66 1.41 1.41", "path|d=M2 12h2", "path|d=M20 12h2", "path|d=m6.34 17.66-1.41 1.41", "path|d=m19.07 4.93-1.41 1.41"]);
export const IconMoon = svg(["path|d=M20.985 12.486a9 9 0 1 1-9.473-9.472c.405-.022.617.46.402.803a6 6 0 0 0 8.268 8.268c.344-.215.825-.004.803.401"]);
export const IconMonitor = svg(["rect|width=20|height=14|x=2|y=3|rx=2", "line|x1=8|x2=16|y1=21|y2=21", "line|x1=12|x2=12|y1=17|y2=21"]);
export const IconZap = svg(["path|d=M15.914 4a1.5 1.5 0 00-2.474-1.561l-9 9A1.5 1.5 0 005.5 14h4.002a.5.5 0 01.471.666L8.086 20a1.5 1.5 0 002.475 1.56l9-9A1.5 1.5 0 0018.5 10h-3.997a.5.5 0 01-.472-.667z"]);
export const IconCircleAlert = svg(["circle|cx=12|cy=12|r=10", "line|x1=12|x2=12|y1=8|y2=12", "line|x1=12|x2=12.01|y1=16|y2=16"]);
export const IconTriangleAlert = svg(["path|d=m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3", "path|d=M12 9v4", "path|d=M12 17h.01"]);
export const IconCheck = svg(["path|d=M20 6 9 17l-5-5"]);
export const IconCircleCheck = svg(["circle|cx=12|cy=12|r=10", "path|d=m16 9-5.5 5.5L8 12"]);
export const IconInfo = svg(["circle|cx=12|cy=12|r=10", "path|d=M12 16v-4", "path|d=M12 8h.01"]);
export const IconExternalLink = svg(["path|d=M15 3h6v6", "path|d=M10 14 21 3", "path|d=M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"]);
export const IconPlug = svg(["path|d=M12 22v-5", "path|d=M15 8V2", "path|d=M17 8a1 1 0 0 1 1 1v4a4 4 0 0 1-4 4h-4a4 4 0 0 1-4-4V9a1 1 0 0 1 1-1z", "path|d=M9 8V2"]);
export const IconUnplug = svg(["path|d=m19 5 3-3", "path|d=m2 22 3-3", "path|d=M6.3 20.3a2.4 2.4 0 0 0 3.4 0L12 18l-6-6-2.3 2.3a2.4 2.4 0 0 0 0 3.4Z", "path|d=M7.5 13.5 10 11", "path|d=M10.5 16.5 13 14", "path|d=m12 6 6 6 2.3-2.3a2.4 2.4 0 0 0 0-3.4l-2.6-2.6a2.4 2.4 0 0 0-3.4 0Z"]);
export const IconRefreshCw = svg(["path|d=M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8", "path|d=M21 3v5h-5", "path|d=M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16", "path|d=M8 16H3v5"]);
export const IconLayoutGrid = svg(["rect|width=7|height=7|x=3|y=3|rx=1", "rect|width=7|height=7|x=14|y=3|rx=1", "rect|width=7|height=7|x=14|y=14|rx=1", "rect|width=7|height=7|x=3|y=14|rx=1"]);
export const IconList = svg(["path|d=M3 5h.01", "path|d=M3 12h.01", "path|d=M3 19h.01", "path|d=M8 5h13", "path|d=M8 12h13", "path|d=M8 19h13"]);
export const IconClock = svg(["circle|cx=12|cy=12|r=10", "path|d=M12 6v6l4 2"]);
export const IconKeyboard = svg(["path|d=M10 8h.01", "path|d=M12 12h.01", "path|d=M14 8h.01", "path|d=M16 12h.01", "path|d=M18 8h.01", "path|d=M6 8h.01", "path|d=M7 16h10", "path|d=M8 12h.01", "rect|width=20|height=16|x=2|y=4|rx=2"]);
export const IconType = svg(["path|d=M12 4v16", "path|d=M4 7V5a1 1 0 0 1 1-1h14a1 1 0 0 1 1 1v2", "path|d=M9 20h6"]);
export const IconPalette = svg(["path|d=M12 22a1 1 0 0 1 0-20 10 9 0 0 1 10 9 5 5 0 0 1-5 5h-2.25a1.75 1.75 0 0 0-1.4 2.8l.3.4a1.75 1.75 0 0 1-1.4 2.8z", "circle|cx=13.5|cy=6.5|r=.5|fill=currentColor", "circle|cx=17.5|cy=10.5|r=.5|fill=currentColor", "circle|cx=6.5|cy=12.5|r=.5|fill=currentColor", "circle|cx=8.5|cy=7.5|r=.5|fill=currentColor"]);
export const IconScrollText = svg(["path|d=M15 12h-5", "path|d=M15 8h-5", "path|d=M19 17V5a2 2 0 0 0-2-2H4", "path|d=M8 21h12a2 2 0 0 0 2-2v-1a1 1 0 0 0-1-1H11a1 1 0 0 0-1 1v1a2 2 0 1 1-4 0V5a2 2 0 1 0-4 0v2a1 1 0 0 0 1 1h3"]);
export const IconEye = svg(["path|d=M2.062 12.348a1 1 0 0 1 0-.696 10.75 10.75 0 0 1 19.876 0 1 1 0 0 1 0 .696 10.75 10.75 0 0 1-19.876 0", "circle|cx=12|cy=12|r=3"]);
export const IconEyeOff = svg(["path|d=M10.733 5.076a10.744 10.744 0 0 1 11.205 6.575 1 1 0 0 1 0 .696 10.747 10.747 0 0 1-1.444 2.49", "path|d=M14.084 14.158a3 3 0 0 1-4.242-4.242", "path|d=M17.479 17.499a10.75 10.75 0 0 1-15.417-5.151 1 1 0 0 1 0-.696 10.75 10.75 0 0 1 4.446-5.143", "path|d=m2 2 20 20"]);
export const IconZoomIn = svg(["circle|cx=11|cy=11|r=8", "line|x1=21|x2=16.65|y1=21|y2=16.65", "line|x1=11|x2=11|y1=8|y2=14", "line|x1=8|x2=14|y1=11|y2=11"]);
export const IconZoomOut = svg(["circle|cx=11|cy=11|r=8", "line|x1=21|x2=16.65|y1=21|y2=16.65", "line|x1=8|x2=14|y1=11|y2=11"]);
export const IconHistory = svg(["path|d=M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8", "path|d=M3 3v5h5", "path|d=M12 7v5l4 2"]);
export const IconArrowRight = svg(["path|d=M5 12h14", "path|d=m12 5 7 7-7 7"]);
export const IconCornerDownLeft = svg(["path|d=M20 4v7a4 4 0 0 1-4 4H4", "path|d=m9 10-5 5 5 5"]);
export const IconLoaderCircle = svg(["path|d=M21 12a9 9 0 1 1-6.219-8.56"]);
export const IconShieldAlert = svg(["path|d=M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z", "path|d=M12 8v4", "path|d=M12 16h.01"]);
export const IconFingerprint = svg(["path|d=M12 10a2 2 0 0 0-2 2c0 1.02-.1 2.51-.26 4", "path|d=M14 13.12c0 2.38 0 6.38-1 8.88", "path|d=M17.29 21.02c.12-.6.43-2.3.5-3.02", "path|d=M2 12a10 10 0 0 1 18-6", "path|d=M2 16h.01", "path|d=M21.8 16c.2-2 .131-5.354 0-6", "path|d=M5 19.5C5.5 18 6 15 6 12a6 6 0 0 1 .34-2", "path|d=M8.65 22c.21-.66.45-1.32.57-2", "path|d=M9 6.8a6 6 0 0 1 9 5.2v2"]);
export const IconUser = svg(["path|d=M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2", "circle|cx=12|cy=7|r=4"]);
export const IconGripVertical = svg(["circle|cx=9|cy=12|r=1", "circle|cx=9|cy=5|r=1", "circle|cx=9|cy=19|r=1", "circle|cx=15|cy=12|r=1", "circle|cx=15|cy=5|r=1", "circle|cx=15|cy=19|r=1"]);
export const IconClipboardCopy = svg(["rect|width=8|height=4|x=8|y=2|rx=1|ry=1", "path|d=M8 4H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2", "path|d=M16 4h2a2 2 0 0 1 2 2v4", "path|d=M21 14H11", "path|d=m15 10-4 4 4 4"]);
export const IconSlidersHorizontal = svg(["path|d=M10 5H3", "path|d=M12 19H3", "path|d=M14 3v4", "path|d=M16 17v4", "path|d=M21 12h-9", "path|d=M21 19h-5", "path|d=M21 5h-7", "path|d=M8 10v4", "path|d=M8 12H3"]);
export const IconCpu = svg(["path|d=M12 20v2", "path|d=M12 2v2", "path|d=M17 20v2", "path|d=M17 2v2", "path|d=M2 12h2", "path|d=M2 17h2", "path|d=M2 7h2", "path|d=M20 12h2", "path|d=M20 17h2", "path|d=M20 7h2", "path|d=M7 20v2", "path|d=M7 2v2", "rect|x=4|y=4|width=16|height=16|rx=2", "rect|x=8|y=8|width=8|height=8|rx=1"]);
export const IconLink2 = svg(["path|d=M9 17H7A5 5 0 0 1 7 7h2", "path|d=M15 7h2a5 5 0 1 1 0 10h-2", "line|x1=8|x2=16|y1=12|y2=12"]);
export const IconArrowUpRight = svg(["path|d=M7 7h10v10", "path|d=M7 17 17 7"]);
export const IconSidebar = svg(["rect|width=18|height=18|x=3|y=3|rx=2", "path|d=M9 3v18"]);
export const IconTextCursorInput = svg(["path|d=M12 20h-1a2 2 0 0 1-2-2 2 2 0 0 1-2 2H6", "path|d=M13 8h7a2 2 0 0 1 2 2v4a2 2 0 0 1-2 2h-7", "path|d=M5 16H4a2 2 0 0 1-2-2v-4a2 2 0 0 1 2-2h1", "path|d=M6 4h1a2 2 0 0 1 2 2 2 2 0 0 1 2-2h1", "path|d=M9 6v12"]);
