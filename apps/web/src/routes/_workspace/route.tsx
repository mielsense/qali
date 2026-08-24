import { Navigate, createFileRoute } from "@tanstack/react-router";
import { Authenticated, AuthLoading, Unauthenticated } from "convex/react";

import { WorkspaceContent } from "@/components/workspace/workspace-layout";
import { WorkspaceSkeleton } from "@/components/workspace/workspace-skeleton";

export const Route = createFileRoute("/_workspace")({
  component: WorkspaceLayout,
});

function WorkspaceLayout() {
  return (
    <>
      <Authenticated>
        <WorkspaceContent />
      </Authenticated>
      <Unauthenticated>
        <Navigate to="/login" />
      </Unauthenticated>
      <AuthLoading>
        <WorkspaceSkeleton />
      </AuthLoading>
    </>
  );
}
