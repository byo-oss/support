import { createFileRoute, useNavigate, useParams } from "@tanstack/react-router";
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
//
// This layout renders the inbox for both `/inbox` and `/inbox/$id` (the child route in
// `inbox.$id.tsx` only declares the param), so the inbox stays mounted as the URL changes.
function Inbox() {
  const navigate = useNavigate();
  // `/inbox/<id>` opens that ticket, which is where notification links point
  const { id } = useParams({ strict: false });
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
        ticketId={id ?? null}
        onTicketChange={(next) =>
          navigate(next ? { to: "/inbox/$id", params: { id: next } } : { to: "/inbox" })
        }
        onNavigate={(href) => navigate({ href })}
      />
    </div>
  );
}
