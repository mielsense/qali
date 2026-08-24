import { Navigate, createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/_workspace/settings/")({
  component: SettingsIndexRedirect,
});

function SettingsIndexRedirect() {
  return <Navigate to="/settings/calendar" replace />;
}
