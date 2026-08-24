import { Navigate, createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/_workspace/settings/appearance")({
  component: AppearanceSettingsPage,
});

function AppearanceSettingsPage() {
  return <Navigate to="/settings/calendar" replace />;
}
