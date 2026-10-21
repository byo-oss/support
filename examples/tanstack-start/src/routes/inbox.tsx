import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { SupportInbox } from "@byo-oss/support/react";
import { listAgents } from "../lib/agents";
import { authClient } from "../lib/auth-client";

export const Route = createFileRoute("/inbox")({
  // Not a staff member: getFullOrganization throws, so show the plain message.
  loader: async () => {
    try {
      return { agents: await listAgents() };
    } catch {
      return { agents: null };
    }
  },
  component: Inbox,
});

// The agent page: the endpoints behind SupportInbox check `support` actions
// in the staff organization, so a customer who finds this URL gets 403s.
function Inbox() {
  const navigate = useNavigate();
  const { agents } = Route.useLoaderData();
  const { data: session, isPending } = authClient.useSession();
  if (isPending) return null;
  if (!session) return <p>Sign in as an agent to see the queue.</p>;
  if (!agents) return <p role="alert">This page is for support staff.</p>;

  return (
    <div style={{ display: "grid", gap: 12 }}>
      <h1>Inbox</h1>
      <SupportInbox
        client={authClient}
        agents={agents}
        onNavigate={(href) => navigate({ href })}
      />
    </div>
  );
}
