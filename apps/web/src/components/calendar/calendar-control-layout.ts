const CALENDAR_PICKER_HEADING_HEIGHT = 24;
const CALENDAR_PICKER_ROW_HEIGHT = 32;
const CALENDAR_PICKER_MAX_PANEL_HEIGHT = 260;
const CALENDAR_PICKER_PANEL_RADIUS = 14;

/** Intrinsic selector body geometry remains separate from the viewport cap so
 * GooDropdown can hug short lists and scroll only genuinely overflowing ones. */
export function calendarPickerPanelMetrics({
  calendarCount,
  colorPaletteOpen,
}: {
  calendarCount: number;
  colorPaletteOpen: boolean;
}): Readonly<{
  contentHeight: number;
  maxHeight: number;
  headingHeight: number;
  panelRadius: number;
}> {
  return {
    contentHeight:
      CALENDAR_PICKER_HEADING_HEIGHT +
      calendarCount * CALENDAR_PICKER_ROW_HEIGHT +
      (colorPaletteOpen ? CALENDAR_PICKER_ROW_HEIGHT : 0),
    maxHeight: CALENDAR_PICKER_MAX_PANEL_HEIGHT,
    headingHeight: CALENDAR_PICKER_HEADING_HEIGHT,
    panelRadius: CALENDAR_PICKER_PANEL_RADIUS,
  };
}
