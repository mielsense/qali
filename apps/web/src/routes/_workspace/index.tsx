import { createFileRoute } from "@tanstack/react-router";

import { CalendarWeekView } from "@/components/calendar/calendar";

export const Route = createFileRoute("/_workspace/")({
  component: HomeComponent,
});

function HomeComponent() {
  return <CalendarWeekView />;
}
