import type { TerminalScheme } from "./schemes";

/**
 * A small picture of a scheme: a prompt, `ls` output and the cursor in the scheme's own colours,
 * so a scheme can be chosen by sight. It is an image of the palette (third-party palettes keep
 * their published colours, some below 3:1), so it is drawn as SVG and hidden from assistive
 * technology; the card around it carries the scheme's name.
 */
export function SchemePreview({ scheme }: { scheme: TerminalScheme }) {
  const prompt = (y: number) => (
    <>
      <tspan x="8" y={y} fill={scheme.green} fontWeight="700">
        deploy@api
      </tspan>
      <tspan fill={scheme.foreground}>:</tspan>
      <tspan fill={scheme.blue} fontWeight="700">
        ~
      </tspan>
      <tspan fill={scheme.foreground}>$ </tspan>
    </>
  );
  return (
    <svg className="scheme-preview" viewBox="0 0 176 54" aria-hidden="true" focusable="false" style={{ background: scheme.background }}>
      <text fontFamily="var(--font-mono)" fontSize="9.5">
        {prompt(15)}
        <tspan fill={scheme.foreground}>ls</tspan>
        <tspan x="8" y="29" fill={scheme.blue} fontWeight="700">
          app
        </tspan>
        <tspan fill={scheme.foreground}> </tspan>
        <tspan fill={scheme.cyan}>logs</tspan>
        <tspan fill={scheme.foreground}> </tspan>
        <tspan fill={scheme.green}>run.sh</tspan>
        <tspan fill={scheme.foreground}> </tspan>
        <tspan fill={scheme.red}>db.tgz</tspan>
        <tspan fill={scheme.foreground}> </tspan>
        <tspan fill={scheme.yellow}>tmp</tspan>
        {prompt(43)}
      </text>
      <rect x="92" y="35" width="6" height="11" rx="1" fill={scheme.cursor} />
    </svg>
  );
}
