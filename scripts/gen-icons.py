import re, sys, os
src = sys.argv[1]; out = sys.argv[2]
names = sys.argv[3].split()
def pascal(n): return ''.join(p.capitalize() for p in re.split(r'[-]', n))
lines = ['// Generated from lucide-static 1.47.0 (ISC License, Copyright (c) 2026 Lucide Icons and Contributors).',
         '// Bundled as inline SVG so no icon is ever fetched at run time. Regenerate with scripts/gen-icons.py',
         '// (list in src/components/ui/icons.list) rather than hand-editing. See NOTICE for the license text.',
         '',
         'import type { SVGProps } from "react";',
         '',
         'export type IconProps = Omit<SVGProps<SVGSVGElement>, "children"> & { size?: number };',
         '',
         'function svg(body: string[]) {',
         '  return function Icon({ size = 16, ...rest }: IconProps) {',
         '    return (',
         '      <svg',
         '        xmlns="http://www.w3.org/2000/svg"',
         '        width={size}',
         '        height={size}',
         '        viewBox="0 0 24 24"',
         '        fill="none"',
         '        stroke="currentColor"',
         '        strokeWidth={1.75}',
         '        strokeLinecap="round"',
         '        strokeLinejoin="round"',
         '        aria-hidden="true"',
         '        focusable="false"',
         '        {...rest}',
         '      >',
         '        {body.map((d, i) => (',
         '          // Fixed geometry from the generated list; position is the identity.',
         '          <Shape key={i} d={d} />',
         '        ))}',
         '      </svg>',
         '    );',
         '  };',
         '}',
         '',
         '/** Shapes are encoded as `tag|attr=value|attr=value` so only path/circle/rect/line/polyline/ellipse are possible. */',
         'function Shape({ d }: { d: string }) {',
         '  const [tag, ...pairs] = d.split("|");',
         '  const attrs = Object.fromEntries(pairs.map((p) => { const i = p.indexOf("="); return [p.slice(0, i), p.slice(i + 1)]; }));',
         '  switch (tag) {',
         '    case "path": return <path d={attrs.d} />;',
         '    case "circle": return <circle cx={attrs.cx} cy={attrs.cy} r={attrs.r} />;',
         '    case "rect": return <rect x={attrs.x} y={attrs.y} width={attrs.width} height={attrs.height} rx={attrs.rx} ry={attrs.ry} />;',
         '    case "line": return <line x1={attrs.x1} y1={attrs.y1} x2={attrs.x2} y2={attrs.y2} />;',
         '    case "polyline": return <polyline points={attrs.points} />;',
         '    case "polygon": return <polygon points={attrs.points} />;',
         '    case "ellipse": return <ellipse cx={attrs.cx} cy={attrs.cy} rx={attrs.rx} ry={attrs.ry} />;',
         '    default: return null;',
         '  }',
         '}',
         '']
for n in names:
    text = open(os.path.join(src, n + '.svg')).read()
    shapes = []
    for m in re.finditer(r'<(path|circle|rect|line|polyline|polygon|ellipse)\s([^>]*?)/?>', text):
        tag, attrs = m.group(1), m.group(2)
        pairs = re.findall(r'([a-z0-9-]+)="([^"]*)"', attrs)
        shapes.append(tag + ''.join('|%s=%s' % (k, v) for k, v in pairs))
    lines.append('export const Icon%s = svg(%s);' % (pascal(n), repr(shapes).replace("'", '"')))
open(out, 'w').write('\n'.join(lines) + '\n')
