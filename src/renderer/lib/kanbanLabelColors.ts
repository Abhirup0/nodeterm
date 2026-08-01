import type { KanbanLabelColor } from '@shared/types'
import { KANBAN_LABEL_COLORS, labelColor } from './kanban'

// The Notion label palette, rendered for nodeterm's dark UI: a muted background + a lighter
// same-hue text, so a chip reads clearly on the black canvas and the dark board. The NAME set is
// the source of truth (`KANBAN_LABEL_COLORS` in kanban.ts); this only maps each to CSS + a label.

interface LabelSwatch {
  /** Human label for the color picker row ("Brown", "Orange", …). */
  title: string
  /** Chip background. */
  bg: string
  /** Chip text. */
  fg: string
}

const SWATCHES: Record<KanbanLabelColor, LabelSwatch> = {
  default: { title: 'Default', bg: 'rgba(255,255,255,0.10)', fg: 'rgba(255,255,255,0.88)' },
  gray: { title: 'Gray', bg: '#5f6360', fg: '#e7e9e8' },
  brown: { title: 'Brown', bg: '#61452b', fg: '#e8d0b8' },
  orange: { title: 'Orange', bg: '#6b3f1d', fg: '#f0c19a' },
  yellow: { title: 'Yellow', bg: '#63521f', fg: '#e7d089' },
  green: { title: 'Green', bg: '#26503b', fg: '#9fd8b8' },
  blue: { title: 'Blue', bg: '#22496b', fg: '#a6cdf0' },
  purple: { title: 'Purple', bg: '#463063', fg: '#cbb0e8' },
  pink: { title: 'Pink', bg: '#5e2f47', fg: '#eeb0cf' },
  red: { title: 'Red', bg: '#642b28', fg: '#f0a9a2' }
}

/** Chip style for a label color (garbage → 'default'). */
export function labelSwatch(color: unknown): LabelSwatch {
  return SWATCHES[labelColor(color)]
}

/** The palette in picker order, each with its name + swatch. */
export const LABEL_COLOR_OPTIONS: Array<{ color: KanbanLabelColor } & LabelSwatch> =
  KANBAN_LABEL_COLORS.map((color) => ({ color, ...SWATCHES[color] }))
