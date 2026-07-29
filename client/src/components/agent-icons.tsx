import type { ReactNode, SVGProps } from 'react'
import { cn } from '@/lib/utils'

// Monochrome marks for the tools listed on the Agents page. They are simplified
// single-colour interpretations of each tool's own logo (the colour originals
// live in repo-assets/agents), drawn on the same 24px grid and 1.75 stroke as
// the lucide icons used everywhere else so they inherit weight and theme from
// `currentColor`. Tools whose logo is itself a letterform (Aider, Roo Code,
// Kilo Code) keep that letter rather than gaining an invented symbol.

function Mark({ children, ...props }: SVGProps<SVGSVGElement> & { children: ReactNode }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.75}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      {...props}
    >
      {children}
    </svg>
  )
}

const hexagon = 'M12 2.6 20.6 7.3v9.4L12 21.4 3.4 16.7V7.3Z'

const marks: Record<string, ReactNode> = {
  // Anthropic's "A\" glyph.
  claude: (
    <>
      <path d="M4 19 9.4 5.6 14.8 19" />
      <path d="M6.4 14.6h6" />
      <path d="m16.8 5.6 4.2 13.4" />
    </>
  ),
  // OpenAI's six-lobed knot, reduced to three crossing lozenges.
  codex: (
    <>
      <rect x="3" y="8.25" width="18" height="7.5" rx="3.75" />
      <rect x="3" y="8.25" width="18" height="7.5" rx="3.75" transform="rotate(60 12 12)" />
      <rect x="3" y="8.25" width="18" height="7.5" rx="3.75" transform="rotate(-60 12 12)" />
    </>
  ),
  // Cline's robot head.
  cline: (
    <>
      <circle cx="12" cy="3.9" r="1.4" />
      <path d="M12 5.3V7" />
      <rect x="4.2" y="7" width="15.6" height="13" rx="4.5" />
      <path d="M9.6 12.4v2.6" />
      <path d="M14.4 12.4v2.6" />
    </>
  ),
  // Continue's hexagon with the chevron split out of its right vertex.
  continue: (
    <>
      <path d="M9.4 3.6 16.2 7.7v8.6l-6.8 4.1-6.8-4.1V7.7Z" />
      <path d="m18.4 8.2 3.4 3.8-3.4 3.8" />
    </>
  ),
  // Aider's blocky lowercase "a".
  aider: (
    <>
      <circle cx="10.4" cy="14.6" r="4" />
      <path d="M14.4 10.4v8.2" />
    </>
  ),
  // OpenCode's hexagon with its inner chord.
  opencode: (
    <>
      <path d={hexagon} />
      <path d="M8 15.4 16 8.6" />
    </>
  ),
  // Block's nine-square mark.
  goose: (
    <g fill="currentColor" stroke="none">
      {[4, 10, 16].flatMap(y => [4, 10, 16].map(x => (
        <rect key={`${x}-${y}`} x={x} y={y} width="4.2" height="4.2" rx="1.2" />
      )))}
    </g>
  ),
  // Qwen's pinwheel of interlocking arrows.
  qwen: (
    <>
      <path d="M12 12V3.6a8.4 8.4 0 0 1 7.3 4.2Z" />
      <path d="M12 12V3.6a8.4 8.4 0 0 1 7.3 4.2Z" transform="rotate(120 12 12)" />
      <path d="M12 12V3.6a8.4 8.4 0 0 1 7.3 4.2Z" transform="rotate(240 12 12)" />
    </>
  ),
  // Roo Code's brushed "R".
  roo: (
    <>
      <path d="M7.6 20V4.4h5.3a4.3 4.3 0 0 1 0 8.6H7.6" />
      <path d="m12.8 13 5.6 7" />
    </>
  ),
  // Kilo Code's blocky "K".
  kilo: (
    <>
      <path d="M8 4.4V20" />
      <path d="M18 4.4 9.4 12.1 18 20" />
    </>
  ),
  // Crush's shooting star.
  crush: (
    <>
      <path d="M14.2 4.2 15.5 7.8 19.3 8.9 16.3 10.3 17.4 14 14.2 11.8 11 14 12.1 10.3 9.1 8.9 12.9 7.8Z" />
      <path d="M10.4 14.1 4.2 20.3" />
      <path d="M14 17.6 11.2 20.4" />
    </>
  ),
  // Cursor's cube.
  cursor: (
    <>
      <path d={hexagon} />
      <path d="M12 21.4V12" />
      <path d="M12 12 20.6 7.3" />
      <path d="M12 12 3.4 7.3" />
    </>
  ),
  // Any other OpenAI-compatible client: a terminal window.
  generic: (
    <>
      <rect x="2.8" y="4.3" width="18.4" height="15.4" rx="3.6" />
      <path d="M7.6 10.4 10.1 12.9 7.6 15.4" />
      <path d="M12.6 15.4h4.4" />
    </>
  ),
}

// Letters for a tool with no mark yet, so a catalog entry added later still
// gets a badge of the same size and weight instead of an empty tile.
function lettermark(name: string): string {
  return name.replace(/[^A-Za-z0-9]/g, '').slice(0, 2).toUpperCase()
}

export function AgentIcon({
  id,
  name,
  className,
}: {
  id: string
  name: string
  className?: string
}) {
  const mark = marks[id]
  return (
    <span
      aria-hidden="true"
      className={cn(
        'flex size-9 shrink-0 items-center justify-center rounded-xl bg-muted text-foreground',
        className,
      )}
    >
      {mark
        ? <Mark className="size-5">{mark}</Mark>
        : <span className="font-mono text-[11px] font-semibold">{lettermark(name)}</span>}
    </span>
  )
}
