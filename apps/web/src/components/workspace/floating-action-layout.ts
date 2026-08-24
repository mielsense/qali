/** Declarative layout contract for the centered calendar dock and independent
 * edge assistant. Both placements are CSS-stable and need no resize observer. */
export const FLOATING_ACTION_CONTRACT = {
  panel: {
    bottomPx: 12,
    alignment: "calendar-content-center",
    contextualOnly: true,
  },
  assistant: {
    placement: "layout-pane",
    pushesContent: true,
  },
  motion: {
    reduced: {
      initial: { opacity: 0 },
      animate: { opacity: 1 },
      exit: { opacity: 0 },
    },
  },
} as const;
