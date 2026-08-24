import { Navigate, createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/_workspace/settings/time-zones")({
  component: LegacyTimeZonesRedirect,
});

function LegacyTimeZonesRedirect() {
  return <Navigate to="/settings/calendar" replace />;
}
