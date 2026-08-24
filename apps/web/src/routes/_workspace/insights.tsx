import { createFileRoute } from "@tanstack/react-router";

import { InsightsDashboard } from "@/components/insights/insights-dashboard";

export const Route = createFileRoute("/_workspace/insights")({
  component: InsightsRoute,
});

function InsightsRoute() {
  return <InsightsDashboard />;
}
