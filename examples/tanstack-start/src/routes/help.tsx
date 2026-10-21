import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { SupportWidget } from "@byo-oss/support/react";
import { authClient } from "../lib/auth-client";

export const Route = createFileRoute("/help")({ component: Help });

// The customer page: any signed-in user can open and follow their own tickets.
function Help() {
  const navigate = useNavigate();
  const { data: session, isPending } = authClient.useSession();
  if (isPending) return null;
  if (!session) return <p>Sign in to ask for help.</p>;

  return (
    <div style={{ display: "grid", gap: 12 }}>
      <h1>Help</h1>
      {/* `onNavigate` receives in-app links, such as a ticket's `ticketPath` */}
      <SupportWidget
        client={authClient}
        onNavigate={(href) => navigate({ href })}
      />
    </div>
  );
}
