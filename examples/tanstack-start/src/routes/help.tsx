import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { SupportWidget } from "@byo-oss/support/react";
import { authClient } from "../lib/auth-client";

type HelpSearch = { ticket?: string };

export const Route = createFileRoute("/help")({
  // `?ticket=<id>` comes from the links in support mail (`ticketPath`)
  validateSearch: (search: Record<string, unknown>): HelpSearch => {
    const { ticket } = search;
    // the router parses `?ticket=12` as a number, so accept both
    return typeof ticket === "string" || typeof ticket === "number"
      ? { ticket: String(ticket) }
      : {};
  },
  component: Help,
});

// The customer page: any signed-in user can open and follow their own tickets.
function Help() {
  const navigate = useNavigate();
  const { ticket } = Route.useSearch();
  const { data: session, isPending } = authClient.useSession();
  if (isPending) return null;
  if (!session) return <p>Sign in to ask for help.</p>;

  return (
    <div style={{ display: "grid", gap: 12 }}>
      <h1>Help</h1>
      {/* inline: the panel fills the page, with no launcher. `ticketId` opens a linked
          ticket and `onTicketChange` keeps `?ticket=` in step when the user opens a ticket
          or goes Back; `onNavigate` receives in-app links */}
      <SupportWidget
        client={authClient}
        variant="inline"
        ticketId={ticket ?? null}
        onTicketChange={(next) =>
          navigate({ to: "/help", search: next ? { ticket: next } : {} })
        }
        onNavigate={(href) => navigate({ href })}
      />
    </div>
  );
}
